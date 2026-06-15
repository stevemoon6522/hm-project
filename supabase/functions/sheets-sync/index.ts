// sheets-sync v1
// Plan: plans/spreadsheet-backup-plan.md (양방향 sync — 사용자 수동 trigger)
//
// Endpoints (all GET to support browser fetch with apikey header):
//   /health                       — health check + which env vars are set
//   /push?table=products          — DB row → Sheet (overwrite tab content)
//   /pull?table=products          — Sheet → DB (apply changes back to DB, with safety)
//   /preview-pull?table=products  — Show what would change if pull executed, no DB write
//
// Required env vars (set via supabase secrets set ...):
//   - GOOGLE_SERVICE_ACCOUNT_JSON: full JSON key of a Google Cloud Service Account
//                                  (with Sheets API access). The SA email must be added
//                                  as Editor of the target Spreadsheet.
//   - SHEETS_SPREADSHEET_ID: ID of the target Google Sheet (from URL).
//
// Whitelisted tables (only these can be synced — extend cautiously):
//   - products (full sync, includes sensitive cost_krw)
//   - product_shopee_listings
//   - country_settings
//
// Pull safety:
//   - Pull diffs sheet rows against DB; applies only changed cells.
//   - For each pull, captures a "before" snapshot into a separate sheet tab
//     "_backup_<timestamp>" so the user can recover if pull was wrong.
//   - Whitelisted writable columns per table (rest are READ-ONLY in the sheet).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const SA_JSON_RAW = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
const SPREADSHEET_ID = Deno.env.get("SHEETS_SPREADSHEET_ID") || "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "3600",
};

// Whitelisted writable columns per table (Sheet → DB).
// Anything outside this list is read-only in the sheet (changes ignored on pull).
// Picked to allow common edits (cost, price, name) but exclude IDs/audit fields.
const WRITABLE_COLUMNS: Record<string, Set<string>> = {
  products: new Set([
    "position",
    "sku",
    "product_name",
    "option_name",
    "cost_krw",
    "weight_g",
    "sourcing_price",
    "lifecycle_state",
    "purpose",
    "tags",
    "description",
    "main_image",
    "staronemall_url",
  ]),
  product_shopee_listings: new Set([
    "shop_item_id",
    "shop_model_id",
    "status",
    "days_to_ship",
    "title_state",
  ]),
  country_settings: new Set([
    "name",
    "exchange_rate",
    "pg_fee",
    "sales_fee",
    "fsp_fee",
    "other_fee",
    "settlement_fee",
    "gst",
    "fsp_ccb",
    "import_duty",
    "fixed_service_fee",
    "purchase_vat",
    "margin_formula",
  ]),
};

// Primary keys per table — Pull uses these to match rows back to DB.
const PRIMARY_KEYS: Record<string, string[]> = {
  products: ["id"],
  product_shopee_listings: ["product_id", "account_key", "region"],
  country_settings: ["country_code"],
};

const TABLE_EXPORT_CONFIG: Record<string, { columns: string[]; labels: Record<string, string> }> = {
  products: {
    columns: [
      "staronemall_url",
      "shopee_item_id",
      "product_name",
      "sku",
      "option_name",
      "sourcing_price",
      "cost_krw",
      "weight_g",
      "position",
      "global_model_id",
      "purpose",
      "lifecycle_state",
      "tags",
      "description",
      "main_image",
      "joom_product_id",
      "joom_status",
      "joom_published_at",
      "created_at",
      "id",
    ],
    labels: {
      staronemall_url: "Staronemall URL",
      shopee_item_id: "Shopee Item ID",
      product_name: "상품명",
      sku: "SKU",
      option_name: "옵션명",
      sourcing_price: "도매가",
      cost_krw: "정산가",
      weight_g: "무게(g)",
      position: "정렬순서",
      global_model_id: "Global Model ID",
      purpose: "용도",
      lifecycle_state: "상태",
      tags: "태그",
      description: "설명",
      main_image: "메인 이미지",
      joom_product_id: "Joom Product ID",
      joom_status: "Joom 상태",
      joom_published_at: "Joom 등록일",
      created_at: "생성일",
      id: "ID",
    },
  },
};

function getOrderedColumns(table: string, allCols: string[]): string[] {
  const config = TABLE_EXPORT_CONFIG[table];
  if (!config) {
    const pks = PRIMARY_KEYS[table];
    const writable = Array.from(WRITABLE_COLUMNS[table] || new Set());
    return [
      ...pks,
      ...writable.filter((c) => !pks.includes(c)),
      ...allCols.filter((c) => !pks.includes(c) && !writable.includes(c)),
    ];
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const col of config.columns) {
    if (allCols.includes(col) && !seen.has(col)) {
      ordered.push(col);
      seen.add(col);
    }
  }
  for (const col of allCols) {
    if (!seen.has(col)) ordered.push(col);
  }
  return ordered;
}

function exportHeaderLabel(table: string, col: string): string {
  const config = TABLE_EXPORT_CONFIG[table];
  if (config?.labels?.[col]) return config.labels[col];
  const pks = PRIMARY_KEYS[table];
  const writable = WRITABLE_COLUMNS[table] || new Set();
  return pks.includes(col) || writable.has(col) ? col : `${col} (read-only)`;
}

function normalizeSheetHeader(table: string, rawHeader: string): string {
  const cleaned = String(rawHeader || "").replace(/ \(read-only\)$/, "").trim();
  if (!cleaned) return cleaned;
  const config = TABLE_EXPORT_CONFIG[table];
  if (!config) return cleaned;
  for (const [col, label] of Object.entries(config.labels)) {
    if (label === cleaned) return col;
  }
  return cleaned;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// Google Service Account JWT → OAuth access token
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  if (!SA_JSON_RAW) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var not set");
  const sa = JSON.parse(SA_JSON_RAW);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (s: string) =>
    btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const headerB64 = enc(JSON.stringify(header));
  const claimB64 = enc(JSON.stringify(claim));
  const signInput = `${headerB64}.${claimB64}`;
  const key = await importPkcs8(sa.private_key);
  const sigBuf = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signInput),
  );
  const sigB64 = enc(String.fromCharCode(...new Uint8Array(sigBuf)));
  const jwt = `${signInput}.${sigB64}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`SA token exchange failed: ${JSON.stringify(j)}`);
  cachedToken = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
  };
  return j.access_token;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ---------------------------------------------------------------------------
// Google Sheets API helpers
// ---------------------------------------------------------------------------

async function sheetsFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

async function ensureSheetExists(sheetName: string): Promise<number> {
  const meta = await sheetsFetch("");
  const found = (meta.sheets || []).find((s: any) => s?.properties?.title === sheetName);
  if (found) return found.properties.sheetId;
  const res = await sheetsFetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    }),
  });
  return res.replies[0].addSheet.properties.sheetId;
}

async function writeSheet(sheetName: string, rows: any[][]): Promise<void> {
  await ensureSheetExists(sheetName);
  // Clear entire sheet first
  await sheetsFetch(`/values/${encodeURIComponent(sheetName)}:clear`, {
    method: "POST",
    body: "{}",
  });
  if (!rows.length) return;
  await sheetsFetch(
    `/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ values: rows }),
    },
  );
}

async function readSheet(sheetName: string): Promise<any[][]> {
  const r = await sheetsFetch(`/values/${encodeURIComponent(sheetName)}`);
  return r.values || [];
}

// ---------------------------------------------------------------------------
// Table → Sheet (push)
// ---------------------------------------------------------------------------

async function pushTable(table: string): Promise<{ rows: number; sheetTab: string }> {
  if (!PRIMARY_KEYS[table]) throw new Error(`table not whitelisted: ${table}`);
  const { data, error } = await supa.from(table).select("*");
  if (error) throw new Error(`DB read ${table} failed: ${error.message}`);
  if (!data || !data.length) {
    await writeSheet(table, [["(no rows)"]]);
    return { rows: 0, sheetTab: table };
  }
  const allCols = Object.keys(data[0]);
  const ordered = getOrderedColumns(table, allCols);
  const header = ordered.map((c) => exportHeaderLabel(table, c));
  const rows = [header, ...data.map((row: any) => ordered.map((c) => formatCell(row[c])))];
  await writeSheet(table, rows);
  return { rows: data.length, sheetTab: table };
}

function formatCell(v: any): any {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Sheet → Table (pull) — with safety
// ---------------------------------------------------------------------------

async function previewPull(table: string): Promise<any> {
  if (!PRIMARY_KEYS[table]) throw new Error(`table not whitelisted: ${table}`);
  const sheetRows = await readSheet(table);
  if (!sheetRows.length) return { table, changes: [], note: "empty sheet" };
  const header = sheetRows[0].map((h: string) => normalizeSheetHeader(table, h));
  const writable = WRITABLE_COLUMNS[table] || new Set();
  const pks = PRIMARY_KEYS[table];

  // Build pk filter from sheet rows
  const pkIdx = pks.map((pk) => header.indexOf(pk));
  if (pkIdx.some((i) => i < 0)) {
    throw new Error(`sheet header missing PK columns ${pks.join(",")}`);
  }
  const sheetByPk = new Map<string, Record<string, string>>();
  for (let i = 1; i < sheetRows.length; i++) {
    const r = sheetRows[i];
    if (!r || !r.length) continue;
    const pkVal = pkIdx.map((idx) => String(r[idx] || "")).join("|");
    if (!pkVal || pkVal === pks.map(() => "").join("|")) continue;
    const obj: Record<string, string> = {};
    header.forEach((c: string, idx: number) => { obj[c] = String(r[idx] || ""); });
    sheetByPk.set(pkVal, obj);
  }

  // Load current DB state for the same PKs
  const { data: dbRows, error } = await supa.from(table).select("*");
  if (error) throw new Error(`DB read ${table} failed: ${error.message}`);
  const dbByPk = new Map<string, any>();
  for (const row of dbRows || []) {
    const pkVal = pks.map((pk) => String(row[pk] || "")).join("|");
    dbByPk.set(pkVal, row);
  }

  const changes: any[] = [];
  for (const [pkVal, sheetRow] of sheetByPk.entries()) {
    const dbRow = dbByPk.get(pkVal);
    if (!dbRow) {
      changes.push({ pk: pkVal, op: "skip_no_db_match", sheet_row: sheetRow });
      continue;
    }
    const cellChanges: any[] = [];
    for (const col of Object.keys(sheetRow)) {
      if (!writable.has(col)) continue;
      const newVal = sheetRow[col] === "" ? null : sheetRow[col];
      const oldVal = dbRow[col];
      // Normalize for comparison
      const oldStr = oldVal === null || oldVal === undefined ? "" : String(oldVal);
      const newStr = newVal === null ? "" : String(newVal);
      if (oldStr !== newStr) {
        cellChanges.push({ col, from: oldStr, to: newStr });
      }
    }
    if (cellChanges.length) {
      changes.push({ pk: pkVal, op: "update", cells: cellChanges });
    }
  }
  return { table, change_count: changes.length, changes };
}

async function pull(table: string): Promise<any> {
  const preview = await previewPull(table);
  const updates = (preview.changes || []).filter((c: any) => c.op === "update");
  if (!updates.length) return { ...preview, applied: 0 };

  // Backup snapshot of current DB state to a backup tab
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupTab = `_backup_${table}_${ts}`;
  try {
    const { data: dbRows } = await supa.from(table).select("*");
    if (dbRows && dbRows.length) {
      const cols = Object.keys(dbRows[0]);
      const header = cols;
      const rows = [header, ...dbRows.map((r: any) => cols.map((c) => formatCell(r[c])))];
      await writeSheet(backupTab, rows);
    }
  } catch (e: any) {
    console.warn("[sheets-sync] backup write failed:", e.message);
  }

  // Apply changes
  const writable = WRITABLE_COLUMNS[table] || new Set();
  const pks = PRIMARY_KEYS[table];
  let applied = 0;
  const errors: string[] = [];
  for (const change of updates) {
    const pkVal = String(change.pk);
    const pkParts = pkVal.split("|");
    const updatePayload: Record<string, any> = {};
    for (const cell of change.cells) {
      if (!writable.has(cell.col)) continue;
      updatePayload[cell.col] = cell.to === "" ? null : cell.to;
    }
    if (!Object.keys(updatePayload).length) continue;
    let q = supa.from(table).update(updatePayload);
    pks.forEach((pk, i) => { q = q.eq(pk, pkParts[i]); });
    const { error } = await q;
    if (error) {
      errors.push(`${pkVal}: ${error.message}`);
    } else {
      applied++;
    }
  }
  return { ...preview, applied, errors, backup_tab: backupTab };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() || "";
  const table = url.searchParams.get("table") || "";

  try {
    if (action === "health") {
      return json({
        ok: true,
        service: "sheets-sync",
        version: 1,
        env: {
          has_GOOGLE_SERVICE_ACCOUNT_JSON: !!SA_JSON_RAW,
          has_SHEETS_SPREADSHEET_ID: !!SPREADSHEET_ID,
        },
        whitelisted_tables: Object.keys(PRIMARY_KEYS),
      });
    }

    if (!SA_JSON_RAW || !SPREADSHEET_ID) {
      return json({
        ok: false,
        error: "missing_credentials",
        hint: "Set GOOGLE_SERVICE_ACCOUNT_JSON and SHEETS_SPREADSHEET_ID via `supabase secrets set ...`",
      }, 500);
    }

    if (action === "push") {
      if (!table) return json({ ok: false, error: "table query param required" }, 400);
      const res = await pushTable(table);
      return json({ ok: true, ...res });
    }

    if (action === "preview-pull") {
      if (!table) return json({ ok: false, error: "table query param required" }, 400);
      const res = await previewPull(table);
      return json({ ok: true, ...res });
    }

    if (action === "pull") {
      if (!table) return json({ ok: false, error: "table query param required" }, 400);
      const res = await pull(table);
      return json({ ok: true, ...res });
    }

    return json({ ok: false, error: `unknown action: ${action}` }, 404);
  } catch (e: any) {
    console.error("[sheets-sync] error", e);
    return json({ ok: false, error: String(e?.message || e), stack: e?.stack }, 500);
  }
});
