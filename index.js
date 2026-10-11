import "dotenv/config";
import path from "node:path";
import express from "express";
import * as store from "./src/store.js";
import * as buffer from "./src/buffer.js";
import { runAll } from "./src/pipeline.js";
import { startScheduler, reschedule, ALLOWED_INTERVALS } from "./src/scheduler.js";

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";

const app = express();
app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.resolve("public")));
app.use("/media", express.static(path.resolve(DOWNLOAD_DIR)));

// ---------- Pages ----------
app.get("/", (req, res) => {
  const videos = store.listVideos();
  const users = store.listUsernames();
  const settings = store.getSettings();
  const counts = {
    usernames: users.length,
    videos: videos.length,
    uploaded: videos.filter((v) => v.status === "uploaded").length,
    partial: videos.filter((v) => v.status === "partial").length,
    failed: videos.filter((v) => v.status === "failed").length,
  };
  res.render("dashboard", {
    title: "Dashboard",
    counts,
    settings,
    videos: videos.slice(-10).reverse(),
    logs: store.getLogs().slice(-30).reverse(),
  });
});

app.get("/usernames", (req, res) => {
  res.render("usernames", {
    title: "Usernames",
    usernames: store.listUsernames(),
  });
});

app.post("/usernames/add", (req, res) => {
  const username = (req.body.username || "").trim().replace(/^@/, "");
  if (username) {
    store.addUsername({ username });
  }
  res.redirect("/usernames");
});

app.post("/usernames/:username/remove", (req, res) => {
  store.removeUsername(req.params.username);
  res.redirect("/usernames");
});

app.post("/usernames/:username/toggle", (req, res) => {
  const u = store.getUsername(req.params.username);
  if (u) store.updateUsername(u.username, { enabled: !u.enabled });
  res.redirect("/usernames");
});

app.get("/videos", (req, res) => {
  res.render("videos", {
    title: "Videos",
    videos: store.listVideos().slice().reverse(),
  });
});

app.get("/settings", (req, res) => {
  res.render("settings", {
    title: "Settings",
    settings: store.getSettings(),
    intervals: ALLOWED_INTERVALS,
  });
});

app.post("/settings", (req, res) => {
  const intervalHours = Number(req.body.intervalHours);
  const fetchBatchSize = Number(req.body.fetchBatchSize);
  const services = [].concat(req.body.services || []).filter(Boolean);
  store.updateSettings({
    intervalHours,
    fetchBatchSize,
    captionTemplate: req.body.captionTemplate || "",
    autoUpload: req.body.autoUpload === "on",
    services,
  });
  reschedule();
  res.redirect("/settings");
});

app.post("/run", async (req, res) => {
  runAll("manual").catch((err) => console.error("[run]", err));
  res.redirect("/");
});

// ---------- API ----------
app.get("/api/usernames", (req, res) => res.json(store.listUsernames()));
app.get("/api/videos", (req, res) => res.json(store.listVideos()));
app.get("/api/settings", (req, res) => res.json(store.getSettings()));
app.get("/api/logs", (req, res) => res.json(store.getLogs()));
app.get("/api/channels", async (req, res) => {
  try {
    res.json(await buffer.getChannels());
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});
app.post("/api/run", async (req, res) => {
  try {
    const result = await runAll("api");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[autoclip] Web berjalan di http://localhost:${PORT}`);
  startScheduler();
});
