#!/usr/bin/env node
// setup-ebay-oauth-rest.mjs — dependency-free eBay OAuth bootstrap.
// Uses built-in fetch + Supabase REST API, so @supabase/supabase-js is not required.

import { createInterface } from "node:readline";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
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
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    }).toString(),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    throw new Error(`Token exchange failed HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function upsertTokenRow({ supabaseUrl, serviceRoleKey, row }) {
  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/ebay_tokens?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`Supabase upsert failed HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const SCOPES = [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
  ];

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n=== eBay OAuth Bootstrap (REST, no npm deps) ===\n");
  console.log("Required scopes:");
  for (const scope of SCOPES) console.log(`  - ${scope}`);
  console.log("");

  const clientId = (await prompt(rl, "App ID (Client ID): ")).trim();
  const clientSecret = (await prompt(rl, "Cert ID (Client Secret): ")).trim();
  const ruName = (await prompt(rl, "RuName (redirect_uri): ")).trim();

  if (!clientId || !clientSecret || !ruName) {
    rl.close();
    throw new Error("App ID, Cert ID, and RuName are all required");
  }

  const authUrl = buildAuthUrl({ clientId, ruName, scopes: SCOPES });
  console.log("\n--- Step 1: Open this URL in your browser ---");
  console.log(authUrl);
  console.log("\nSign in to the eBay seller account, approve, then copy only the `code` query value from the redirected URL.\n");

  const rawCodeInput = (await prompt(rl, "Paste the `code` value or the full redirected URL: ")).trim();
  rl.close();
  if (!rawCodeInput) throw new Error("No code provided");

  let code = rawCodeInput;
  if (/^https?:\/\//i.test(rawCodeInput)) {
    const redirectedUrl = new URL(rawCodeInput);
    code = redirectedUrl.searchParams.get("code") || "";
  }
  if (!code) throw new Error("Could not find `code` in input");
  // Browser address bars show the query value URL-encoded (v%5E1.1%23...).
  // URLSearchParams below will encode the form body, so decode once first.
  try { code = decodeURIComponent(code); } catch { /* keep original if malformed */ }

  console.log("\n--- Step 2: Exchanging code for tokens ---");
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, ruName, code });
  const now = Math.floor(Date.now() / 1000);
  const expiryTime = now + (tokens.expires_in || 7200);

  const saved = await upsertTokenRow({
    supabaseUrl,
    serviceRoleKey,
    row: {
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_time: expiryTime,
      client_id: clientId,
      client_secret: clientSecret,
      ru_name: ruName,
      marketplace_id: "EBAY_US",
      updated_at: new Date().toISOString(),
    },
  });

  console.log("\nTokens received and saved to Supabase ebay_tokens id=1.");
  console.log(`access_token expires_in: ${tokens.expires_in || "unknown"} seconds`);
  console.log(`refresh_token_expires_in: ${tokens.refresh_token_expires_in || "unknown"} seconds`);
  console.log(`saved rows: ${Array.isArray(saved) ? saved.length : "unknown"}`);
  console.log("\nDone. Tell Hermes to continue eBay shipping policy creation.");
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
