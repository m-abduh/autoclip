import * as store from "./src/store.js";

const args = process.argv.slice(2);
const usernames = args.length ? args : ["memezar", "wasted"];

store.seed(usernames);

console.log("Seed selesai:");
for (const u of store.listUsernames()) {
  console.log(`  - @${u.username} (${u.enabled ? "aktif" : "nonaktif"})`);
}
console.log("Settings:", JSON.stringify(store.getSettings()));