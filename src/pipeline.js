import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import * as ig from "./instagram.js";
import * as buffer from "./buffer.js";

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const MAX_PROFILE_PAGES = Math.max(1, Number(process.env.IG_MAX_PAGES) || 8);
const MAX_REEL_PAGES = Math.max(1, Number(process.env.IG_REEL_PAGES) || 5);
const DEFAULT_SERVICES = ["instagram", "tiktok", "youtube"];

// Cache channel per akun Buffer selama satu siklus (hemat request GraphQL).
const channelCache = new Map();

async function log(level, message, meta = {}) {
  const line = `[${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
  try {
    await store.addLog({ level, message, ...meta });
  } catch (err) {
    console.error("[log] gagal simpan log:", err.message);
  }
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

async function channelsFor(account, services) {
  let list = channelCache.get(account.id);
  if (!list) {
    const { channels } = await buffer.getChannels(account.apiKey);
    list = channels || [];
    channelCache.set(account.id, list);
  }
  const allowed = new Set(
    Array.isArray(services) && services.length ? services : DEFAULT_SERVICES
  );
  return list.filter((c) => allowed.has(c.service));
}

function accountLabel(account) {
  return account.label || `Akun #${account.id}`;
}

// Kirim satu video ke seluruh channel dari seluruh akun Buffer di kampanye.
async function deliverVideo(video, campaign, accounts, settings, text, videoTitle) {
  const relPath = path.relative(DOWNLOAD_DIR, video.file).replace(/\\/g, "/");
  const videoUrl = publicUrlFor(relPath);
  if (!videoUrl) {
    await log("error", "PUBLIC_BASE_URL belum diisi; tidak bisa upload ke Buffer");
    return "failed";
  }

  let attempted = 0;
  let ok = 0;
  let failed = 0;

  for (const account of accounts) {
    let channels = [];
    try {
      channels = await channelsFor(account, settings.services);
    } catch (err) {
      failed++;
      await log(
        "error",
        `${video.shortcode}: akun Buffer "${accountLabel(account)}" gagal diakses: ${err?.message || err}`
      );
      continue;
    }
    if (!channels.length) {
      await log("skip", `${video.shortcode}: akun "${accountLabel(account)}" tidak punya channel aktif`);
      continue;
    }

    for (const channel of channels) {
      const existing = await store.getDelivery({
        campaignId: campaign.id,
        bufferAccountId: account.id,
        channelId: channel.id,
        owner: video.owner,
        shortcode: video.shortcode,
      });
      if (existing?.status === "uploaded") {
        ok++;
        attempted++;
        await log(
          "skip",
          `${video.shortcode}: sudah uploaded ke ${channel.service} (${channel.name}) via "${accountLabel(account)}"`
        );
        continue;
      }

      attempted++;
      const thumbnailOffset =
        channel.service === "youtube" || channel.service === "tiktok" ? 0 : undefined;

      try {
        const { postId, dueAt } = await buffer.createPost({
          token: account.apiKey,
          channelId: channel.id,
          service: channel.service,
          text,
          videoUrl,
          videoTitle,
          thumbnailOffset,
        });
        await store.upsertDelivery({
          campaignId: campaign.id,
          bufferAccountId: account.id,
          owner: video.owner,
          shortcode: video.shortcode,
          channelId: channel.id,
          channelName: channel.name,
          service: channel.service,
          status: "uploaded",
          bufferPostId: postId,
        });
        ok++;
        await log(
          "upload",
          `${video.shortcode} → ${channel.service} (${channel.name}) via "${accountLabel(account)}" (post ${postId}${dueAt ? `, due ${dueAt}` : ""})`
        );
      } catch (err) {
        failed++;
        await store.upsertDelivery({
          campaignId: campaign.id,
          bufferAccountId: account.id,
          owner: video.owner,
          shortcode: video.shortcode,
          channelId: channel.id,
          channelName: channel.name,
          service: channel.service,
          status: "failed",
          error: err?.message || String(err),
        });
        await log(
          "error",
          `${video.shortcode} → ${channel.service} (${channel.name}) via "${accountLabel(account)}" gagal: ${err?.message || err}`
        );
      }
    }
  }

  if (!attempted) return "downloaded";
  if (ok === attempted) return "uploaded";
  if (ok > 0) return "partial";
  return failed > 0 ? "failed" : "downloaded";
}

async function ensureVideo(owner, shortcode) {
  const existing = await store.getVideo(owner, shortcode);
  if (existing?.file && fs.existsSync(existing.file)) return existing;

  const productInfo = await ig.getProductInfo(shortcode);
  if (!productInfo) {
    await log("error", `${shortcode}: tidak dapat data (private/dibatasi)`);
    return null;
  }

  const items = ig.pickVideoItems(productInfo);
  if (!items.length) {
    await log("skip", `${shortcode}: bukan reels (foto/carousel/feed), dilewati`);
    return null;
  }

  const item = items[0];
  const url = ig.pickBestVideoUrl(item);
  if (!url) {
    await log("error", `${shortcode}: tidak ada URL video`);
    return null;
  }

  const outDir = path.join(DOWNLOAD_DIR, owner);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${shortcode}.mp4`);

  await ig.downloadTo(url, filePath);
  const mb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
  const caption = cleanCaption(productInfo?.caption?.text || "");

  const video = await store.upsertVideo({
    owner,
    shortcode,
    mediaId: String(item.pk ?? item.id ?? ""),
    file: filePath,
    caption,
    status: "downloaded",
  });
  await log("download", `@${owner} ${shortcode} terunduh (${mb} MB)`);
  return video;
}

async function processUsername(campaign, user, settings, accounts) {
  if (!user.enabled) {
    return { campaign: campaign.name, username: user.username, skipped: true };
  }

  const summary = {
    campaign: campaign.name,
    username: user.username,
    detected: 0,
    processed: 0,
    queued: 0,
    status: "-",
  };

  // WAJIB REELS: ambil tab Reels (terbaru → terlama).
  let reels = await ig.getProfileReels(user.username, MAX_REEL_PAGES);
  summary.detected = reels.length;

  // Fallback saat tab Reels di-throttle: cari reel dari grid profil.
  if (!reels.length) {
    const posts = await ig.getProfilePosts(user.username, MAX_PROFILE_PAGES);
    summary.detected = posts.length;
    reels = posts.filter((p) => p.productType === "clips");
  }

  const reel = reels[0];
  if (!reel) {
    const msg = summary.detected
      ? `tidak ada reel di ${summary.detected} post terakhir`
      : `data reel tak bisa diambil (rate-limit IG) — dicoba lagi siklus berikutnya`;
    await log("skip", `@${user.username} [${campaign.name}]: ${msg}`);
    return summary;
  }

  const status = await store.deliveryStatusFor(campaign.id, user.username, reel.code);
  if (status === "uploaded") {
    await log("skip", `@${user.username} [${campaign.name}]: reel terakhir ${reel.code} sudah diupload → skip`);
    return summary;
  }

  const video = await ensureVideo(user.username, reel.code);
  if (!video) return summary;

  const caption = cleanCaption(video.caption || "");
  const text = applyTemplate(settings.captionTemplate, {
    caption,
    username: user.username,
    shortcode: reel.code,
  });
  const videoTitle =
    (caption.split("\n").find((l) => l.trim()) || "").slice(0, 100).trim() ||
    `@${user.username} ${reel.code}`;

  if (settings.autoUpload && accounts.length) {
    summary.status = await deliverVideo(video, campaign, accounts, settings, text, videoTitle);
  } else {
    summary.status = "downloaded";
  }

  summary.processed = 1;
  summary.queued = summary.status === "failed" ? 0 : 1;

  if (summary.queued) {
    const merged = [...new Set([...(user.seen || []), reel.code])].slice(-300);
    await store.updateCampaignUsername(campaign.id, user.username, { seen: merged });
  }
  return summary;
}

let running = false;

export async function runAll(trigger = "cron") {
  if (running) {
    await log("skip", `run diabaikan (masih ada proses berjalan) — trigger ${trigger}`);
    return { skipped: true };
  }
  running = true;
  channelCache.clear();
  try {
    const settings = await store.getSettings();
    const campaigns = (await store.listCampaigns()).filter((c) => c.enabled);
    if (!campaigns.length) {
      await log("skip", `tidak ada kampanye aktif (${trigger})`);
      return { results: [] };
    }

    const results = [];
    for (const campaign of campaigns) {
      const accounts = (await store.listBufferAccounts(campaign.id)).filter((a) => a.enabled);
      const users = (await store.listCampaignUsernames(campaign.id)).filter((u) => u.enabled);
      if (!users.length) {
        await log("skip", `Kampanye "${campaign.name}": tidak ada username aktif`);
        continue;
      }
      if (settings.autoUpload && !accounts.length) {
        await log("skip", `Kampanye "${campaign.name}": tidak ada akun Buffer aktif — hanya unduh`);
      }

      const n = users.length;
      const start = (Math.max(0, Number(campaign.rotationIndex) || 0)) % n;
      const order = [...users.slice(start), ...users.slice(0, start)];
      await log(
        "info",
        `Kampanye "${campaign.name}": mulai dari @${order[0].username} (${n} username, ${accounts.length} akun Buffer)`
      );

      for (const user of order) {
        try {
          const res = await processUsername(campaign, user, settings, accounts);
          results.push(res);
        } catch (err) {
          await log("error", `Kampanye "${campaign.name}" @${user.username}: ${err?.message || err}`);
          results.push({
            campaign: campaign.name,
            username: user.username,
            error: err?.message || String(err),
          });
        }
        const idx = users.findIndex((u) => u.username === user.username);
        await store.updateCampaign(campaign.id, { rotationIndex: (idx + 1) % n });
        if (results.at(-1)?.queued > 0) break; // sudah dapat 1 video — lanjut kampanye berikutnya
      }
    }

    await store.updateSettings({ lastRunAt: new Date().toISOString() });
    const queued = results.reduce((acc, r) => acc + (r.queued || 0), 0);
    await log("info", `Siklus selesai (${trigger}) — ${queued} video diproses`);
    return { results };
  } finally {
    running = false;
  }
}
