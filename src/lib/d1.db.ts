/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

/**
 * Cloudflare D1 Storage 实现（LunaTV IStorage 接口）
 *
 * - 生产：Cloudflare D1（wrangler.toml 中 binding = "DB"）
 * - 本地：better-sqlite3（同一个 SQL 方言，便于本地开发调试）
 *
 * 设计要点：
 * 1. 所有 key 统一为 `source+id` 字符串，与 redis / upstash 版本保持一致；
 * 2. 写操作尽量用 `INSERT ... ON CONFLICT DO UPDATE`，保证幂等；
 * 3. 多表写用 batch（D1 batch 在同一个事务内执行）；
 * 4. 不实现 migrateData / migratePasswords —— D1 是新建库，无历史扁平 key。
 */

import { AdminConfig } from './admin.types';
import { DatabaseAdapter, D1PreparedStatement } from './d1-adapter';
import { hashPassword, isHashed, verifyPassword } from './password';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

const SEARCH_HISTORY_LIMIT = 20;

function rowToPlayRecord(row: any): PlayRecord {
  return {
    title: String(row.title ?? ''),
    source_name: String(row.source_name ?? ''),
    cover: String(row.cover ?? ''),
    year: String(row.year ?? ''),
    index: Number(row.episode_index ?? 0),
    total_episodes: Number(row.total_episodes ?? 0),
    play_time: Number(row.play_time ?? 0),
    total_time: Number(row.total_time ?? 0),
    save_time: Number(row.save_time ?? 0),
    search_title: String(row.search_title ?? ''),
  };
}

function rowToFavorite(row: any): Favorite {
  const origin = row.origin;
  return {
    source_name: String(row.source_name ?? ''),
    total_episodes: Number(row.total_episodes ?? 0),
    title: String(row.title ?? ''),
    year: String(row.year ?? ''),
    cover: String(row.cover ?? ''),
    save_time: Number(row.save_time ?? 0),
    search_title: String(row.search_title ?? ''),
    ...(origin === 'vod' || origin === 'live' ? { origin } : {}),
  };
}

export class D1Storage implements IStorage {
  private db: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.db = adapter;
  }

  // ==================== 播放记录 ====================

  async getPlayRecord(
    userName: string,
    key: string
  ): Promise<PlayRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM play_records WHERE username = ? AND key = ?')
      .bind(userName, key)
      .first<any>();
    return row ? rowToPlayRecord(row) : null;
  }

  async setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO play_records (
           username, key, title, source_name, cover, year,
           episode_index, total_episodes, play_time, total_time,
           save_time, search_title
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, key) DO UPDATE SET
           title = excluded.title,
           source_name = excluded.source_name,
           cover = excluded.cover,
           year = excluded.year,
           episode_index = excluded.episode_index,
           total_episodes = excluded.total_episodes,
           play_time = excluded.play_time,
           total_time = excluded.total_time,
           save_time = excluded.save_time,
           search_title = excluded.search_title`
      )
      .bind(
        userName,
        key,
        record.title ?? '',
        record.source_name ?? '',
        record.cover ?? '',
        record.year ?? '',
        Number(record.index ?? 0),
        Number(record.total_episodes ?? 0),
        Number(record.play_time ?? 0),
        Number(record.total_time ?? 0),
        Number(record.save_time ?? Date.now()),
        record.search_title ?? ''
      )
      .run();
  }

  async getAllPlayRecords(
    userName: string
  ): Promise<{ [key: string]: PlayRecord }> {
    const res = await this.db
      .prepare(
        'SELECT * FROM play_records WHERE username = ? ORDER BY save_time DESC'
      )
      .bind(userName)
      .all<any>();
    const out: { [key: string]: PlayRecord } = {};
    for (const row of res.results ?? []) {
      out[String(row.key)] = rowToPlayRecord(row);
    }
    return out;
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM play_records WHERE username = ? AND key = ?')
      .bind(userName, key)
      .run();
  }

  async deleteAllPlayRecords(userName: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM play_records WHERE username = ?')
      .bind(userName)
      .run();
  }

  // ==================== 收藏 ====================

  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    const row = await this.db
      .prepare('SELECT * FROM favorites WHERE username = ? AND key = ?')
      .bind(userName, key)
      .first<any>();
    return row ? rowToFavorite(row) : null;
  }

  async setFavorite(
    userName: string,
    key: string,
    favorite: Favorite
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO favorites (
           username, key, source_name, total_episodes, title, year,
           cover, save_time, search_title, origin
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, key) DO UPDATE SET
           source_name = excluded.source_name,
           total_episodes = excluded.total_episodes,
           title = excluded.title,
           year = excluded.year,
           cover = excluded.cover,
           save_time = excluded.save_time,
           search_title = excluded.search_title,
           origin = excluded.origin`
      )
      .bind(
        userName,
        key,
        favorite.source_name ?? '',
        Number(favorite.total_episodes ?? 0),
        favorite.title ?? '',
        favorite.year ?? '',
        favorite.cover ?? '',
        Number(favorite.save_time ?? Date.now()),
        favorite.search_title ?? '',
        favorite.origin ?? null
      )
      .run();
  }

  async getAllFavorites(
    userName: string
  ): Promise<{ [key: string]: Favorite }> {
    const res = await this.db
      .prepare(
        'SELECT * FROM favorites WHERE username = ? ORDER BY save_time DESC'
      )
      .bind(userName)
      .all<any>();
    const out: { [key: string]: Favorite } = {};
    for (const row of res.results ?? []) {
      out[String(row.key)] = rowToFavorite(row);
    }
    return out;
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM favorites WHERE username = ? AND key = ?')
      .bind(userName, key)
      .run();
  }

  async deleteAllFavorites(userName: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM favorites WHERE username = ?')
      .bind(userName)
      .run();
  }

  // ==================== 用户 ====================

  async registerUser(userName: string, password: string): Promise<void> {
    const hashed = hashPassword(password);
    await this.db
      .prepare(
        `INSERT INTO users (username, password_hash, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
      )
      .bind(userName, hashed, Date.now())
      .run();
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .bind(userName)
      .first<any>();
    if (!row || row.password_hash == null) return false;

    const stored = String(row.password_hash);
    const ok = verifyPassword(password, stored);
    // 平滑升级：历史上存的是明文密码且校验通过，则就地改成加盐哈希
    if (ok && !isHashed(stored)) {
      await this.db
        .prepare('UPDATE users SET password_hash = ? WHERE username = ?')
        .bind(hashPassword(password), userName)
        .run();
    }
    return ok;
  }

  async checkUserExist(userName: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM users WHERE username = ? LIMIT 1')
      .bind(userName)
      .first<any>();
    return row !== null;
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (username, password_hash, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
      )
      .bind(userName, hashPassword(newPassword), Date.now())
      .run();
  }

  async deleteUser(userName: string): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM play_records WHERE username = ?').bind(userName),
      this.db.prepare('DELETE FROM favorites WHERE username = ?').bind(userName),
      this.db.prepare('DELETE FROM search_history WHERE username = ?').bind(userName),
      this.db.prepare('DELETE FROM skip_configs WHERE username = ?').bind(userName),
      this.db.prepare('DELETE FROM users WHERE username = ?').bind(userName),
    ];
    if (this.db.batch) {
      await this.db.batch(stmts);
    } else {
      for (const stmt of stmts) await stmt.run();
    }
  }

  async getAllUsers(): Promise<string[]> {
    const res = await this.db
      .prepare('SELECT username FROM users ORDER BY created_at ASC, username ASC')
      .all<any>();
    return (res.results ?? []).map((r) => String(r.username));
  }

  // ==================== 搜索历史 ====================

  async getSearchHistory(userName: string): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT keyword FROM search_history
         WHERE username = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT ${SEARCH_HISTORY_LIMIT}`
      )
      .bind(userName)
      .all<any>();
    return (res.results ?? []).map((r) => String(r.keyword));
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    const kw = String(keyword);
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO search_history (username, keyword, timestamp)
           VALUES (?, ?, ?)
           ON CONFLICT(username, keyword) DO UPDATE SET timestamp = excluded.timestamp`
        )
        .bind(userName, kw, now),
      // 只保留最近 N 条
      this.db
        .prepare(
          `DELETE FROM search_history
           WHERE username = ?
             AND id NOT IN (
               SELECT id FROM search_history
               WHERE username = ?
               ORDER BY timestamp DESC, id DESC
               LIMIT ${SEARCH_HISTORY_LIMIT}
             )`
        )
        .bind(userName, userName),
    ];
    if (this.db.batch) {
      await this.db.batch(stmts);
    } else {
      for (const stmt of stmts) await stmt.run();
    }
  }

  async deleteSearchHistory(
    userName: string,
    keyword?: string
  ): Promise<void> {
    if (keyword) {
      await this.db
        .prepare('DELETE FROM search_history WHERE username = ? AND keyword = ?')
        .bind(userName, String(keyword))
        .run();
    } else {
      await this.db
        .prepare('DELETE FROM search_history WHERE username = ?')
        .bind(userName)
        .run();
    }
  }

  // ==================== 管理员配置 ====================

  async getAdminConfig(): Promise<AdminConfig | null> {
    const row = await this.db
      .prepare('SELECT config FROM admin_config WHERE id = 1')
      .first<any>();
    if (!row?.config) return null;
    try {
      return JSON.parse(String(row.config)) as AdminConfig;
    } catch (err) {
      console.error('D1Storage.getAdminConfig JSON parse error:', err);
      return null;
    }
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admin_config (id, config, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
      )
      .bind(JSON.stringify(config), Date.now())
      .run();
  }

  // ==================== 跳过片头片尾 ====================

  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM skip_configs WHERE username = ? AND key = ?'
      )
      .bind(userName, `${source}+${id}`)
      .first<any>();
    if (!row) return null;
    return {
      enable: Number(row.enable) === 1,
      intro_time: Number(row.intro_time ?? 0),
      outro_time: Number(row.outro_time ?? 0),
    };
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO skip_configs (username, key, enable, intro_time, outro_time)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username, key) DO UPDATE SET
           enable = excluded.enable,
           intro_time = excluded.intro_time,
           outro_time = excluded.outro_time`
      )
      .bind(
        userName,
        `${source}+${id}`,
        config.enable ? 1 : 0,
        Number(config.intro_time ?? 0),
        Number(config.outro_time ?? 0)
      )
      .run();
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    await this.db
      .prepare('DELETE FROM skip_configs WHERE username = ? AND key = ?')
      .bind(userName, `${source}+${id}`)
      .run();
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    const res = await this.db
      .prepare('SELECT * FROM skip_configs WHERE username = ?')
      .bind(userName)
      .all<any>();
    const out: { [key: string]: SkipConfig } = {};
    for (const row of res.results ?? []) {
      out[String(row.key)] = {
        enable: Number(row.enable) === 1,
        intro_time: Number(row.intro_time ?? 0),
        outro_time: Number(row.outro_time ?? 0),
      };
    }
    return out;
  }

  // ==================== 清库 ====================

  async clearAllData(): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM play_records'),
      this.db.prepare('DELETE FROM favorites'),
      this.db.prepare('DELETE FROM search_history'),
      this.db.prepare('DELETE FROM skip_configs'),
      this.db.prepare('DELETE FROM admin_config'),
      this.db.prepare('DELETE FROM users'),
    ];
    if (this.db.batch) {
      await this.db.batch(stmts);
    } else {
      for (const stmt of stmts) await stmt.run();
    }
  }
}
