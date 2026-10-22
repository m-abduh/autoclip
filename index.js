import "dotenv/config";
import path from "node:path";
import express from "express";
import * as store from "./src/store.js";
import * as buffer from "./src/buffer.js";
import { runAll } from "./src/pipeline.js";
import { startScheduler, reschedule, ALLOWED_INTERVALS } from "./src/scheduler.js";

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.resolve("public")));
app.use("/media", express.static(path.resolve(DOWNLOAD_DIR)));

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
  next();
});

// Bungkus handler async agar error-nya masuk ke error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function accountView(account) {
  return {
    id: account.id,
    campaignId: account.campaignId,
    label: account.label,
    enabled: account.enabled,
    masked: store.maskKey(account.apiKey),
    createdAt: account.createdAt,
  };
}

// ---------- Dashboard ----------

app.get(
  "/",
  ah(async (req, res) => {
    const [analytics, campaigns, videos, deliveries, logs, settings] = await Promise.all([
      store.getAnalytics(),
      store.listCampaigns(),
      store.listVideos(8),
      store.listDeliveries({ limit: 200 }),
      store.getLogs(25),
      store.getSettings(),
    ]);

    res.render("dashboard", {
      title: "Dashboard",
      analytics,
      campaigns,
      videos,
      deliveries,
      logs,
      settings,
      hasPublicUrl: !!PUBLIC_BASE_URL,
    });
  })
);

// ---------- Kampanye ----------

app.get(
  "/campaigns",
  ah(async (req, res) => {
    const [campaigns, analytics] = await Promise.all([
      store.listCampaigns(),
      store.getAnalytics(),
    ]);
    res.render("campaigns", {
      title: "Kampanye",
      campaigns,
      stats: analytics.byCampaign,
    });
  })
);

app.post(
  "/campaigns/add",
  ah(async (req, res) => {
    const name = (req.body.name || "").trim();
    try {
      if (name) await store.addCampaign({ name });
    } catch (err) {
      console.error("[campaigns] add:", err.message);
    }
    res.redirect("/campaigns");
  })
);

app.post(
  "/campaigns/:id/toggle",
  ah(async (req, res) => {
    const c = await store.getCampaign(req.params.id);
    if (c) await store.updateCampaign(c.id, { enabled: !c.enabled });
    res.redirect("/campaigns");
  })
);

app.post(
  "/campaigns/:id/rename",
  ah(async (req, res) => {
    const name = (req.body.name || "").trim();
    if (name) await store.updateCampaign(req.params.id, { name });
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/remove",
  ah(async (req, res) => {
    await store.removeCampaign(req.params.id);
    res.redirect("/campaigns");
  })
);

app.get(
  "/campaigns/:id",
  ah(async (req, res) => {
    const campaign = await store.getCampaign(req.params.id);
    if (!campaign) return res.status(404).render("404", { title: "Tidak ditemukan" });

    const [accounts, usernames, deliveries, analytics] = await Promise.all([
      store.listBufferAccounts(campaign.id),
      store.listCampaignUsernames(campaign.id),
      store.listDeliveries({ campaignId: campaign.id, limit: 50 }),
      store.getAnalytics(),
    ]);

    res.render("campaign", {
      title: campaign.name,
      campaign,
      accounts: accounts.map(accountView),
      usernames,
      deliveries,
      campaignStats: analytics.byCampaign.find((c) => c.id === campaign.id) || null,
      accountStats: analytics.byAccount,
      hasPublicUrl: !!PUBLIC_BASE_URL,
    });
  })
);

app.post(
  "/campaigns/:id/accounts/add",
  ah(async (req, res) => {
    const label = (req.body.label || "").trim();
    const apiKey = (req.body.apiKey || "").trim();
    try {
      if (apiKey) await store.addBufferAccount({ campaignId: req.params.id, label, apiKey });
    } catch (err) {
      console.error("[accounts] add:", err.message);
    }
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/accounts/:accountId/toggle",
  ah(async (req, res) => {
    const acc = await store.getBufferAccount(req.params.accountId);
    if (acc) await store.updateBufferAccount(acc.id, { enabled: !acc.enabled });
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/accounts/:accountId/remove",
  ah(async (req, res) => {
    await store.removeBufferAccount(req.params.accountId);
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/usernames/add",
  ah(async (req, res) => {
    const username = (req.body.username || "").trim().replace(/^@/, "");
    if (username) await store.addCampaignUsername(req.params.id, username);
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/usernames/:username/toggle",
  ah(async (req, res) => {
    const u = await store.getCampaignUsername(req.params.id, req.params.username);
    if (u) await store.updateCampaignUsername(u.campaignId, u.username, { enabled: !u.enabled });
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

app.post(
  "/campaigns/:id/usernames/:username/remove",
  ah(async (req, res) => {
    await store.removeCampaignUsername(req.params.id, req.params.username);
    res.redirect(`/campaigns/${req.params.id}`);
  })
);

// ---------- Videos / Usernames / Analytics ----------

app.get(
  "/videos",
  ah(async (req, res) => {
    const [videos, deliveries, campaigns] = await Promise.all([
      store.listVideos(300),
      store.listDeliveries({ limit: 1000 }),
      store.listCampaigns(),
    ]);
    const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
    res.render("videos", {
      title: "Videos",
      videos,
      deliveries,
      campaignNames,
    });
  })
);

app.get(
  "/usernames",
  ah(async (req, res) => {
    const [usernames, campaigns] = await Promise.all([
      store.listAllUsernames(),
      store.listCampaigns(),
    ]);
    res.render("usernames", { title: "Usernames", usernames, campaigns });
  })
);

app.get(
  "/analytics",
  ah(async (req, res) => {
    const analytics = await store.getAnalytics();
    res.render("analytics", { title: "Analytics", analytics });
  })
);

// ---------- Settings ----------

app.get(
  "/settings",
  ah(async (req, res) => {
    const settings = await store.getSettings();
    res.render("settings", {
      title: "Settings",
      settings,
      intervals: ALLOWED_INTERVALS,
      hasPublicUrl: !!PUBLIC_BASE_URL,
    });
  })
);

app.post(
  "/settings",
  ah(async (req, res) => {
    const services = [].concat(req.body.services || []).filter(Boolean);
    await store.updateSettings({
      intervalHours: Number(req.body.intervalHours),
      fetchBatchSize: Number(req.body.fetchBatchSize),
      captionTemplate: req.body.captionTemplate || "",
      autoUpload: req.body.autoUpload === "on",
      services,
    });
    reschedule();
    res.redirect("/settings");
  })
);

app.post(
  "/run",
  ah(async (req, res) => {
    runAll("manual").catch((err) => console.error("[run]", err));
    res.redirect("/");
  })
);

app.post(
  "/logs/clear",
  ah(async (req, res) => {
    await store.clearLogs();
    res.redirect("/");
  })
);

// ---------- API ----------

app.get("/api/campaigns", ah(async (req, res) => res.json(await store.listCampaigns())));

app.get(
  "/api/campaigns/:id",
  ah(async (req, res) => {
    const campaign = await store.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Kampanye tidak ditemukan" });
    const [accounts, usernames, deliveries] = await Promise.all([
      store.listBufferAccounts(campaign.id),
      store.listCampaignUsernames(campaign.id),
      store.listDeliveries({ campaignId: campaign.id, limit: 100 }),
    ]);
    res.json({
      campaign,
      accounts: accounts.map(accountView),
      usernames,
      deliveries,
    });
  })
);

app.get("/api/analytics", ah(async (req, res) => res.json(await store.getAnalytics())));
app.get("/api/videos", ah(async (req, res) => res.json(await store.listVideos(500))));
app.get("/api/deliveries", ah(async (req, res) => res.json(await store.listDeliveries({ limit: 500 }))));
app.get("/api/logs", ah(async (req, res) => res.json(await store.getLogs(100))));
app.get("/api/settings", ah(async (req, res) => res.json(await store.getSettings())));

app.get(
  "/api/channels",
  ah(async (req, res) => {
    const accountId = req.query.accountId;
    let token;
    if (accountId) {
      const acc = await store.getBufferAccount(accountId);
      if (!acc) return res.status(404).json({ error: "Akun Buffer tidak ditemukan" });
      token = acc.apiKey;
    }
    res.json(await buffer.getChannels(token));
  })
);

app.post(
  "/api/run",
  ah(async (req, res) => {
    const result = await runAll("api");
    res.json(result);
  })
);

// ---------- Error handler ----------

app.use((err, req, res, next) => {
  console.error("[web]", err);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
  res.status(500).send(`<pre>Error: ${err?.message || err}</pre>`);
});

app.listen(PORT, () => {
  console.log(`[autoclip] Web berjalan di http://localhost:${PORT}`);
  startScheduler();
});
