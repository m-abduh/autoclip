import "dotenv/config";
import * as store from "./src/store.js";

const args = process.argv.slice(2);
const usernames = args.length ? args : ["memezar", "wasted"];

const campaign = await store.seed({ campaign: "Default", usernames });

console.log(`Seed selesai. Kampanye: ${campaign.name} (#${campaign.id})`);
for (const u of await store.listAllUsernames()) {
  console.log(`  - @${u.username} [${u.campaignName}] (${u.enabled ? "aktif" : "nonaktif"})`);
}
console.log("Settings:", JSON.stringify(await store.getSettings()));

await store.closePool();
