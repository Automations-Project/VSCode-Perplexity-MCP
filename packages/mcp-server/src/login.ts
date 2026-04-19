/**
 * Browser-based login flow for Perplexity AI.
 * Opens a real browser, lets you log in, then saves full browser state automatically.
 */

import { PerplexityClient } from "./client.js";

async function main(): Promise<void> {
  console.log("🔐 Opening browser for Perplexity login...");
  console.log("   Log in to your account, then the cookies will be extracted automatically.\n");

  const client = new PerplexityClient();
  // Don't call init() — we just want to run the login flow
  const result = await client.loginViaBrowser();

  if (result.success) {
    console.log(`\n✅ ${result.message}`);
  } else {
    console.error(`\n❌ ${result.message}`);
    process.exit(1);
  }

  await client.shutdown();
}

main().catch((err) => {
  console.error("❌ Login failed:", err.message);
  process.exit(1);
});
