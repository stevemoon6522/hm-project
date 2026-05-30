// @ts-nocheck
// qoo10-bridge — SKU lookup bridge for V2 platform SKU sync.
//
// Endpoints:
//   GET /healthz            — env/API-key readiness check
//   GET /lookup-sku?sku=... — find Qoo10 item by seller product code or option seller code
//
// Important Qoo10 API shape:
// - ItemsLookup.GetAllGoodsInfo is status/page based and returns ItemCode + SellerCode.
// - Option seller codes live in ItemsLookup.GetGoodsInventoryInfo as ItemTypeCode.
//   There is no captured direct lookup by ItemTypeCode, so lookup-sku scans seller
//   inventory pages until it finds an option ItemTypeCode matching the SKU.

import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts";

const QOO10_API_BASE = (Deno as any)["env"]["get"]("QOO10_API_BASE") || "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi";
const QOO10_API_KEY = (Deno as any)["env"]["get"]("QOO10_API_KEY") || (Deno as any)["env"]["get"]("QOO10_CERT_KEY") || "";
const QOO10_SCAN_STATUSES = String((Deno as any)["env"]["get"]("QOO10_SCAN_STATUSES") || "S2,S1,S3,S0")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const QOO10_SCAN_MAX_ITEMS = Number((Deno as any)["env"]["get"]("QOO10_SCAN_MAX_ITEMS") || 3000);

const CORS: Record<string, string> = {
  ...AUTH_CORS,
  "Access-Control-Max-Age": "3600",
};

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function norm(value: unknown): string {
  return String(value || "").trim();
}

function sameSku(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

function qoo10Success(raw: any): boolean {
  const code = firstNonEmpty(raw?.ResultCode, raw?.resultCode, raw?.ResultObject?.ResultCode, raw?.result?.ResultCode);
  if (!code) return true;
  return code === "0" || code.toLowerCase() === "success";
}

function qoo10Message(raw: any): string {
  return firstNonEmpty(raw?.ResultMsg, raw?.resultMsg, raw?.Message, raw?.message, raw?.ErrorMsg, raw?.error);
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function itemRows(raw: any): any[] {
  return [
    raw?.ResultObject?.Items,
    raw?.ResultObject?.Item,
    raw?.ResultObject?.items,
    raw?.ResultObject?.item,
    raw?.Items,
    raw?.Item,
    raw?.items,
    raw?.item,
  ].flatMap(asArray);
}

function inventoryRows(raw: any): any[] {
  return [
    raw?.ResultObject?.Inventory,
    raw?.ResultObject?.Inventories,
    raw?.ResultObject?.Items,
    raw?.ResultObject?.Item,
    raw?.ResultObject,
    raw?.Inventory,
    raw?.Inventories,
    raw?.Items,
    raw?.Item,
    raw?.data,
    raw?.result,
  ].flatMap(asArray);
}

function pageInfo(raw: any) {
  const obj = raw?.ResultObject || raw || {};
  const present = Number(firstNonEmpty(obj.PresentPage, obj.presentPage, obj.Page, obj.page)) || 1;
  const total = Number(firstNonEmpty(obj.TotalPages, obj.totalPages, obj.total_page, obj.totalPage)) || present;
  return { present, total };
}

function normalizeItem(row: any) {
  return {
    itemCode: firstNonEmpty(row?.ItemCode, row?.itemCode, row?.GoodsNo, row?.goodsNo, row?.ItemNo, row?.itemNo),
    sellerCode: firstNonEmpty(row?.SellerCode, row?.sellerCode, row?.seller_code),
    itemStatus: firstNonEmpty(row?.ItemStatus, row?.itemStatus, row?.Status, row?.status),
    raw: row,
  };
}

function normalizeInventory(row: any) {
  return {
    // Qoo10 OptionCode can be an internal option identifier. Only seller-code
    // fields are allowed to satisfy a master SKU match.
    itemTypeCode: firstNonEmpty(row?.ItemTypeCode, row?.itemTypeCode, row?.SellerOptionCode, row?.sellerOptionCode),
    optionCode: firstNonEmpty(row?.OptionCode, row?.optionCode),
    name1: firstNonEmpty(row?.Name1, row?.name1, row?.Name, row?.name),
    value1: firstNonEmpty(row?.Value1, row?.value1, row?.Value, row?.value),
    name2: firstNonEmpty(row?.Name2, row?.name2),
    value2: firstNonEmpty(row?.Value2, row?.value2),
    qty: firstNonEmpty(row?.Qty, row?.qty),
    price: firstNonEmpty(row?.Price, row?.price),
    raw: row,
  };
}

async function qoo10Fetch(command: string, params: Record<string, string>): Promise<{ status: number; raw: any; text: string }> {
  const body = new URLSearchParams({ key: QOO10_API_KEY, returnType: "json", ...params });
  const res = await fetch(`${QOO10_API_BASE}/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const text = await res.text();
  let raw: any = null;
  try { raw = JSON.parse(text); } catch { raw = { raw_text: text }; }
  return { status: res.status, raw, text };
}

function lookupFailureFromRaw(raw: any, fallback = "qoo10_lookup_failed") {
  const message = qoo10Message(raw) || fallback;
  const notFound = /not\s*found|no\s*data|empty|없|존재|fail to find/i.test(message || "");
  return { message, notFound };
}

async function fetchInventoryByItemCode(itemCode: string) {
  const res = await qoo10Fetch("ItemsLookup.GetGoodsInventoryInfo", { ItemCode: itemCode });
  if (res.status < 200 || res.status >= 300) return { ok: false, error: `qoo10_http_${res.status}`, raw: res.raw };
  if (!qoo10Success(res.raw)) {
    const fail = lookupFailureFromRaw(res.raw, "qoo10_inventory_lookup_failed");
    return { ok: false, error: fail.message, notFound: fail.notFound, raw: res.raw };
  }
  return { ok: true, rows: inventoryRows(res.raw).map(normalizeInventory), raw: res.raw };
}

async function lookupByKnownItemCode(sku: string, itemCode: string) {
  const inventory = await fetchInventoryByItemCode(itemCode);
  if (!inventory.ok) return null;
  const match = inventory.rows.find((row: any) => sameSku(row.itemTypeCode, sku));
  if (!match) return null;
  return {
    goods_no: itemCode,
    seller_code: sku,
    option_code: match.itemTypeCode || sku,
    option_name: [match.value1, match.value2].filter(Boolean).join(" / ") || null,
    status: "listed",
    match_type: "option_item_type_code",
    raw: { inventory: inventory.raw, option: match.raw },
  };
}

async function lookupBySellerProductCode(sku: string) {
  const detail = await qoo10Fetch("ItemsLookup.GetItemDetailInfo", { SellerCode: sku });
  if (detail.status < 200 || detail.status >= 300 || !qoo10Success(detail.raw)) return null;
  const rows = inventoryRows(detail.raw).map((row) => ({
    itemCode: firstNonEmpty(row?.ItemCode, row?.itemCode, row?.GoodsNo, row?.goodsNo),
    sellerCode: firstNonEmpty(row?.SellerCode, row?.sellerCode),
    status: firstNonEmpty(row?.ItemStatus, row?.itemStatus) || "listed",
    raw: row,
  }));
  const exact = rows.find((row) => row.itemCode && sameSku(row.sellerCode, sku));
  if (!exact) return null;
  return {
    goods_no: exact.itemCode,
    seller_code: exact.sellerCode || sku,
    option_code: null,
    option_name: null,
    status: exact.status,
    match_type: "seller_product_code",
    raw: { detail: detail.raw },
  };
}

async function scanInventoryForOptionSku(sku: string) {
  let scannedItems = 0;
  const failures: any[] = [];
  for (const status of QOO10_SCAN_STATUSES) {
    let page = 1;
    for (;;) {
      const list = await qoo10Fetch("ItemsLookup.GetAllGoodsInfo", { ItemStatus: status, Page: String(page) });
      if (list.status < 200 || list.status >= 300 || !qoo10Success(list.raw)) {
        failures.push({ status, page, error: qoo10Message(list.raw) || `HTTP ${list.status}` });
        break;
      }
      const items = itemRows(list.raw).map(normalizeItem).filter((row) => row.itemCode);
      for (const item of items) {
        scannedItems += 1;
        if (sameSku(item.sellerCode, sku)) {
          return {
            goods_no: item.itemCode,
            seller_code: item.sellerCode,
            option_code: null,
            option_name: null,
            status: item.itemStatus || status,
            match_type: "seller_product_code_scan",
            raw: { item: item.raw, scanned_items: scannedItems },
          };
        }
        const hit = await lookupByKnownItemCode(sku, item.itemCode);
        if (hit) {
          return {
            ...hit,
            status: item.itemStatus || hit.status || status,
            raw: { ...hit.raw, item: item.raw, scanned_items: scannedItems },
          };
        }
        if (scannedItems >= QOO10_SCAN_MAX_ITEMS) {
          return { notFound: true, scanned_items: scannedItems, failures, stopped: "max_items" };
        }
      }
      const info = pageInfo(list.raw);
      if (!items.length || page >= info.total) break;
      page += 1;
    }
  }
  return { notFound: true, scanned_items: scannedItems, failures };
}

async function handleHealthz(): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, service: "qoo10-bridge", error: "QOO10_API_KEY missing" }, 500);
  return jsonResp({ ok: true, service: "qoo10-bridge", version: 2, key_configured: true, scan_statuses: QOO10_SCAN_STATUSES, api_base: QOO10_API_BASE.replace(/\/[^/]+\.qapi$/, "/<qapi>") });
}

async function handleLookupSku(sku: string, itemCodeParam = ""): Promise<Response> {
  const cleanSku = String(sku || "").trim();
  const knownItemCode = String(itemCodeParam || "").trim();
  if (!cleanSku) return jsonResp({ ok: false, error: "sku query param required" }, 400);
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);

  let hit = knownItemCode ? await lookupByKnownItemCode(cleanSku, knownItemCode) : null;
  if (!hit) hit = await lookupBySellerProductCode(cleanSku);
  if (!hit) hit = await scanInventoryForOptionSku(cleanSku);
  if (!hit || hit.notFound) {
    return jsonResp({ ok: false, error: "qoo10_sku_not_found", sku: cleanSku, ...(hit || {}) }, 404);
  }

  return jsonResp({
    ok: true,
    sku: cleanSku,
    verified_sku: cleanSku,
    goods_no: hit.goods_no,
    seller_code: hit.seller_code || cleanSku,
    option_code: hit.option_code || null,
    option_name: hit.option_name || null,
    status: hit.status || "listed",
    match_type: hit.match_type,
    raw: hit.raw,
  });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() || "";
  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    if (action === "healthz" && req.method === "GET") return await handleHealthz();
    if (action === "lookup-sku" && req.method === "GET") return await handleLookupSku(url.searchParams.get("sku") || "", url.searchParams.get("item_code") || "");
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[qoo10-bridge] error", e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

// @ts-ignore
Deno.serve(handleRequest);
