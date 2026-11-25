/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import { AdminConfig } from './admin.types';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

// 是否在为 Cloudflare 构建（wrangler / Workers Builds 都会注入 BUILD_TARGET）
const IS_CLOUDFLARE_BUILD =
  process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';

// storage type 常量: 'localstorage' | 'redis' | 'upstash' | 'kvrocks' | 'd1'，默认 'localstorage'
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | 'd1'
    | undefined) || 'localstorage';

// 创建存储实例
//
// 注意：除 d1 / upstash 外，其余实现都依赖 Node 原生 TCP 栈（node:net / node:tls），
// 在 Workers 上不可用。这里全部改成 require 动态加载，避免把 node-redis 打进
// Worker bundle；CF 构建下若误配 redis/kvrocks 会直接抛出可读错误。
function createStorage(): IStorage {
  switch (STORAGE_TYPE) {
    case 'redis': {
      if (IS_CLOUDFLARE_BUILD) {
        throw new Error(
          'Cloudflare 部署不支持 Node Redis（TCP），请使用 D1 或 Upstash'
        );
      }
      const { RedisStorage } = require('./redis.db');
      return new RedisStorage();
    }
    case 'upstash': {
      const { UpstashRedisStorage } = require('./upstash.db');
      return new UpstashRedisStorage();
    }
    case 'kvrocks': {
      if (IS_CLOUDFLARE_BUILD) {
        throw new Error(
          'Cloudflare 部署不支持 Kvrocks（TCP），请使用 D1 或 Upstash'
        );
      }
      const { KvrocksStorage } = require('./kvrocks.db');
      return new KvrocksStorage();
    }
    case 'd1': {
      if (typeof window !== 'undefined') {
        throw new Error('D1Storage 只能在服务端使用');
      }
      const { D1Storage } = require('./d1.db');
      return new D1Storage(getD1Adapter());
    }
    case 'localstorage':
    default:
      return null as unknown as IStorage;
  }
}

/**
 * 获取 D1 适配器
 * - Cloudflare：懒加载 getCloudflareContext().env.DB
 * - 本地开发：better-sqlite3（SQLite 文件，SQL 与 D1 完全兼容）
 */
function getD1Adapter(): any {
  const { CloudflareD1Adapter, SQLiteAdapter } = require('./d1-adapter');

  if (IS_CLOUDFLARE_BUILD) {
    let cachedAdapter: any = null;

    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (!cachedAdapter) {
            const { getCloudflareContext } = require('@opennextjs/cloudflare');
            const { env } = getCloudflareContext();
            if (!env?.DB) {
              throw new Error(
                '未找到 D1 binding「DB」，请检查 wrangler.toml 的 [[d1_databases]]'
              );
            }
            console.log('Using Cloudflare D1 database');
            cachedAdapter = new CloudflareD1Adapter(env.DB);
          }
          const value = cachedAdapter[prop];
          // 方法需要绑定 this，否则 D1Storage 里 this.db.prepare 会丢上下文
          return typeof value === 'function' ? value.bind(cachedAdapter) : value;
        },
      }
    );
  }

  // 本地开发
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');
  const dbPath =
    process.env.SQLITE_DB_PATH ||
    path.join(process.cwd(), '.data', 'lunatv.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return new SQLiteAdapter(db);
}

// 单例存储实例
let storageInstance: IStorage | null = null;

function getStorage(): IStorage {
  if (!storageInstance) {
    storageInstance = createStorage();
  }
  return storageInstance;
}

// 工具函数：生成存储key
export function generateStorageKey(source: string, id: string): string {
  return `${source}+${id}`;
}

// 导出便捷方法
export class DbManager {
  private storage: IStorage;
  private migrationPromise: Promise<void> | null = null;

  constructor() {
    this.storage = getStorage();
    // 启动时自动触发数据迁移（异步，不阻塞构造）
    if (this.storage && typeof this.storage.migrateData === 'function') {
      this.migrationPromise = this.storage.migrateData().then(async () => {
        // 数据结构迁移完成后，执行密码哈希迁移
        if (typeof this.storage.migratePasswords === 'function') {
          await this.storage.migratePasswords();
        }
      }).catch((err) => {
        console.error('数据迁移异常:', err);
      });
    }
  }

  /** 等待迁移完成（内部方法，首次调用后 migrationPromise 会被置空） */
  private async ensureMigrated(): Promise<void> {
    if (this.migrationPromise) {
      await this.migrationPromise;
      this.migrationPromise = null;
    }
  }

  // 播放记录相关方法
  async getPlayRecord(
    userName: string,
    source: string,
    id: string
  ): Promise<PlayRecord | null> {
    const key = generateStorageKey(source, id);
    return this.storage.getPlayRecord(userName, key);
  }

  async savePlayRecord(
    userName: string,
    source: string,
    id: string,
    record: PlayRecord
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.setPlayRecord(userName, key, record);
  }

  async getAllPlayRecords(userName: string): Promise<{
    [key: string]: PlayRecord;
  }> {
    await this.ensureMigrated();
    return this.storage.getAllPlayRecords(userName);
  }

  async deletePlayRecord(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.deletePlayRecord(userName, key);
  }

  async deleteAllPlayRecords(userName: string): Promise<void> {
    await this.storage.deleteAllPlayRecords(userName);
  }

  // 收藏相关方法
  async getFavorite(
    userName: string,
    source: string,
    id: string
  ): Promise<Favorite | null> {
    const key = generateStorageKey(source, id);
    return this.storage.getFavorite(userName, key);
  }

  async saveFavorite(
    userName: string,
    source: string,
    id: string,
    favorite: Favorite
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.setFavorite(userName, key, favorite);
  }

  async getAllFavorites(
    userName: string
  ): Promise<{ [key: string]: Favorite }> {
    await this.ensureMigrated();
    return this.storage.getAllFavorites(userName);
  }

  async deleteFavorite(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.deleteFavorite(userName, key);
  }

  async deleteAllFavorites(userName: string): Promise<void> {
    await this.storage.deleteAllFavorites(userName);
  }

  async isFavorited(
    userName: string,
    source: string,
    id: string
  ): Promise<boolean> {
    const favorite = await this.getFavorite(userName, source, id);
    return favorite !== null;
  }

  // ---------- 用户相关 ----------
  async registerUser(userName: string, password: string): Promise<void> {
    await this.storage.registerUser(userName, password);
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return this.storage.verifyUser(userName, password);
  }

  // 检查用户是否已存在
  async checkUserExist(userName: string): Promise<boolean> {
    return this.storage.checkUserExist(userName);
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    await this.storage.changePassword(userName, newPassword);
  }

  async deleteUser(userName: string): Promise<void> {
    await this.storage.deleteUser(userName);
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    return this.storage.getSearchHistory(userName);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    await this.storage.addSearchHistory(userName, keyword);
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    await this.storage.deleteSearchHistory(userName, keyword);
  }

  // 获取全部用户名
  async getAllUsers(): Promise<string[]> {
    if (typeof (this.storage as any).getAllUsers === 'function') {
      return (this.storage as any).getAllUsers();
    }
    return [];
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    if (typeof (this.storage as any).getAdminConfig === 'function') {
      return (this.storage as any).getAdminConfig();
    }
    return null;
  }

  async saveAdminConfig(config: AdminConfig): Promise<void> {
    if (typeof (this.storage as any).setAdminConfig === 'function') {
      await (this.storage as any).setAdminConfig(config);
    }
  }

  // ---------- 跳过片头片尾配置 ----------
  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    if (typeof (this.storage as any).getSkipConfig === 'function') {
      return (this.storage as any).getSkipConfig(userName, source, id);
    }
    return null;
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    if (typeof (this.storage as any).setSkipConfig === 'function') {
      await (this.storage as any).setSkipConfig(userName, source, id, config);
    }
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    if (typeof (this.storage as any).deleteSkipConfig === 'function') {
      await (this.storage as any).deleteSkipConfig(userName, source, id);
    }
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    if (typeof (this.storage as any).getAllSkipConfigs === 'function') {
      return (this.storage as any).getAllSkipConfigs(userName);
    }
    return {};
  }

  // ---------- 数据清理 ----------
  async clearAllData(): Promise<void> {
    if (typeof (this.storage as any).clearAllData === 'function') {
      await (this.storage as any).clearAllData();
    } else {
      throw new Error('存储类型不支持清空数据操作');
    }
  }
}

// 导出默认实例
export const db = new DbManager();
