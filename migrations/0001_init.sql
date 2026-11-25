-- ============================================================
-- LunaTV on Cloudflare D1 — 初始化结构
-- 执行：wrangler d1 execute lunatv --remote --file=./migrations/0001_init.sql
-- ============================================================

-- 1. 用户
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,          -- scrypt: "salt:hash"
  created_at    INTEGER NOT NULL DEFAULT 0
);

-- 2. 播放记录（key = "source+id"）
CREATE TABLE IF NOT EXISTS play_records (
  username       TEXT NOT NULL,
  key            TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  source_name    TEXT NOT NULL DEFAULT '',
  cover          TEXT NOT NULL DEFAULT '',
  year           TEXT NOT NULL DEFAULT '',
  episode_index  INTEGER NOT NULL DEFAULT 0,
  total_episodes INTEGER NOT NULL DEFAULT 0,
  play_time      INTEGER NOT NULL DEFAULT 0,
  total_time     INTEGER NOT NULL DEFAULT 0,
  save_time      INTEGER NOT NULL DEFAULT 0,
  search_title   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (username, key)
);

CREATE INDEX IF NOT EXISTS idx_play_records_user_time
  ON play_records(username, save_time DESC);

-- 3. 收藏
CREATE TABLE IF NOT EXISTS favorites (
  username       TEXT NOT NULL,
  key            TEXT NOT NULL,
  source_name    TEXT NOT NULL DEFAULT '',
  total_episodes INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL DEFAULT '',
  year           TEXT NOT NULL DEFAULT '',
  cover          TEXT NOT NULL DEFAULT '',
  save_time      INTEGER NOT NULL DEFAULT 0,
  search_title   TEXT NOT NULL DEFAULT '',
  origin         TEXT CHECK(origin IN ('vod', 'live')),
  PRIMARY KEY (username, key)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user_time
  ON favorites(username, save_time DESC);

-- 4. 搜索历史（每用户保留最近 20 条，由应用层裁剪）
CREATE TABLE IF NOT EXISTS search_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL,
  keyword   TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE (username, keyword)
);

CREATE INDEX IF NOT EXISTS idx_search_history_user_time
  ON search_history(username, timestamp DESC);

-- 5. 片头片尾跳过配置
CREATE TABLE IF NOT EXISTS skip_configs (
  username   TEXT NOT NULL,
  key        TEXT NOT NULL,
  enable     INTEGER NOT NULL DEFAULT 1,
  intro_time INTEGER NOT NULL DEFAULT 0,
  outro_time INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, key)
);

-- 6. 站点配置（单行 JSON）
CREATE TABLE IF NOT EXISTS admin_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  config     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
