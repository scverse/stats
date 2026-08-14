import "dotenv/config";
import { LinkedInDataSchema } from "../types";
import { saveJson } from "../utils";

const COMPANY = "scverse";
const PROFILE_URL = `https://www.linkedin.com/company/${COMPANY}/`;

// LinkedIn serves the follower count to logged-out visitors, but only to clients it takes for a browser.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Deliberately does not match abbreviated counts such as "10K followers": a missing number is better
// than a wrong one, and the field is optional downstream.
const FOLLOWERS = /([\d,.]+)\s*followers/i;

export async function collectLinkedInStats(): Promise<void> {
  console.log("Collecting LinkedIn stats...");

  // There is no public API for this, and LinkedIn blocks some datacentre ranges outright, so a
  // failure here must not take the whole run down. Write nothing and the combiner omits the field.
  try {
    const response = await fetch(PROFILE_URL, {
      headers: {
        "user-agent": BROWSER_USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      console.warn(`LinkedIn returned ${response.status}, skipping follower count`);
      return;
    }

    const match = FOLLOWERS.exec(await response.text());
    if (!match) {
      console.warn("Could not find a follower count on the LinkedIn page, skipping");
      return;
    }

    const validated = LinkedInDataSchema.parse({
      followers_count: Number(match[1].replace(/[,.]/g, "")),
      company: COMPANY,
      timestamp: new Date().toISOString(),
    });

    await saveJson("linkedin.json", validated);
    console.log(`Followers: ${validated.followers_count}`);
  } catch (error) {
    console.warn(`Could not collect LinkedIn stats: ${error}`);
  }
}
