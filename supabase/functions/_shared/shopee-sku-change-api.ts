// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  BANNED_SHOP_IDS,
  DEFAULT_OPERATING_REGIONS,
  buildCatalogIndex,
  buildCommitBatches,
  extractMappingRows,
  isTransientShopeeError,
  normalizeRegion,
  normalizeShopId,
  stableStringify,
  summarizeStatuses,
  validateSkuMappings,
} from "./sku-change-logic.ts";
import { requireAuthenticatedUser } from "./auth.ts";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const LIVE_HOST = "partner.shopeemobile.com";
const SANDBOX_HOST = "openplatform.sandbox.test-stable.shopee.sg";
const REFRESH_PATH = "/api/v2/auth/access_token/get";
const SKU_CHANGE_SERVICE = "shopee-sku-change";
const DEFAULT_SHOPEE_ACCOUNT_KEY = "starphotocard";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function audit(event, payload = {}) {
  console.log(JSON.stringify({ service: SKU_CHANGE_SERVICE, event, ts: new Date().toISOString(), ...payload }));
}

function host(isSandbox) {
  return isSandbox ? SANDBOX_HOST : LIVE_HOST;
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asEpochSeconds(value) {
  if (!value) return 0;
  if (typeof value === "number") return Math.floor(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.floor(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function getApp() {
  const { data, error } = await supa.from("shopee_app").select("*").eq("id", 1).single();
  if (error || !data) throw new Error(`shopee_app missing: ${error?.message || "not found"}`);
  return {
    ...data,
    partner_id: Number(Deno.env.get("SHOPEE_PARTNER_ID") || data.partner_id),
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || data.partner_key,
  };
}

function isInvalidAccessToken(result) {
  return /invalid_access_token|invalid_acceess_token|shop_access_expired/i.test(`${result?.error || ""} ${result?.message || ""}`);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

async function getTokenRow(region) {
  const { data, error } = await supa.from("shopee_tokens").select("*").eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY).eq("region", region).single();
  if (error || !data) throw new Error(`token row missing for ${region}: ${error?.message || "not found"}`);
  if (!data.shop_id) throw new Error(`shop_id missing in token row for ${region}`);
  if (!data.access_token || !data.refresh_token) throw new Error(`token pair missing for ${region}`);
  return data;
}

async function refreshAccessToken(row, principal = "shop") {
  const app = await getApp();
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${REFRESH_PATH}${ts}`);
  const query = new URLSearchParams({
    partner_id: String(app.partner_id),
    timestamp: String(ts),
    sign,
  });
  const body = {
    refresh_token: row.refresh_token,
    partner_id: Number(app.partner_id),
  };
  if (principal === "merchant") body.merchant_id = Number(row.merchant_id);
  else body.shop_id = Number(row.shop_id);

  // Shopee name: v2.public.refresh_access_token. Path: /api/v2/auth/access_token/get.
  const response = await fetch(`https://${host(app.is_sandbox)}${REFRESH_PATH}?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (json.error || !json.access_token) {
    throw new Error(`refresh_access_token failed: ${json.error || "missing_access_token"} ${json.message || ""}`.trim());
  }
  return {
    ...json,
    expires_at: Math.floor(Date.now() / 1000) + Number(json.expire_in || 14400),
    principal,
  };
}

async function persistShopToken(region, row, token) {
  await supa.from("shopee_tokens").update({
    account_key: DEFAULT_SHOPEE_ACCOUNT_KEY,
    access_token: token.access_token,
    refresh_token: token.refresh_token || row.refresh_token,
    expires_at: token.expires_at,
  }).eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY).eq("region", region);

  await supa.from("shopee_shops").update({
    account_key: DEFAULT_SHOPEE_ACCOUNT_KEY,
    access_token: token.access_token,
    refresh_token: token.refresh_token || row.refresh_token,
    expires_at: new Date(token.expires_at * 1000).toISOString(),
  }).eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY).eq("shop_id", String(row.shop_id));
}

async function getValidShopToken(region) {
  const row = await getTokenRow(region);
  const now = Math.floor(Date.now() / 1000);
  if (asEpochSeconds(row.expires_at) > now + 90) return row;
  const token = await refreshAccessToken(row, "shop");
  await persistShopToken(region, row, token);
  audit("shop_token_refreshed", { region, shop_id: row.shop_id, expire_in: token.expires_at - now });
  return { ...row, access_token: token.access_token, refresh_token: token.refresh_token || row.refresh_token, expires_at: token.expires_at };
}

async function shopApiCall(shop, path, opts = {}) {
  const app = await getApp();
  const callWithToken = async (tokenRow) => {
    const ts = Math.floor(Date.now() / 1000);
    const shopId = String(tokenRow.shop_id);
    if (normalizeShopId(shop.shop_id) !== shopId) {
      return {
        error: "principal_mismatch_region_shop",
        message: `Token row shop_id ${shopId} does not match requested shop_id ${shop.shop_id}.`,
        request_id: null,
      };
    }
    if (BANNED_SHOP_IDS.has(shopId)) {
      return { error: "shop_banned", message: "Banned BR shop is excluded by safety rule.", request_id: null };
    }
    const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${tokenRow.access_token}${shopId}`);
    const query = new URLSearchParams({
      partner_id: String(app.partner_id),
      timestamp: String(ts),
      access_token: tokenRow.access_token,
      shop_id: shopId,
      sign,
    });
    for (const [key, value] of Object.entries(opts.query || {})) {
      if (Array.isArray(value)) {
        for (const v of value) query.append(key, String(v));
      } else if (value !== undefined && value !== null) {
        query.set(key, String(value));
      }
    }
    try {
      const response = await fetch(`https://${host(app.is_sandbox)}${path}?${query}`, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { http_status: response.status, ...(await response.json()) };
    } catch (error) {
      return {
        error: "network_request_failed",
        message: String(error?.message || error || "network error"),
        request_id: null,
      };
    }
  };

  const first = await callWithToken(await getValidShopToken(shop.region));
  if (!isInvalidAccessToken(first)) return first;

  const row = await getTokenRow(shop.region);
  const token = await refreshAccessToken(row, "shop");
  await persistShopToken(shop.region, row, token);
  const second = await callWithToken({ ...row, access_token: token.access_token, refresh_token: token.refresh_token || row.refresh_token, expires_at: token.expires_at });
  return { ...second, retried_after_shop_refresh: true, first_error: first.error || null };
}

async function loadActiveShops(body, mappingRows = []) {
  const requestedRegions = new Set(asArray(body.regions || body.target_regions).map(normalizeRegion).filter(Boolean));
  const requestedShopIds = new Set(asArray(body.shop_ids || body.target_shop_ids).map(normalizeShopId).filter(Boolean));
  for (const row of mappingRows) {
    if (row.region) requestedRegions.add(row.region);
    if (row.shop_id) requestedShopIds.add(row.shop_id);
  }

  const { data: shopRows, error } = await supa
    .from("shopee_shops")
    .select("account_key, shop_id, region, merchant_id, status, shop_name")
    .eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY)
    .order("region", { ascending: true });
  if (error) throw new Error(`load shops failed: ${error.message}`);

  let shops = (shopRows || []).map((s) => ({
    ...s,
    region: normalizeRegion(s.region),
    shop_id: normalizeShopId(s.shop_id),
    status: String(s.status || "active").toLowerCase(),
  })).filter((s) => (
    s.shop_id
    && DEFAULT_OPERATING_REGIONS.includes(s.region)
    && s.status !== "banned"
    && !BANNED_SHOP_IDS.has(s.shop_id)
  ));

  if (requestedRegions.size > 0) shops = shops.filter((s) => requestedRegions.has(s.region));
  if (requestedShopIds.size > 0) shops = shops.filter((s) => requestedShopIds.has(s.shop_id) || requestedRegions.has(s.region));

  if (shops.length === 0) throw new Error("no active in-scope Shopee shops matched request");
  return shops;
}

function normalizeItemStatuses(body) {
  const input = body.item_statuses || body.item_status || ["NORMAL", "UNLIST"];
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean))];
}

async function fetchCatalogForShop(shop, body = {}) {
  const maxItems = Math.max(1, Math.min(Number(body.max_items || 5000), 10000));
  const itemStatuses = normalizeItemStatuses(body);
  const byItemId = new Map();
  const errors = [];

  for (const item_status of itemStatuses) {
    let offset = 0;
    for (let page = 0; page < 100 && byItemId.size < maxItems; page += 1) {
      const result = await shopApiCall(shop, "/api/v2/product/get_item_list", {
        query: { offset, page_size: 100, item_status },
      });
      if (result.error) {
        errors.push({ region: shop.region, shop_id: shop.shop_id, api: "get_item_list", item_status, error: result.error, message: result.message, request_id: result.request_id || null });
        break;
      }
      for (const item of result.response?.item || []) {
        byItemId.set(Number(item.item_id), {
          item_id: Number(item.item_id),
          item_status: item.item_status || item_status,
          update_time: item.update_time || null,
        });
      }
      if (!result.response?.has_next_page) break;
      offset = Number(result.response.next_offset || 0);
      if (!offset) break;
    }
  }

  const itemIds = [...byItemId.keys()].slice(0, maxItems);
  const baseRows = [];
  const catalogRows = [];

  for (let i = 0; i < itemIds.length; i += 50) {
    const ids = itemIds.slice(i, i + 50);
    const result = await shopApiCall(shop, "/api/v2/product/get_item_base_info", {
      query: { item_id_list: ids.join(",") },
    });
    if (result.error) {
      errors.push({ region: shop.region, shop_id: shop.shop_id, api: "get_item_base_info", item_ids: ids, error: result.error, message: result.message, request_id: result.request_id || null });
      continue;
    }
    for (const item of result.response?.item_list || []) {
      baseRows.push(item);
    }
  }

  for (const base of baseRows) {
    const itemId = Number(base.item_id);
    const hasModel = !!base.has_model;
    const itemStatus = base.item_status || byItemId.get(itemId)?.item_status || "";
    const itemName = base.item_name || "";
    if (!hasModel) {
      catalogRows.push({
        region: shop.region,
        shop_id: shop.shop_id,
        item_id: itemId,
        model_id: null,
        has_model: false,
        sku_level: "item",
        item_status: itemStatus,
        item_name: itemName,
        current_sku: base.item_sku || "",
        raw: base,
      });
    }
  }

  const modelItems = baseRows.filter((base) => !!base.has_model);
  for (let i = 0; i < modelItems.length; i += 5) {
    const chunk = modelItems.slice(i, i + 5);
    await Promise.all(chunk.map(async (base) => {
      const itemId = Number(base.item_id);
      const result = await shopApiCall(shop, "/api/v2/product/get_model_list", {
        query: { item_id: itemId },
      });
      if (result.error) {
        errors.push({ region: shop.region, shop_id: shop.shop_id, api: "get_model_list", item_id: itemId, error: result.error, message: result.message, request_id: result.request_id || null });
        return;
      }
      for (const model of result.response?.model || []) {
        catalogRows.push({
          region: shop.region,
          shop_id: shop.shop_id,
          item_id: itemId,
          model_id: Number(model.model_id),
          has_model: true,
          sku_level: "model",
          item_status: base.item_status || byItemId.get(itemId)?.item_status || "",
          item_name: base.item_name || "",
          current_sku: model.model_sku || "",
          raw: { item: base, model },
        });
      }
    }));
  }

  return { shop, rows: catalogRows, errors };
}

async function fetchCatalog(shops, body = {}) {
  const results = [];
  for (const shop of shops) {
    results.push(await fetchCatalogForShop(shop, body));
  }
  return {
    rows: results.flatMap((r) => r.rows),
    errors: results.flatMap((r) => r.errors),
    shop_summaries: results.map((r) => ({ region: r.shop.region, shop_id: r.shop.shop_id, rows: r.rows.length, errors: r.errors.length })),
  };
}

async function fetchCurrentTargets(shops, items) {
  const shopsById = new Map(shops.map((s) => [normalizeShopId(s.shop_id), s]));
  const byShop = new Map();
  for (const item of items) {
    const shopId = normalizeShopId(item.shop_id);
    if (!byShop.has(shopId)) byShop.set(shopId, []);
    byShop.get(shopId).push(item);
  }

  const rows = [];
  const errors = [];
  for (const [shopId, shopItems] of byShop) {
    const shop = shopsById.get(shopId);
    if (!shop) {
      errors.push({ shop_id: shopId, error: "shop_not_found" });
      continue;
    }
    const itemIds = [...new Set(shopItems.map((i) => Number(i.item_id)))];
    const baseById = new Map();
    for (let i = 0; i < itemIds.length; i += 50) {
      const ids = itemIds.slice(i, i + 50);
      const result = await shopApiCall(shop, "/api/v2/product/get_item_base_info", {
        query: { item_id_list: ids.join(",") },
      });
      if (result.error) {
        errors.push({ region: shop.region, shop_id: shopId, api: "get_item_base_info", item_ids: ids, error: result.error, message: result.message, request_id: result.request_id || null });
        continue;
      }
      for (const base of result.response?.item_list || []) baseById.set(Number(base.item_id), base);
    }

    const modelItemIds = [...new Set(shopItems.filter((i) => i.sku_level === "model").map((i) => Number(i.item_id)))];
    const modelsByItem = new Map();
    for (const itemId of modelItemIds) {
      const result = await shopApiCall(shop, "/api/v2/product/get_model_list", { query: { item_id: itemId } });
      if (result.error) {
        errors.push({ region: shop.region, shop_id: shopId, api: "get_model_list", item_id: itemId, error: result.error, message: result.message, request_id: result.request_id || null });
        continue;
      }
      modelsByItem.set(itemId, result.response?.model || []);
    }

    for (const item of shopItems) {
      const base = baseById.get(Number(item.item_id));
      if (!base) continue;
      if (item.sku_level === "item") {
        rows.push({
          region: shop.region,
          shop_id: shopId,
          item_id: Number(item.item_id),
          model_id: null,
          has_model: false,
          sku_level: "item",
          item_status: base.item_status || "",
          item_name: base.item_name || "",
          current_sku: base.item_sku || "",
          raw: base,
        });
      } else {
        const model = (modelsByItem.get(Number(item.item_id)) || []).find((m) => Number(m.model_id) === Number(item.model_id));
        if (!model) continue;
        rows.push({
          region: shop.region,
          shop_id: shopId,
          item_id: Number(item.item_id),
          model_id: Number(item.model_id),
          has_model: true,
          sku_level: "model",
          item_status: base.item_status || "",
          item_name: base.item_name || "",
          current_sku: model.model_sku || "",
          raw: { item: base, model },
        });
      }
    }
  }
  return { rows, errors };
}

async function insertSnapshots(jobId, phase, rows, itemRowsByTarget = new Map()) {
  if (!rows.length) return;
  const payload = rows.map((row) => {
    const itemRow = itemRowsByTarget.get(`${row.shop_id}:${row.item_id}:${row.model_id || 0}`);
    return {
      job_id: jobId,
      item_row_id: itemRow?.id || null,
      snapshot_phase: phase,
      region: row.region,
      shop_id: String(row.shop_id),
      item_id: Number(row.item_id),
      model_id: row.model_id ? Number(row.model_id) : null,
      has_model: !!row.has_model,
      sku_level: row.sku_level,
      sku: row.current_sku ?? row.sku ?? null,
      target_sku: row.new_sku ?? row.target_sku ?? itemRow?.new_sku ?? null,
      item_status: row.item_status || null,
      item_name: row.item_name || null,
      raw: row.raw || row.api_response || {},
      request_id: row.request_id || null,
    };
  });
  const { error } = await supa.from("shopee_sku_snapshots").insert(payload);
  if (error) audit("snapshot_insert_failed", { job_id: jobId, phase, error: error.message });
}

async function selectJobByInput(body) {
  if (body.job_id) {
    const { data, error } = await supa.from("shopee_sku_change_jobs").select("*").eq("id", body.job_id).single();
    if (error || !data) throw new Error(`job not found: ${error?.message || body.job_id}`);
    return data;
  }
  if (body.idempotency_key) {
    const { data, error } = await supa.from("shopee_sku_change_jobs").select("*").eq("idempotency_key", body.idempotency_key).single();
    if (error || !data) throw new Error(`job not found for idempotency_key: ${error?.message || body.idempotency_key}`);
    return data;
  }
  throw new Error("job_id or idempotency_key required");
}

async function createPrepareJob(body, mappingRows, mappingHash, idempotencyKey, shops) {
  const requestedRegions = [...new Set(shops.map((s) => s.region))];
  const requestedShopIds = [...new Set(shops.map((s) => s.shop_id))];
  const payload = {
    idempotency_key: idempotencyKey,
    status: "preparing",
    source: String(body.source || "api"),
    created_by: body.created_by || body.operator_id || null,
    requested_regions: requestedRegions,
    requested_shop_ids: requestedShopIds,
    mapping_hash: mappingHash,
    mapping_payload: { mapping: mappingRows.map((r) => r.raw), csv_present: typeof body.csv === "string" && !!body.csv.trim() },
  };
  const { data, error } = await supa.from("shopee_sku_change_jobs").insert(payload).select("*").single();
  if (!error) return data;
  if (/duplicate key/i.test(error.message)) {
    const { data: existing } = await supa.from("shopee_sku_change_jobs").select("*").eq("idempotency_key", idempotencyKey).single();
    if (existing) return existing;
  }
  throw new Error(`create job failed: ${error.message}`);
}

async function getJobItems(jobId, statuses = null) {
  let q = supa.from("shopee_sku_change_items").select("*").eq("job_id", jobId).order("id", { ascending: true });
  if (statuses) q = q.in("status", statuses);
  const { data, error } = await q;
  if (error) throw new Error(`load job items failed: ${error.message}`);
  return data || [];
}

async function lockJob(job, allowedStatuses, nextStatus, fields = {}) {
  const { data, error } = await supa
    .from("shopee_sku_change_jobs")
    .update({ status: nextStatus, ...fields })
    .eq("id", job.id)
    .in("status", allowedStatuses)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`job status update failed: ${error.message}`);
  return data;
}

async function callWithRetry(action, options) {
  const maxAttempts = Math.max(1, Math.min(Number(options.max_attempts || 3), 5));
  const baseDelayMs = Math.max(100, Math.min(Number(options.retry_base_ms || 700), 10000));
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await action();
    if (!last.error) return { result: last, attempts: attempt };
    if (!isTransientShopeeError(last) || attempt === maxAttempts) return { result: last, attempts: attempt };
    await sleep(baseDelayMs * Math.pow(2, attempt - 1));
  }
  return { result: last, attempts: maxAttempts };
}

function responseRequestId(result) {
  return result?.request_id || result?.response?.request_id || null;
}

function responseWarning(result) {
  return result?.warning || result?.response?.warning || null;
}

async function updateActionItems(action, patch) {
  const ids = action.items.map((i) => Number(i.id)).filter(Boolean);
  if (ids.length === 0) return;
  const { error } = await supa.from("shopee_sku_change_items").update(patch).in("id", ids);
  if (error) throw new Error(`update action items failed: ${error.message}`);
}

export async function handlePrepare(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "method_not_allowed" }, 405);

  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    const body = await req.json();
    const mappingRows = extractMappingRows(body);
    if (mappingRows.length === 0) return jsonResp({ ok: false, error: "mapping or csv required" }, 400);
    const bannedTargets = mappingRows.filter((row) => BANNED_SHOP_IDS.has(normalizeShopId(row.shop_id)));
    if (bannedTargets.length > 0) {
      return jsonResp({
        ok: false,
        error: "shop_banned",
        message: "Banned Shopee shop 1002269093 is excluded from SKU change jobs.",
        banned_shop_id: "1002269093",
        rows: bannedTargets.map((row) => row.client_ref),
      }, 422);
    }
    const shops = await loadActiveShops(body, mappingRows);
    const mappingHash = await sha256Hex({ mappingRows, shops: shops.map((s) => ({ region: s.region, shop_id: s.shop_id })) });
    const idempotencyKey = String(body.idempotency_key || `sku-change:${mappingHash}`).trim();

    const { data: existing } = await supa.from("shopee_sku_change_jobs").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existing && existing.status !== "preparing") {
      return jsonResp({ ok: existing.status === "prepared", reused: true, job: existing, dry_run_report: existing.dry_run_report });
    }

    const job = existing || await createPrepareJob(body, mappingRows, mappingHash, idempotencyKey, shops);
    const catalog = await fetchCatalog(shops, body);
    const validation = validateSkuMappings(mappingRows, catalog.rows, shops);
    const dryRunActions = buildCommitBatches(validation.validItems);
    const dryRunReport = {
      ok: validation.ok && catalog.errors.length === 0,
      safety: {
        banned_shop_excluded: "1002269093",
        sku_max_length: 100,
        duplicate_scope: "per shop target set",
      },
      shops: shops.map((s) => ({ region: s.region, shop_id: s.shop_id, shop_name: s.shop_name || null })),
      catalog: { rows: catalog.rows.length, shop_summaries: catalog.shop_summaries, errors: catalog.errors },
      validation,
      actions: dryRunActions.map((a) => ({
        kind: a.kind,
        endpoint: a.endpoint,
        region: a.region,
        shop_id: a.shop_id,
        item_id: a.item_id,
        row_count: a.items.length,
        payload: a.payload,
      })),
    };

    if (!dryRunReport.ok) {
      await supa.from("shopee_sku_change_jobs").update({
        status: "invalid",
        dry_run_report: dryRunReport,
        error_code: catalog.errors.length ? "catalog_fetch_error" : "validation_error",
        error_message: catalog.errors.length ? "Catalog fetch had Shopee API errors." : "Mapping validation failed.",
        prepared_at: new Date().toISOString(),
      }).eq("id", job.id);
      return jsonResp({ ok: false, job_id: job.id, idempotency_key: idempotencyKey, dry_run_report: dryRunReport }, 422);
    }

    const insertRows = validation.validItems.map((item) => ({
      job_id: job.id,
      client_ref: item.client_ref,
      region: item.region,
      shop_id: item.shop_id,
      item_id: item.item_id,
      model_id: item.model_id,
      has_model: item.has_model,
      sku_level: item.sku_level,
      item_status: item.item_status,
      item_name: item.item_name,
      old_sku: item.old_sku,
      new_sku: item.new_sku,
      status: "pending",
    }));
    const { data: inserted, error: insertError } = await supa.from("shopee_sku_change_items").insert(insertRows).select("*");
    if (insertError) throw new Error(`insert job items failed: ${insertError.message}`);
    const itemRowsByTarget = new Map((inserted || []).map((r) => [`${r.shop_id}:${r.item_id}:${r.model_id || 0}`, r]));
    const catalogByTarget = buildCatalogIndex(catalog.rows);
    const snapshotRows = validation.validItems.map((item) => ({
      ...item,
      current_sku: item.old_sku,
      raw: catalogByTarget.get(`${item.shop_id}:${item.item_id}:${item.model_id || 0}`)?.raw || {},
    }));
    await insertSnapshots(job.id, "prepare", snapshotRows, itemRowsByTarget);

    await supa.from("shopee_sku_change_jobs").update({
      status: "prepared",
      dry_run_report: dryRunReport,
      prepared_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    }).eq("id", job.id);

    return jsonResp({ ok: true, job_id: job.id, idempotency_key: idempotencyKey, dry_run_report: dryRunReport });
  } catch (e) {
    audit("prepare_failed", { error: String(e?.message || e) });
    return jsonResp({ ok: false, error: "prepare_failed", message: String(e?.message || e) }, 500);
  }
}

export async function handleCommit(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "method_not_allowed" }, 405);

  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    const body = await req.json();
    const job = await selectJobByInput(body);
    if (["committed", "verified"].includes(job.status)) {
      return jsonResp({ ok: true, reused: true, job_id: job.id, status: job.status, commit_summary: job.commit_summary });
    }
    if (job.status === "invalid") return jsonResp({ ok: false, error: "job_invalid", job_id: job.id, dry_run_report: job.dry_run_report }, 409);

    const locked = await lockJob(job, ["prepared", "partial_failed"], "committing", { commit_started_at: new Date().toISOString() });
    if (!locked) {
      const latest = await selectJobByInput({ job_id: job.id });
      return jsonResp({ ok: false, error: "job_not_commit_ready", job_id: job.id, status: latest.status }, 409);
    }

    const items = await getJobItems(job.id, ["pending", "failed"]);
    if (items.length === 0) {
      await supa.from("shopee_sku_change_jobs").update({
        status: "committed",
        committed_at: new Date().toISOString(),
        commit_summary: { total: 0, note: "No pending rows; all rows were already committed." },
      }).eq("id", job.id);
      return jsonResp({ ok: true, job_id: job.id, status: "committed", commit_summary: { total: 0 } });
    }

    const shops = await loadActiveShops({
      regions: [...new Set(items.map((i) => i.region))],
      shop_ids: [...new Set(items.map((i) => i.shop_id))],
    }, []);
    const actions = buildCommitBatches(items);
    const batchDelayMs = Math.max(0, Math.min(Number(body.batch_delay_ms || 250), 5000));
    const actionResults = [];

    for (const action of actions) {
      const shop = shops.find((s) => s.shop_id === String(action.shop_id) || s.region === action.region);
      if (!shop) {
        await updateActionItems(action, { status: "failed", error_code: "shop_not_found", error_message: "Active shop row not found during commit." });
        actionResults.push({ ...action, ok: false, error: "shop_not_found" });
        continue;
      }

      await updateActionItems(action, {
        status: "committing",
        api_path: action.endpoint,
        api_payload: action.payload,
        error_code: null,
        error_message: null,
      });
      const { result, attempts } = await callWithRetry(
        () => shopApiCall(shop, action.endpoint, { method: "POST", body: action.payload }),
        body,
      );
      const ok = !result.error;
      const requestId = responseRequestId(result);
      const patch = ok
        ? {
          status: "committed",
          api_response: result,
          request_id: requestId,
          warning: responseWarning(result),
          attempt_count: attempts,
          committed_at: new Date().toISOString(),
          error_code: null,
          error_message: null,
        }
        : {
          status: "failed",
          api_response: result,
          request_id: requestId,
          warning: responseWarning(result),
          attempt_count: attempts,
          error_code: result.error || "api_error",
          error_message: result.message || "Shopee SKU update failed.",
        };
      await updateActionItems(action, patch);
      await insertSnapshots(job.id, "commit", action.items.map((item) => ({
        ...item,
        current_sku: ok ? item.new_sku : item.old_sku,
        target_sku: item.new_sku,
        raw: result,
        request_id: requestId,
      })), new Map(action.items.map((r) => [`${r.shop_id}:${r.item_id}:${r.model_id || 0}`, r])));
      actionResults.push({
        kind: action.kind,
        endpoint: action.endpoint,
        region: action.region,
        shop_id: action.shop_id,
        item_id: action.item_id,
        row_count: action.items.length,
        ok,
        attempts,
        request_id: requestId,
        error: result.error || null,
        message: result.message || null,
      });
      if (batchDelayMs) await sleep(batchDelayMs);
    }

    const allItems = await getJobItems(job.id);
    const statusCounts = summarizeStatuses(allItems);
    const failed = Number(statusCounts.failed || 0);
    const committed = Number(statusCounts.committed || 0) + Number(statusCounts.verified || 0);
    const finalStatus = failed > 0 ? "partial_failed" : "committed";
    const commitSummary = {
      total: allItems.length,
      committed,
      failed,
      status_counts: statusCounts,
      actions: actionResults,
    };
    await supa.from("shopee_sku_change_jobs").update({
      status: finalStatus,
      commit_summary: commitSummary,
      committed_at: finalStatus === "committed" ? new Date().toISOString() : null,
      error_code: failed > 0 ? "partial_failed" : null,
      error_message: failed > 0 ? "One or more Shopee SKU update calls failed." : null,
    }).eq("id", job.id);

    return jsonResp({ ok: failed === 0, job_id: job.id, status: finalStatus, commit_summary: commitSummary }, failed === 0 ? 200 : 207);
  } catch (e) {
    audit("commit_failed", { error: String(e?.message || e) });
    return jsonResp({ ok: false, error: "commit_failed", message: String(e?.message || e) }, 500);
  }
}

export async function handleVerify(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "method_not_allowed" }, 405);

  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    const body = await req.json();
    const job = await selectJobByInput(body);
    if (!["committed", "partial_failed", "verify_failed", "verified"].includes(job.status)) {
      return jsonResp({ ok: false, error: "job_not_verify_ready", job_id: job.id, status: job.status }, 409);
    }

    const locked = job.status === "verified"
      ? job
      : await lockJob(job, ["committed", "partial_failed", "verify_failed"], "verifying", { verify_started_at: new Date().toISOString() });
    if (!locked) {
      const latest = await selectJobByInput({ job_id: job.id });
      return jsonResp({ ok: false, error: "job_verify_lock_failed", job_id: job.id, status: latest.status }, 409);
    }

    const items = await getJobItems(job.id, ["committed", "verified", "verify_failed"]);
    const shops = await loadActiveShops({
      regions: [...new Set(items.map((i) => i.region))],
      shop_ids: [...new Set(items.map((i) => i.shop_id))],
    }, []);
    const current = await fetchCurrentTargets(shops, items);
    const catalog = buildCatalogIndex(current.rows);
    const itemRowsByTarget = new Map(items.map((r) => [`${r.shop_id}:${r.item_id}:${r.model_id || 0}`, r]));
    const verifyRows = [];

    for (const item of items) {
      const key = `${item.shop_id}:${item.item_id}:${item.model_id || 0}`;
      const currentRow = catalog.get(key);
      const currentSku = currentRow?.current_sku ?? null;
      const match = currentSku === item.new_sku;
      verifyRows.push({
        ...item,
        current_sku: currentSku,
        target_sku: item.new_sku,
        raw: currentRow?.raw || { error: "target_not_found_after_commit" },
      });
      await supa.from("shopee_sku_change_items").update({
        status: match ? "verified" : "verify_failed",
        verify_sku: currentSku,
        verify_match: match,
        verified_at: new Date().toISOString(),
        error_code: match ? null : (currentRow ? "sku_mismatch" : "target_not_found_after_commit"),
        error_message: match ? null : `Expected ${item.new_sku}, got ${currentSku ?? "null"}`,
      }).eq("id", item.id);
    }
    await insertSnapshots(job.id, "verify", verifyRows, itemRowsByTarget);

    const allItems = await getJobItems(job.id);
    const statusCounts = summarizeStatuses(allItems);
    const failed = Number(statusCounts.failed || 0) + Number(statusCounts.verify_failed || 0);
    const verified = Number(statusCounts.verified || 0);
    const verifySummary = {
      total: allItems.length,
      verified,
      failed,
      fetch_errors: current.errors,
      status_counts: statusCounts,
    };
    const finalStatus = failed === 0 && current.errors.length === 0 ? "verified" : "verify_failed";
    await supa.from("shopee_sku_change_jobs").update({
      status: finalStatus,
      verify_summary: verifySummary,
      verified_at: finalStatus === "verified" ? new Date().toISOString() : null,
      error_code: finalStatus === "verified" ? null : "verify_failed",
      error_message: finalStatus === "verified" ? null : "SKU verification found mismatches or fetch errors.",
    }).eq("id", job.id);

    return jsonResp({ ok: finalStatus === "verified", job_id: job.id, status: finalStatus, verify_summary: verifySummary }, finalStatus === "verified" ? 200 : 207);
  } catch (e) {
    audit("verify_failed", { error: String(e?.message || e) });
    return jsonResp({ ok: false, error: "verify_failed", message: String(e?.message || e) }, 500);
  }
}
