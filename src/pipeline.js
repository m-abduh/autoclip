import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import * as ig from "./instagram.js";
import * as buffer from "./buffer.js";

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const MAX_PROFILE_PAGES = Math.max(1, Number(process.env.IG_MAX_PAGES) || 8);
const MAX_REEL_PAGES = Math.max(1, Number(process.env.IG_REEL_PAGES) || 5);

function log(level, message, meta = {}) {
  const line = `[${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
  store.addLog({ level, message, ...meta });
}

export function applyTemplate(template, { caption, username, shortcode }) {
  return (template || "{caption}")
    .replaceAll("{caption}", caption || "")
    .replaceAll("{username}", username || "")
    .replaceAll("{shortcode}", shortcode || "")
    .trim();
}

export function cleanCaption(text) {
  if (!text) return "";
  return text
    .replace(/#[\w.\u00C0-\u024F]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publicUrlFor(relPath) {
  if (!PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/media/${relPath.replace(/\\/g, "/")}`;
}

async function uploadToChannels(video, channels, caption, videoTitle) {
  const relPath = path.relative(DOWNLOAD_DIR, video.file).replace(/\\/g, "/");
  const videoUrl = publicUrlFor(relPath);
  if (!videoUrl) {
    throw new Error("PUBLIC_BASE_URL belum diisi; tidak bisa upload ke Buffer");
  }
  if (!channels.length) {
    throw new Error("Tidak ada channel Buffer (pastikan akun terhubung & platform di Settings aktif)");
  }

  const uploads = video.uploads || [];
  for (const channel of channels) {
    const done = uploads.find(
      (u) => u.channelId === channel.id && u.status === "uploaded"
    );
    if (done) {
      log("skip", `${video.shortcode} sudah uploaded ke ${channel.service} (${channel.name})`);
      continue;
    }

    try {
      const service = channel.service;
      const thumbnailOffset =
        service === "youtube" || service === "tiktok" ? 0 : undefined;
      const { postId, dueAt } = await buffer.createPost({
        channelId: channel.id,
        service,
        text: caption,
        videoUrl,
        videoTitle,
        thumbnailOffset,
      });
      const entry = {
        service,
        channelId: channel.id,
        channelName: channel.name,
        status: "uploaded",
        bufferPostId: postId,
        dueAt,
        uploadedAt: new Date().toISOString(),
      };
      const idx = uploads.findIndex((u) => u.channelId === channel.id);
      if (idx >= 0) uploads[idx] = entry;
      else uploads.push(entry);
      log("upload", `${video.shortcode} → ${channel.service} (${channel.name}) berhasil (post ${postId})`);
    } catch (err) {
      const entry = {
        service,
        channelId: channel.id,
        channelName: channel.name,
        status: "failed",
        error: err?.message || String(err),
        uploadedAt: new Date().toISOString(),
      };
      const idx = uploads.findIndex((u) => u.channelId === channel.id);
      if (idx >= 0) uploads[idx] = entry;
      else uploads.push(entry);
      log("error", `${video.shortcode} → ${channel.service} (${channel.name}) gagal: ${entry.error}`);
    }
  }

  video.uploads = uploads;
  const ok = channels.every((c) =>
    uploads.some((u) => u.channelId === c.id && u.status === "uploaded")
  );
  const some = channels.some((c) =>
    uploads.some((u) => u.channelId === c.id && u.status === "uploaded")
  );
  video.status = ok ? "uploaded" : some ? "partial" : "failed";
  return video;
}

async function processShortcode(username, shortcode, settings, channels) {
  const productInfo = await ig.getProductInfo(shortcode);
  if (!productInfo) {
    log("error", `${shortcode}: tidak dapat data (private/dibatasi)`);
    return false;
  }

  const owner = productInfo?.user?.username || username;
  const videos = ig.pickVideoItems(productInfo);
  if (videos.length === 0) {
    log("skip", `${shortcode}: bukan reels (foto/carousel/feed), dilewati`);
    return false;
  }

  const outDir = path.join(DOWNLOAD_DIR, owner);
  fs.mkdirSync(outDir, { recursive: true });
  const caption = cleanCaption(productInfo?.caption?.text || "");
  const text = applyTemplate(settings.captionTemplate, {
    caption,
    username: owner,
    shortcode,
  });
  const videoTitle =
    (caption.split("\n").find((l) => l.trim()) || "").slice(0, 100).trim() ||
    `@${owner} ${shortcode}`;

  let n = 0;
  let downloadedAny = false;
  for (const item of videos) {
    n++;
    const suffix = videos.length > 1 ? `_${n}` : "";
    const filePath = path.join(outDir, `${shortcode}${suffix}.mp4`);
    const url = ig.pickBestVideoUrl(item);
    if (!url) {
      log("error", `${shortcode}${suffix}: tidak ada URL video`);
      continue;
    }

    await ig.downloadTo(url, filePath);
    const mb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    log("download", `@${owner} ${shortcode}${suffix} terunduh (${mb} MB)`);
    downloadedAny = true;

    const record = {
      owner,
      shortcode,
      mediaId: String(item.pk || item.id || ""),
      productType: productInfo?.product_type || "",
      file: filePath,
      caption,
      status: "downloaded",
      uploads: [],
      downloadedAt: new Date().toISOString(),
    };

    const key = `${owner}/${shortcode}`;
    const prev = store.listVideos().find((v) => `${v.owner}/${v.shortcode}` === key);
    if (prev) {
      record.uploads = prev.uploads || [];
      if (prev.status && prev.status !== "downloaded") record.status = prev.status;
    }

    if (settings.autoUpload && channels.length) {
      try {
        const result = await uploadToChannels(record, channels, text, videoTitle);
        record.status = result.status;
      } catch (err) {
        record.status = "failed";
        record.error = err?.message || String(err);
        log("error", `${shortcode}${suffix}: upload gagal: ${record.error}`);
      }
    }

    store.upsertVideo(record);
  }
  return downloadedAny;
}

export async function processUsername(user, settings, channels) {
  if (!user.enabled) return { username: user.username, skipped: true };
  const summary = { username: user.username, detected: 0, processed: 0, queued: 0 };

  // WAJIB REELS: ambil tab Reels (terbaru → terlama). Hanya reel di sini.
  let reels = await ig.getProfileReels(user.username, MAX_REEL_PAGES);
  summary.detected = reels.length;

  // Fallback saat tab Reels di-throttle: cari reel terakhir dari grid profil.
  if (!reels.length) {
    const posts = await ig.getProfilePosts(user.username, MAX_PROFILE_PAGES);
    summary.detected = posts.length;
    reels = posts.filter((p) => p.productType === "clips");
  }

  // Video reel TERAKHIR = reel paling baru yang belum pernah diupload penuh.
  const reel = reels[0];
  if (!reel) {
    const msg = summary.detected
      ? `tidak ada reel di ${summary.detected} post terakhir`
      : `data reel tak bisa diambil (rate-limit IG) — dicoba lagi siklus berikutnya`;
    log("skip", `@${user.username}: ${msg}`);
    return summary; // 0 video → lanjut ke username berikutnya
  }

  const existing = store
    .listVideos()
    .find((v) => `${v.owner}/${v.shortcode}` === `${user.username}/${reel.code}`);

  if (existing?.status === "uploaded") {
    log("skip", `@${user.username}: reel terakhir ${reel.code} sudah diupload → skip`);
    return summary; // sudah keupload penuh → skip ke username lain
  }

  let ok = false;
  if (existing?.file && fs.existsSync(existing.file)) {
    // Reel pernah terunduh tapi belum sukses ke semua channel → retry tanpa unduh ulang.
    const caption = cleanCaption(existing.caption || "");
    const text = applyTemplate(settings.captionTemplate, {
      caption,
      username: user.username,
      shortcode: reel.code,
    });
    const videoTitle =
      (caption.split("\n").find((l) => l.trim()) || "").slice(0, 100).trim() ||
      `@${user.username} ${reel.code}`;
    if (settings.autoUpload && channels.length) {
      try {
        const result = await uploadToChannels(existing, channels, text, videoTitle);
        existing.status = result.status;
        delete existing.error;
        store.upsertVideo(existing);
        log("info", `${reel.code}: retry upload → ${result.status}`);
        ok = result.status === "uploaded" || result.status === "partial";
      } catch (err) {
        existing.status = "failed";
        existing.error = err?.message || String(err);
        store.upsertVideo(existing);
        log("error", `${reel.code}: retry upload gagal: ${existing.error}`);
      }
    } else {
      ok = true; // autoUpload off — cukup sudah terunduh
    }
  } else {
    ok = await processShortcode(user.username, reel.code, settings, channels);
  }

  if (ok) {
    summary.queued = 1;
    const merged = [...new Set([...(user.seen || []), reel.code])].slice(-300);
    store.updateUsername(user.username, { seen: merged });
  }
  return summary;
}

let running = false;

export async function runAll(trigger = "cron") {
  if (running) {
    log("skip", `run diabaikan (masih ada proses berjalan) — trigger ${trigger}`);
    return { skipped: true };
  }
  running = true;
  try {
    const settings = store.getSettings();
    const users = store.listUsernames().filter((u) => u.enabled);
    const n = users.length;
    if (n === 0) {
      log("skip", `tidak ada username aktif (${trigger})`);
      return { results: [] };
    }

    const channels = settings.autoUpload ? await resolveChannels(settings) : [];

    // Rotasi: mulai dari username terakhir yang diproses; jika user tidak punya
    // video baru, lanjut ke username berikutnya dalam run yang sama.
    const start = (Math.max(0, Number(settings.rotationIndex) || 0)) % n;
    const order = [...users.slice(start), ...users.slice(0, start)];
    log("info", `Mulai siklus (${trigger}) — rotasi dari @${order[0].username} (${n} username aktif)`);

    const results = [];
    for (const user of order) {
      try {
        const res = await processUsername(user, settings, channels);
        results.push(res);
      } catch (err) {
        log("error", `@${user.username}: ${err?.message || err}`);
        results.push({ username: user.username, error: err?.message || String(err) });
      }
      const idx = users.findIndex((u) => u.username === user.username);
      store.updateSettings({ rotationIndex: (idx + 1) % n });
      if (results.at(-1)?.queued > 0) break; // sudah dapat 1 video terbaru — selesai
    }

    store.updateSettings({ lastRunAt: new Date().toISOString() });
    const queued = results.reduce((acc, r) => acc + (r.queued || 0), 0);
    log("info", `Siklus selesai (${trigger}) — ${queued} video terbaru diproses`);
    return { results };
  } finally {
    running = false;
  }
}

async function resolveChannels(settings) {
  try {
    const { channels } = await buffer.getChannels();
    const allowed = new Set(
      Array.isArray(settings.services) && settings.services.length
        ? settings.services
        : ["instagram", "tiktok", "youtube"]
    );
    const list = (channels || []).filter((c) => allowed.has(c.service));
    log(
      "info",
      `Channel Buffer: ${list.map((c) => `${c.service}:${c.name}`).join(", ") || "tidak ada"}`
    );
    return list;
  } catch (err) {
    log("error", `Gagal ambil channel Buffer: ${err?.message || err}`);
    return [];
  }
}