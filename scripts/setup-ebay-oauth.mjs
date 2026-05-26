#!/usr/bin/env node
// setup-ebay-oauth.mjs — One-time eBay OAuth bootstrap script
//
// Usage:
//   node scripts/setup-ebay-oauth.mjs
//
// What it does:
//   1. Prompts for eBay developer app credentials (client_id, client_secret, ru_name)
//   2. Generates Authorization Code Grant URL → operator opens in browser
//   3. Receives the `code` from redirect URL (operator pastes it here)
//   4. Exchanges code for access_token + refresh_token
//   5. Inserts/updates ebay_tokens row (id=1) in Supabase
//
// Prerequisites:
//   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars set
//   - eBay developer account with Production app (App ID / Cert ID / RuName)
//   - RuName configured with an Auth Accepted URL
//
// Citation: authorization-guide.txt — The authorization code grant flow

import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function buildAuthUrl({ clientId, ruName, scopes }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: "code",
    scope: scopes.join(" "),
  });
  return `https://auth.ebay.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens({ clientId, clientSecret, ruName, code }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed HTTP ${res.status}: ${body}`);
  }

  return await res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Required scopes for ebay-bridge operations
  const SCOPES = [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
  ];

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.");
    console.error("Set them before running: $env:SUPABASE_URL='https://...' (PowerShell)");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n=== eBay OAuth Bootstrap ===\n");
  console.log("You need your eBay developer app credentials from:");
  console.log("  https://developer.ebay.com/my/keys\n");

  const clientId     = (await prompt(rl, "App ID (Client ID): ")).trim();
  const clientSecret = (await prompt(rl, "Cert ID (Client Secret): ")).trim();
  const ruName       = (await prompt(rl, "RuName (redirect_uri): ")).trim();

  if (!clientId || !clientSecret || !ruName) {
    console.error("All three fields are required.");
    rl.close();
    process.exit(1);
  }

  const authUrl = buildAuthUrl({ clientId, ruName, scopes: SCOPES });

  console.log("\n--- Step 1: Open this URL in your browser ---");
  console.log(authUrl);
  console.log("\nSign in to your eBay seller account and grant the permissions.");
  console.log("After granting, eBay will redirect you to your RuName accept URL.");
  console.log("The redirect URL will contain ?code=<authorization_code>\n");

  const code = (await prompt(rl, "Paste the `code` value from the redirect URL: ")).trim();
  rl.close();

  if (!code) {
    console.error("No code provided.");
    process.exit(1);
  }

  console.log("\n--- Step 2: Exchanging code for tokens ---");

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ clientId, clientSecret, ruName, code });
  } catch (e) {
    console.error("Token exchange failed:", e.message);
    process.exit(1);
  }

  console.log("\nTokens received:");
  console.log("  access_token expires_in:", tokens.expires_in, "seconds");
  console.log("  refresh_token_expires_in:", tokens.refresh_token_expires_in, "seconds (~18 months)");

  const now = Math.floor(Date.now() / 1000);
  const expiryTime = now + (tokens.expires_in || 7200);

  // Upsert ebay_tokens row id=1
  const { error } = await supabase.from("ebay_tokens").upsert({
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_time: expiryTime,
    client_id: clientId,
    client_secret: clientSecret,
    ru_name: ruName,
    marketplace_id: "EBAY_US",
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  if (error) {
    console.error("\nSupabase insert failed:", error.message);
    process.exit(1);
  }

  console.log("\n=== ebay_tokens row (id=1) saved to Supabase ===");
  console.log("Run the ebay-bridge /healthz endpoint to verify the token works.");
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
