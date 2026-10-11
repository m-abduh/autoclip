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
  rebuild();
}

export function reschedule() {
  rebuild();
}

function rebuild() {
  tasks.forEach((t) => t.stop());
  tasks = [];

  const hours = safeChoice(store.getSettings().intervalHours, ALLOWED_INTERVALS, 1);
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

export function getIntervalHours() {
  return safeChoice(store.getSettings().intervalHours, ALLOWED_INTERVALS, 1);
}