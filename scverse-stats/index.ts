import "dotenv/config";
import { collectGitHubStats } from "./collectors/gitHubCollector";
import { collectZulipStats } from "./collectors/zulipCollector";
import { collectZulipActivityStats } from "./collectors/zulipActivityCollector";
import { collectBlueskyStats } from "./collectors/blueskyCollector";
import { collectLinkedInStats } from "./collectors/linkedinCollector";
import { collectEcosystemStats } from "./collectors/ecosystemCollector";
import { collectCitationStats } from "./collectors/citationsCollector";
import { collectPepyStats } from "./collectors/pepyCollector";
import { combineStats } from "./combiner";

async function main() {
  console.log("Collecting scverse statistics...\n");

  await Promise.all([
    collectGitHubStats(),
    collectZulipStats(),
    collectZulipActivityStats(),
    collectBlueskyStats(),
    collectLinkedInStats(),
    collectEcosystemStats(),
    collectCitationStats(),
    collectPepyStats(),
  ]);

  console.log("\nCombining statistics...");
  await combineStats();

  console.log("Done!");
}

main();
