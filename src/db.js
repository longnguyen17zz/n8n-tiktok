import pg from 'pg';

const { Pool } = pg;

// Dùng PostgreSQL (Render Postgres free) thay vì SQLite file — vì gói Web Service Free của Render
// KHÔNG hỗ trợ Persistent Disk (dữ liệu file sẽ mất mỗi lần instance ngủ/khởi động lại), trong khi
// Render Postgres là service lưu trữ riêng biệt, không phụ thuộc đĩa của web service.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'Thiếu biến môi trường DATABASE_URL. Tạo 1 Postgres database trên Render (hoặc dùng Postgres local khi dev), ' +
    'rồi đặt connection string vào DATABASE_URL trong .env / Render Environment.'
  );
}

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_keys (
      id SERIAL PRIMARY KEY,
      key_code TEXT UNIQUE NOT NULL,
      label TEXT,
      plan_label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      license_key_id INTEGER UNIQUE NOT NULL REFERENCES license_keys(id),
      settings_json TEXT NOT NULL DEFAULT '{}',
      drive_oauth_tokens_json TEXT,
      chrome_profile_dir TEXT,
      cdp_port INTEGER,
      can_use_studio BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}
