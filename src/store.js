import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL belum diisi di .env (connection string Prisma Postgres)");
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

const DEFAULT_SETTINGS = {
  intervalHours: Number(process.env.INTERVAL_HOURS) || 1,
  fetchBatchSize: 1,
  captionTemplate: "Follow for more! {caption}",
  autoUpload: true,
  services: ["instagram", "tiktok", "youtube"],
  lastRunAt: null,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  rotation_index INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buffer_accounts (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_usernames (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  seen        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, username)
);

CREATE TABLE IF NOT EXISTS videos (
  id            SERIAL PRIMARY KEY,
  owner         TEXT NOT NULL,
  shortcode     TEXT NOT NULL,
  media_id      TEXT NOT NULL DEFAULT '',
  file          TEXT NOT NULL,
  caption       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'downloaded',
  downloads     INTEGER NOT NULL DEFAULT 1,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, shortcode)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id                SERIAL PRIMARY KEY,
  campaign_id       INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  buffer_account_id INTEGER NOT NULL REFERENCES buffer_accounts(id) ON DELETE CASCADE,
  owner             TEXT NOT NULL,
  shortcode         TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  channel_name      TEXT NOT NULL DEFAULT '',
  service           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  buffer_post_id    TEXT,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, buffer_account_id, channel_id, owner, shortcode)
);

CREATE TABLE IF NOT EXISTS logs (
  id      SERIAL PRIMARY KEY,
  level   TEXT NOT NULL,
  message TEXT NOT NULL,
  meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_campaign ON buffer_accounts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cusernames_campaign ON campaign_usernames(campaign_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_video ON deliveries(owner, shortcode);
CREATE INDEX IF NOT EXISTS idx_deliveries_campaign ON deliveries(campaign_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_updated ON deliveries(updated_at);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
`;

let schemaPromise = null;

async function init() {
  await pool.query(SCHEMA);

  // Catatan: jangan pakai q()/getSetting() di sini — keduanya menunggu ready(),
  // yang menunggu init() ini, sehingga bisa deadlock. Pakai pool.query langsung.
  const flag = await pool.query("SELECT value FROM settings WHERE key = '__initialized'");
  const initialized = flag.rows.length ? flag.rows[0].value === true : false;
  if (!initialized) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM campaigns");
    if (rows[0].n === 0) {
      await pool.query("INSERT INTO campaigns (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", ["Default"]);
    }
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('__initialized', 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    );
  }
}

async function ready() {
  if (!schemaPromise) {
    schemaPromise = init().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function q(sql, params = []) {
  await ready();
  return pool.query(sql, params);
}

export async function closePool() {
  await pool.end();
}

// ---------- Settings ----------

export async function getSettings() {
  const rows = (await q("SELECT key, value FROM settings")).rows;
  const out = {};
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    out[r.key] = r.value;
  }
  return { ...DEFAULT_SETTINGS, ...out };
}

async function getSetting(key, fallback) {
  const { rows } = await q("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

export async function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) await setSetting(k, v);
  return getSettings();
}

// ---------- Campaigns ----------

const CAMPAIGN_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*)::int FROM buffer_accounts b
      WHERE b.campaign_id = c.id AND b.enabled) AS account_count,
    (SELECT COUNT(*)::int FROM campaign_usernames u
      WHERE u.campaign_id = c.id AND u.enabled) AS username_count
  FROM campaigns c
`;

function rowToCampaign(r) {
  return {
    id: Number(r.id),
    name: r.name,
    enabled: !!r.enabled,
    rotationIndex: Number(r.rotation_index) || 0,
    accountCount: Number(r.account_count ?? 0),
    usernameCount: Number(r.username_count ?? 0),
    createdAt: iso(r.created_at),
  };
}

export async function listCampaigns() {
  const { rows } = await q(`${CAMPAIGN_SELECT} ORDER BY c.created_at, c.id`);
  return rows.map(rowToCampaign);
}

export async function getCampaign(id) {
  const { rows } = await q(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [Number(id)]);
  return rows.length ? rowToCampaign(rows[0]) : null;
}

export async function getCampaignByName(name) {
  const { rows } = await q(`${CAMPAIGN_SELECT} WHERE c.name = $1`, [name]);
  return rows.length ? rowToCampaign(rows[0]) : null;
}

export async function addCampaign({ name, enabled = true }) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Nama kampanye wajib diisi");
  const { rows } = await q(
    `INSERT INTO campaigns (name, enabled) VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING *`,
    [clean, enabled]
  );
  if (!rows.length) throw new Error(`Kampanye "${clean}" sudah ada`);
  return getCampaign(rows[0].id);
}

export async function updateCampaign(id, patch) {
  const sets = [];
  const vals = [];
  const push = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ("name" in patch) push("name", String(patch.name || "").trim());
  if ("enabled" in patch) push("enabled", !!patch.enabled);
  if ("rotationIndex" in patch) push("rotation_index", Number(patch.rotationIndex) || 0);
  if (sets.length) {
    vals.push(Number(id));
    await q(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  return getCampaign(id);
}

export async function removeCampaign(id) {
  const { rowCount } = await q("DELETE FROM campaigns WHERE id = $1", [Number(id)]);
  return rowCount > 0;
}

// ---------- Buffer accounts (satu baris = satu API key Buffer) ----------

function rowToAccount(r) {
  return {
    id: Number(r.id),
    campaignId: Number(r.campaign_id),
    label: r.label || "",
    apiKey: r.api_key,
    enabled: !!r.enabled,
    createdAt: iso(r.created_at),
  };
}

export function maskKey(key) {
  const s = String(key || "");
  if (s.length <= 8) return s ? "****" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export async function listBufferAccounts(campaignId) {
  const { rows } = await q(
    "SELECT * FROM buffer_accounts WHERE campaign_id = $1 ORDER BY created_at, id",
    [Number(campaignId)]
  );
  return rows.map(rowToAccount);
}

export async function getBufferAccount(id) {
  const { rows } = await q("SELECT * FROM buffer_accounts WHERE id = $1", [Number(id)]);
  return rows.length ? rowToAccount(rows[0]) : null;
}

export async function addBufferAccount({ campaignId, label = "", apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API key Buffer wajib diisi");
  const { rows } = await q(
    `INSERT INTO buffer_accounts (campaign_id, label, api_key)
     VALUES ($1, $2, $3) RETURNING *`,
    [Number(campaignId), String(label || "").trim(), key]
  );
  return rowToAccount(rows[0]);
}

export async function updateBufferAccount(id, patch) {
  const sets = [];
  const vals = [];
  const push = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ("label" in patch) push("label", String(patch.label || "").trim());
  if ("apiKey" in patch && String(patch.apiKey || "").trim()) push("api_key", String(patch.apiKey).trim());
  if ("enabled" in patch) push("enabled", !!patch.enabled);
  if (sets.length) {
    vals.push(Number(id));
    await q(`UPDATE buffer_accounts SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  return getBufferAccount(id);
}

export async function removeBufferAccount(id) {
  const { rowCount } = await q("DELETE FROM buffer_accounts WHERE id = $1", [Number(id)]);
  return rowCount > 0;
}

// ---------- Campaign usernames (sumber Instagram) ----------

function rowToCampaignUsername(r) {
  return {
    campaignId: Number(r.campaign_id),
    username: r.username,
    enabled: !!r.enabled,
    seen: Array.isArray(r.seen) ? r.seen : [],
    createdAt: iso(r.created_at),
  };
}

export async function listCampaignUsernames(campaignId) {
  const { rows } = await q(
    "SELECT * FROM campaign_usernames WHERE campaign_id = $1 ORDER BY created_at, username",
    [Number(campaignId)]
  );
  return rows.map(rowToCampaignUsername);
}

export async function getCampaignUsername(campaignId, username) {
  const { rows } = await q(
    "SELECT * FROM campaign_usernames WHERE campaign_id = $1 AND username = $2",
    [Number(campaignId), username]
  );
  return rows.length ? rowToCampaignUsername(rows[0]) : null;
}

export async function addCampaignUsername(campaignId, username) {
  const clean = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (!clean) return null;
  await q(
    `INSERT INTO campaign_usernames (campaign_id, username)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [Number(campaignId), clean]
  );
  return getCampaignUsername(campaignId, clean);
}

export async function updateCampaignUsername(campaignId, username, patch) {
  const sets = [];
  const vals = [];
  const push = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ("enabled" in patch) push("enabled", !!patch.enabled);
  if ("seen" in patch) push("seen", JSON.stringify(patch.seen || []));
  if (sets.length) {
    vals.push(Number(campaignId), username);
    await q(
      `UPDATE campaign_usernames SET ${sets.join(", ")}
       WHERE campaign_id = $${vals.length - 1} AND username = $${vals.length}`,
      vals
    );
  }
  return getCampaignUsername(campaignId, username);
}

export async function removeCampaignUsername(campaignId, username) {
  const { rowCount } = await q(
    "DELETE FROM campaign_usernames WHERE campaign_id = $1 AND username = $2",
    [Number(campaignId), username]
  );
  return rowCount > 0;
}

export async function listAllUsernames() {
  const { rows } = await q(
    `SELECT u.*, c.name AS campaign_name, c.enabled AS campaign_enabled
     FROM campaign_usernames u
     JOIN campaigns c ON c.id = u.campaign_id
     ORDER BY c.name, u.username`
  );
  return rows.map((r) => ({
    ...rowToCampaignUsername(r),
    campaignName: r.campaign_name,
    campaignEnabled: !!r.campaign_enabled,
  }));
}

// ---------- Videos (file & caption global, dibagi antar kampanye) ----------

function rowToVideo(r) {
  return {
    id: Number(r.id),
    owner: r.owner,
    shortcode: r.shortcode,
    mediaId: r.media_id,
    file: r.file,
    caption: r.caption,
    status: r.status,
    downloads: Number(r.downloads) || 1,
    downloadedAt: iso(r.downloaded_at),
  };
}

export async function listVideos(limit = 500) {
  const { rows } = await q("SELECT * FROM videos ORDER BY downloaded_at DESC LIMIT $1", [limit]);
  return rows.map(rowToVideo);
}

export async function getVideo(owner, shortcode) {
  const { rows } = await q(
    "SELECT * FROM videos WHERE owner = $1 AND shortcode = $2",
    [owner, shortcode]
  );
  return rows.length ? rowToVideo(rows[0]) : null;
}

export async function upsertVideo(record) {
  const { rows } = await q(
    `INSERT INTO videos (owner, shortcode, media_id, file, caption, status, downloaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner, shortcode) DO UPDATE SET
       media_id = excluded.media_id,
       file = excluded.file,
       caption = excluded.caption,
       status = excluded.status
     RETURNING *`,
    [
      record.owner,
      record.shortcode,
      record.mediaId || "",
      record.file,
      record.caption || "",
      record.status || "downloaded",
    ]
  );
  return rowToVideo(rows[0]);
}

// ---------- Deliveries (status upload per kampanye/akun/channel) ----------

function rowToDelivery(r) {
  return {
    id: Number(r.id),
    campaignId: Number(r.campaign_id),
    bufferAccountId: Number(r.buffer_account_id),
    owner: r.owner,
    shortcode: r.shortcode,
    channelId: r.channel_id,
    channelName: r.channel_name,
    service: r.service,
    status: r.status,
    bufferPostId: r.buffer_post_id,
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getDelivery({ campaignId, bufferAccountId, channelId, owner, shortcode }) {
  const { rows } = await q(
    `SELECT * FROM deliveries
     WHERE campaign_id = $1 AND buffer_account_id = $2 AND channel_id = $3
       AND owner = $4 AND shortcode = $5`,
    [Number(campaignId), Number(bufferAccountId), String(channelId), owner, shortcode]
  );
  return rows.length ? rowToDelivery(rows[0]) : null;
}

export async function upsertDelivery(record) {
  const { rows } = await q(
    `INSERT INTO deliveries
       (campaign_id, buffer_account_id, owner, shortcode, channel_id, channel_name,
        service, status, buffer_post_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (campaign_id, buffer_account_id, channel_id, owner, shortcode)
     DO UPDATE SET
       channel_name = excluded.channel_name,
       service = excluded.service,
       status = excluded.status,
       buffer_post_id = excluded.buffer_post_id,
       error = excluded.error,
       updated_at = now()
     RETURNING *`,
    [
      Number(record.campaignId),
      Number(record.bufferAccountId),
      record.owner,
      record.shortcode,
      String(record.channelId),
      record.channelName || "",
      record.service || "",
      record.status || "pending",
      record.bufferPostId || null,
      record.error || null,
    ]
  );
  return rowToDelivery(rows[0]);
}

export async function listDeliveries({ campaignId, limit = 200 } = {}) {
  const sql = campaignId
    ? `SELECT * FROM deliveries WHERE campaign_id = $1 ORDER BY updated_at DESC LIMIT $2`
    : `SELECT * FROM deliveries ORDER BY updated_at DESC LIMIT $1`;
  const params = campaignId ? [Number(campaignId), limit] : [limit];
  const { rows } = await q(sql, params);
  return rows.map(rowToDelivery);
}

export async function deliveryStatusFor(campaignId, owner, shortcode) {
  const { rows } = await q(
    "SELECT status FROM deliveries WHERE campaign_id = $1 AND owner = $2 AND shortcode = $3",
    [Number(campaignId), owner, shortcode]
  );
  if (!rows.length) return "downloaded";
  const total = rows.length;
  const ok = rows.filter((r) => r.status === "uploaded").length;
  if (ok === total) return "uploaded";
  if (ok === 0 && rows.every((r) => r.status === "failed")) return "failed";
  if (ok > 0) return "partial";
  return "pending";
}

// ---------- Logs ----------

export async function addLog(entry) {
  await q(
    "INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3::jsonb)",
    [entry.level, entry.message, JSON.stringify(entry.meta || {})]
  );
  await q(
    `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 100)`
  );
  // Batasi juga umur log: simpan maksimal 7 hari terakhir.
  await q(`DELETE FROM logs WHERE at < now() - interval '7 days'`);
}

export async function getLogs(limit = 100) {
  const { rows } = await q("SELECT * FROM logs ORDER BY id DESC LIMIT $1", [limit]);
  return rows.map((r) => ({
    at: iso(r.at),
    level: r.level,
    message: r.message,
    meta: r.meta || {},
  }));
}

export async function clearLogs() {
  await q("DELETE FROM logs");
}

// ---------- Analytics ----------

function num(v) {
  return Number(v) || 0;
}

export async function getAnalytics() {
  const [
    campaignsAgg,
    accountsAgg,
    usernamesAgg,
    videosAgg,
    deliveryAgg,
    byService,
    byAccount,
    byCampaign,
    byStatus,
    daily,
    topOwners,
    hourly,
  ] = await Promise.all([
    q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS active FROM campaigns"),
    q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS active FROM buffer_accounts"),
    q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS active FROM campaign_usernames"),
    q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE downloaded_at::date = current_date)::int AS today,
              COUNT(*) FILTER (WHERE downloaded_at >= now() - interval '7 days')::int AS week
       FROM videos`
    ),
    q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'uploaded')::int AS uploaded,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE updated_at::date = current_date AND status = 'uploaded')::int AS today_uploaded
       FROM deliveries`
    ),
    q(
      `SELECT service, status, COUNT(*)::int AS n
       FROM deliveries GROUP BY service, status ORDER BY service`
    ),
    q(
      `SELECT b.id, b.label, c.name AS campaign_name,
              COUNT(*) FILTER (WHERE d.status = 'uploaded')::int AS uploaded,
              COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed
       FROM buffer_accounts b
       JOIN campaigns c ON c.id = b.campaign_id
       LEFT JOIN deliveries d ON d.buffer_account_id = b.id
       GROUP BY b.id, b.label, c.name
       ORDER BY uploaded DESC, b.id`
    ),
    q(
      `SELECT c.id, c.name,
              COUNT(d.id)::int AS total,
              COUNT(*) FILTER (WHERE d.status = 'uploaded')::int AS uploaded,
              COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed,
              COUNT(DISTINCT d.owner || '/' || d.shortcode)::int AS videos
       FROM campaigns c
       LEFT JOIN deliveries d ON d.campaign_id = c.id
       GROUP BY c.id, c.name
       ORDER BY c.id`
    ),
    q(
      `SELECT status, COUNT(*)::int AS n FROM deliveries GROUP BY status ORDER BY n DESC`
    ),
    q(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(COUNT(dl.id) FILTER (WHERE dl.status = 'uploaded'), 0)::int AS uploaded,
              COALESCE(COUNT(dl.id) FILTER (WHERE dl.status = 'failed'), 0)::int AS failed
       FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') AS d(day)
       LEFT JOIN deliveries dl ON dl.updated_at::date = d.day::date
       GROUP BY d.day ORDER BY d.day`
    ),
    q(
      `SELECT owner, COUNT(*)::int AS n FROM videos GROUP BY owner ORDER BY n DESC, owner LIMIT 8`
    ),
    q(
      `SELECT to_char(date_trunc('hour', at), 'HH24:00') AS hour,
              COUNT(*)::int AS n
       FROM logs WHERE at >= now() - interval '24 hours'
       GROUP BY date_trunc('hour', at) ORDER BY date_trunc('hour', at)`
    ),
  ]);

  const d = deliveryAgg.rows[0] || {};
  const attempted = num(d.uploaded) + num(d.failed);
  const successRate = attempted ? Math.round((num(d.uploaded) / attempted) * 100) : 0;

  return {
    campaigns: campaignsAgg.rows[0] || { total: 0, active: 0 },
    accounts: accountsAgg.rows[0] || { total: 0, active: 0 },
    usernames: usernamesAgg.rows[0] || { total: 0, active: 0 },
    videos: videosAgg.rows[0] || { total: 0, today: 0, week: 0 },
    deliveries: {
      total: num(d.total),
      uploaded: num(d.uploaded),
      failed: num(d.failed),
      pending: num(d.pending),
      todayUploaded: num(d.today_uploaded),
      successRate,
    },
    byService: byService.rows.map((r) => ({ ...r, service: r.service || "lainnya", n: num(r.n) })),
    byAccount: byAccount.rows.map((r) => ({
      id: Number(r.id),
      label: r.label || `Akun #${r.id}`,
      campaignName: r.campaign_name,
      uploaded: num(r.uploaded),
      failed: num(r.failed),
    })),
    byCampaign: byCampaign.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      total: num(r.total),
      uploaded: num(r.uploaded),
      failed: num(r.failed),
      videos: num(r.videos),
    })),
    byStatus: byStatus.rows.map((r) => ({ status: r.status, n: num(r.n) })),
    daily: daily.rows.map((r) => ({
      day: r.day,
      uploaded: num(r.uploaded),
      failed: num(r.failed),
    })),
    topOwners: topOwners.rows.map((r) => ({ owner: r.owner, n: num(r.n) })),
    hourly: hourly.rows.map((r) => ({ hour: r.hour, n: num(r.n) })),
  };
}

// ---------- Seed ----------

export async function seed({ campaign = "Default", usernames = [] } = {}) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if ((await getSetting(k, undefined)) === undefined) await setSetting(k, v);
  }
  let c = await getCampaignByName(campaign);
  if (!c) c = await addCampaign({ name: campaign });
  for (const username of usernames || []) await addCampaignUsername(c.id, username);
  return c;
}
