import axios from "axios";
import fs from "node:fs";

const APP_ID = "936619743392459";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const browserHeaders = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-us,en;q=0.5",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
};

const cookies = {};
let sessionReady = false;

function storeCookies(setCookie) {
  if (!setCookie) return;
  for (const c of setCookie) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i < 0) continue;
    cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

const cookieHeader = () =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

export async function get(url, headers = {}) {
  const res = await axios.get(url, {
    headers: { ...browserHeaders, ...headers, Cookie: cookieHeader() },
    maxRedirects: 0,
    validateStatus: () => true,
  });
  storeCookies(res.headers["set-cookie"]);
  return res;
}

export async function ensureSession() {
  if (sessionReady) return;
  await get("https://www.instagram.com/");
  sessionReady = true;
}

export function resetSession() {
  for (const k of Object.keys(cookies)) delete cookies[k];
  sessionReady = false;
}

function shortcodeToId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) id = id * 64n + BigInt(ID_CHARS.indexOf(ch));
  return id.toString();
}

function findKey(obj, key) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (cur && typeof cur === "object") {
      if (key in cur) return cur[key];
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return null;
}

function extractProductInfo(html) {
  const re = /<script\b[^>]+\bdata-sjs>(\{.+?\})<\/script>/gs;
  for (const match of html.matchAll(re)) {
    let json;
    try {
      json = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const media = findKey(json, "xig_polaris_media");
    if (media && media.if_not_gated_logged_out) return media.if_not_gated_logged_out;
  }
  return null;
}

export function extractLatestShortcodes(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/"code"\s*:\s*"([A-Za-z0-9_-]+)"/g)) {
    const c = m[1];
    if (/^[a-z]{2}_[A-Z]{2}$/.test(c)) continue;
    if (c.length < 5 || c.length > 15 || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export async function getProfileShortcodes(username) {
  await ensureSession();
  const res = await get(`https://www.instagram.com/${username}/`);
  return extractLatestShortcodes(String(res.data));
}

const LITE_UA =
  "Instagram 175.0.0.24.23 Android (30/11; 420dpi; 1080x2340; samsung; SM-G991B; gts8; smdk; en_US)";

const pkCache = new Map();

// Ambil pk (id user) + 12 post terbaru BESERTA jenisnya dari HTML profil.
// Ini fallback biar tetap jalan walau Lite API di-throttle.
export async function fetchProfileSnapshot(username) {
  await ensureSession();
  const res = await get(`https://www.instagram.com/${username}/`);
  const html = String(res.data);
  const re = /<script\b[^>]*\bdata-sjs>(\{.+?\})<\/script>/gs;
  for (const m of html.matchAll(re)) {
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const node = findKey(json, "xig_user_by_username");
    if (node?.pk && Array.isArray(node.polaris_ordered_timeline_connection?.edges)) {
      const pk = String(node.pk);
      pkCache.set(username, pk);
      const edges = node.polaris_ordered_timeline_connection.edges
        .map((e) => e?.node)
        .filter((n) => n?.code)
        .map((n) => ({
          code: n.code,
          id: String(n.pk ?? n.id ?? ""),
          mediaId: String(n.pk ?? n.id ?? ""),
          mediaType: n.media_type,
          productType: n.product_type,
        }));
      return { pk, edges };
    }
  }
  return { pk: pkCache.get(username) || "", edges: [] };
}

export async function resolveUserPk(username) {
  if (pkCache.has(username)) return pkCache.get(username);
  const { pk } = await fetchProfileSnapshot(username);
  return pk;
}

// Tab REELS via halaman web (/username/reels/) — anonim & TIDAK (atau jarang)
// kena throttle. Mengembalikan 12 reel terbaru, urut terbaru → terlama.
export async function fetchReelsSnapshot(username) {
  await ensureSession();
  const res = await get(`https://www.instagram.com/${username}/reels/`);
  const html = String(res.data);
  const re = /<script\b[^>]*\bdata-sjs>(\{.+?\})<\/script>/gs;
  for (const m of html.matchAll(re)) {
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const node = findKey(json, "xig_user_by_username");
    const edges = node?.polaris_clips_connection?.edges;
    if (Array.isArray(edges)) {
      if (node?.pk) pkCache.set(username, String(node.pk));
      return edges
        .map((e) => e?.node)
        .filter((n) => n?.code)
        .map((n) => ({
          code: n.code,
          id: String(n.pk ?? n.id ?? ""),
          mediaId: String(n.pk ?? n.id ?? ""),
          productType: n.product_type || "clips",
          takenAt: n.taken_at,
        }));
    }
  }
  return [];
}

// Paginasi profil: post terbaru → terlama. Klasifikasi reels GRATIS dari payload.
// Prioritas: Lite API (bisa paginasi dalam). Fallback: 12 terbaru dari HTML profil.
export async function getProfilePosts(username, maxPages = 8) {
  const snapshot = await fetchProfileSnapshot(username);
  const pk = snapshot.pk;
  const headers = {
    "User-Agent": LITE_UA,
    "X-IG-App-ID": "567067343352427",
    "X-IG-Capabilities": "3brTvw==",
    "X-IG-Connection-Type": "WIFI",
    Accept: "*/*",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };

  const lite = [];
  let maxId = "";
  let liteOk = false;
  for (let page = 0; pk && page < maxPages; page++) {
    const url =
      `https://i.instagram.com/api/v1/feed/user/${pk}/?count=12` +
      (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
    let data = {};
    let got = false;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const res = await get(url, headers);
        const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (res.status === 200) {
          data = body;
          got = true;
        } else if (attempt < 1) {
          await new Promise((r) => setTimeout(r, 15000));
        }
      } catch {
        break;
      }
    }
    if (!got) break; // throttle — hentikan paginasi dalam
    liteOk = true;
    for (const it of data.items || []) {
      if (it?.code) {
        lite.push({
          code: it.code,
          id: String(it.pk ?? it.id ?? ""),
          mediaId: String(it.pk ?? it.id ?? ""),
          mediaType: it.media_type,
          productType: it.product_type,
          takenAt: it.taken_at,
        });
      }
    }
    maxId = data.next_max_id || "";
    if (!data.more_available || !maxId) break;
    if (page < maxPages - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  if (liteOk && lite.length) return lite;
  return snapshot.edges; // fallback 12 terbaru dari HTML (tetap berisi klasifikasi)
}

// Tab REELS user (anonim): hanya reel, terbaru → terlama.
// Sumber utama = halaman web /reels/ (anti-throttle). Fallback = Lite API clips/user.
export async function getProfileReels(username, maxPages = 5) {
  const web = await fetchReelsSnapshot(username);
  if (web.length) return web;

  await ensureSession();
  const pk = await resolveUserPk(username);
  if (!pk) return [];
  const headers = {
    "User-Agent": LITE_UA,
    "X-IG-App-ID": "567067343352427",
    "X-IG-Capabilities": "3brTvw==",
    "X-IG-Connection-Type": "WIFI",
    Accept: "*/*",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  const items = [];
  let maxId = "";
  for (let page = 0; page < maxPages; page++) {
    const url =
      `https://i.instagram.com/api/v1/clips/user/?target_user_id=${pk}&count=12` +
      (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
    let data = {};
    let got = false;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const res = await get(url, headers);
        const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (res.status === 200) {
          data = body;
          got = true;
        } else if (attempt < 1) {
          await new Promise((r) => setTimeout(r, 15000));
        }
      } catch {
        break;
      }
    }
    if (!got) break; // throttle — pakai yang sudah terkumpul
    for (const it of data.items || []) {
      const m = it.media || it;
      if (m?.code) {
        items.push({
          code: m.code,
          id: String(m.pk ?? m.id ?? ""),
          mediaId: String(m.pk ?? m.id ?? ""),
          productType: m.product_type || "clips",
          takenAt: m.taken_at,
        });
      }
    }
    maxId = data.next_max_id || "";
    if (!data.more_available || !maxId) break;
    if (page < maxPages - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  return items;
}

export async function getProductInfo(shortcode) {
  await ensureSession();
  await get(
    `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${shortcodeToId(shortcode)}`,
    {
      "X-Ig-App-Id": APP_ID,
      "X-Asbd-Id": "359341",
      "X-Ig-Www-Claim": "0",
      Origin: "https://www.instagram.com",
      Accept: "*/*",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    }
  );
  const page = await get(`https://www.instagram.com/p/${shortcode}`);
  return extractProductInfo(String(page.data));
}

export function pickVideoItems(productInfo) {
  // WAJIB REELS (product_type "clips"). Foto, carousel, feed video, IGTV → [].
  if (productInfo?.product_type !== "clips") return [];
  const items = productInfo.carousel_media || [productInfo];
  return items.filter((it) => it.media_type === 2 || !!it.video_versions);
}

export function pickBestVideoUrl(item) {
  const versions = [...(item.video_versions || [])].sort(
    (a, b) => (b.type || 0) - (a.type || 0)
  );
  return versions.length ? versions[0].url : null;
}

export async function downloadTo(url, filePath) {
  const res = await axios({
    url,
    method: "GET",
    responseType: "stream",
    headers: { Referer: "https://www.instagram.com/", "User-Agent": UA },
  });
  const tmp = `${filePath}.part`;
  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmp);
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
    replaceFile(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt < 5 && (err.code === "EBUSY" || err.code === "EPERM")) continue;
      throw err;
    }
  }
}
