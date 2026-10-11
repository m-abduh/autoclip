import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.DATA_DIR || "data";
const DB_FILE = path.join(DATA_DIR, "autoclip.db");

const DEFAULT_SETTINGS = {
  intervalHours: Number(process.env.INTERVAL_HOURS) || 1,
  fetchBatchSize: 1,
  captionTemplate: "Follow for more! {caption}",
  autoUpload: true,
  services: ["instagram", "tiktok", "youtube"],
  rotationIndex: 0,
  lastRunAt: null,
};

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usernames (
      username   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      seen       TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owner         TEXT NOT NULL,
      shortcode     TEXT NOT NULL,
      media_id      TEXT NOT NULL DEFAULT '',
      file          TEXT NOT NULL,
      caption       TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'downloaded',
      uploads       TEXT NOT NULL DEFAULT '[]',
      downloaded_at TEXT NOT NULL,
      UNIQUE (owner, shortcode)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      level   TEXT NOT NULL,
      message TEXT NOT NULL,
      meta    TEXT NOT NULL DEFAULT '{}',
      at      TEXT NOT NULL
    );
  `);
  return db;
}

function getSetting(key, fallback) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value));
}

function rowToUsername(r) {
  return {
    username: r.username,
    enabled: !!r.enabled,
    seen: JSON.parse(r.seen),
    createdAt: r.created_at,
  };
}

function rowToVideo(r) {
  return {
    owner: r.owner,
    shortcode: r.shortcode,
    mediaId: r.media_id,
    file: r.file,
    caption: r.caption,
    status: r.status,
    uploads: JSON.parse(r.uploads),
    downloadedAt: r.downloaded_at,
  };
}

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...storeAllSettings() };
}

function storeAllSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue; // buang key lama/nonaktif
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* lewati nilai rusak */
    }
  }
  return out;
}

export function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) setSetting(k, v);
  return getSettings();
}

export function listUsernames() {
  return getDb().prepare("SELECT * FROM usernames ORDER BY created_at").all().map(rowToUsername);
}

export function getUsername(username) {
  const row = getDb().prepare("SELECT * FROM usernames WHERE username = ?").get(username);
  return row ? rowToUsername(row) : null;
}

export function addUsername({ username }) {
  const d = getDb();
  d.prepare(
    "INSERT OR IGNORE INTO usernames (username, enabled, seen, created_at) VALUES (?, 1, '[]', ?)"
  ).run(username, new Date().toISOString());
  return getUsername(username);
}

export function updateUsername(username, patch) {
  const sets = [];
  const vals = [];
  if ("enabled" in patch) {
    sets.push("enabled = ?");
    vals.push(patch.enabled ? 1 : 0);
  }
  if ("seen" in patch) {
    sets.push("seen = ?");
    vals.push(JSON.stringify(patch.seen));
  }
  if (!sets.length) return getUsername(username);
  vals.push(username);
  getDb()
    .prepare(`UPDATE usernames SET ${sets.join(", ")} WHERE username = ?`)
    .run(...vals);
  return getUsername(username);
}

export function removeUsername(username) {
  const { changes } = getDb().prepare("DELETE FROM usernames WHERE username = ?").run(username);
  return changes > 0;
}

export function listVideos() {
  return getDb().prepare("SELECT * FROM videos ORDER BY downloaded_at DESC").all().map(rowToVideo);
}

export function getVideoKey(owner, shortcode) {
  return `${owner}/${shortcode}`;
}

export function upsertVideo(record) {
  const d = getDb();
  const existing = d
    .prepare("SELECT * FROM videos WHERE owner = ? AND shortcode = ?")
    .get(record.owner, record.shortcode);
  const uploads = record.uploads || (existing ? JSON.parse(existing.uploads) : []);
  const status = record.status || (existing ? existing.status : "downloaded");
  const mediaId = record.mediaId || (existing ? existing.media_id : "");
  const caption = record.caption || (existing ? existing.caption : "");
  const downloadedAt = record.downloadedAt || new Date().toISOString();

  d.prepare(
    `INSERT INTO videos (owner, shortcode, media_id, file, caption, status, uploads, downloaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, shortcode) DO UPDATE SET
       media_id = excluded.media_id,
       file = excluded.file,
       caption = excluded.caption,
       status = excluded.status,
       uploads = excluded.uploads,
       downloaded_at = excluded.downloaded_at`
  ).run(record.owner, record.shortcode, mediaId, record.file, caption, status, JSON.stringify(uploads), downloadedAt);

  return rowToVideo(
    d.prepare("SELECT * FROM videos WHERE owner = ? AND shortcode = ?").get(record.owner, record.shortcode)
  );
}

export function addLog(entry) {
  const d = getDb();
  d.prepare("INSERT INTO logs (level, message, meta, at) VALUES (?, ?, ?, ?)").run(
    entry.level,
    entry.message,
    JSON.stringify(entry.meta || {}),
    new Date().toISOString()
  );
  d.exec(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 300)`);
}

export function getLogs() {
  return getDb()
    .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100")
    .all()
    .map((r) => ({ at: r.at, level: r.level, message: r.message, meta: JSON.parse(r.meta) }));
}

// ---------- Seed ----------

export function seed(usernames) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (getSetting(k, undefined) === undefined) setSetting(k, v);
  }
  for (const username of usernames || []) addUsername({ username });
}