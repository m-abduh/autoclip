import cron from "node-cron";
import * as store from "./store.js";
import { runAll } from "./pipeline.js";

export const ALLOWED_INTERVALS = [1, 2, 4, 5, 6, 7, 8];

let tasks = [];

function expressionFor(hours) {
  return `0 */${hours} * * *`;
}

function safeChoice(value, list, fallback) {
  const n = Number(value);
  return list.includes(n) ? n : fallback;
}

export function startScheduler() {
  rebuild().catch((err) => console.error("[scheduler] gagal start:", err.message));
}

export function reschedule() {
  rebuild().catch((err) => console.error("[scheduler] gagal reschedule:", err.message));
}

async function rebuild() {
  tasks.forEach((t) => t.stop());
  tasks = [];

  const settings = await store.getSettings();
  const hours = safeChoice(settings.intervalHours, ALLOWED_INTERVALS, 1);
  const expr = expressionFor(hours);
  if (cron.validate(expr)) {
    tasks.push(
      cron.schedule(expr, () => {
        runAll("cron").catch((err) => console.error("[scheduler] run error:", err));
      })
    );
    console.log(`[scheduler] siklus tiap ${hours} jam (${expr}) — fetch → unduh → upload`);
  }
}

export async function getIntervalHours() {
  const settings = await store.getSettings();
  return safeChoice(settings.intervalHours, ALLOWED_INTERVALS, 1);
}
