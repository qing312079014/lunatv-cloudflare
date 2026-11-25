/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 统一数据库适配器：兼容 Cloudflare D1 与本地 better-sqlite3
 *
 * 仅在服务端使用；客户端 bundle 由 next.config.js 的 alias 排除。
 */

// ---- Cloudflare D1 最小类型声明（避免强依赖 @cloudflare/workers-types）----
export interface D1Result<T = any> {
  results?: T[];
  success: boolean;
  meta?: any;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = any>(colName?: string): Promise<T | null>;
  run<T = any>(): Promise<D1Result<T>>;
  all<T = any>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<D1Result>;
}

export interface DatabaseAdapter {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec?(query: string): any;
}

/**
 * Cloudflare D1 适配器（生产）
 */
export class CloudflareD1Adapter implements DatabaseAdapter {
  constructor(private db: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    return this.db.prepare(query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.db.batch(statements as any);
  }

  async exec(query: string): Promise<D1Result> {
    return this.db.exec(query);
  }
}

/**
 * better-sqlite3 适配器（本地开发，把同步 API 包装成 D1 的 Promise API）
 */
export class SQLiteAdapter implements DatabaseAdapter {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLitePreparedStatement(this.db.prepare(query));
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    const tx = this.db.transaction(() => {
      for (const stmt of statements) {
        results.push((stmt as any).runSync());
      }
    });
    tx();
    return results;
  }

  exec(query: string): void {
    this.db.exec(query);
  }
}

class SQLitePreparedStatement implements D1PreparedStatement {
  private stmt: any;
  private params: any[] = [];

  constructor(stmt: any) {
    this.stmt = stmt;
  }

  bind(...values: any[]): D1PreparedStatement {
    this.params = values;
    return this;
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const row = this.stmt.get(...this.params);
    if (!row) return null;
    if (colName) return (row[colName] ?? null) as T;
    return row as T;
  }

  async run<T = any>(): Promise<D1Result<T>> {
    return this.runSync() as D1Result<T>;
  }

  async all<T = any>(): Promise<D1Result<T>> {
    try {
      const rows = this.stmt.all(...this.params) || [];
      return { success: true, results: rows as T[] };
    } catch (err: any) {
      return { success: false, error: err.message, results: [] };
    }
  }

  runSync(): D1Result {
    try {
      const info = this.stmt.run(...this.params);
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
