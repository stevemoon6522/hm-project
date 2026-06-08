// @ts-nocheck
// qoo10-bridge: Qoo10 API bridge for V2 platform sync/registration.
//
// Official local docs used:
// - api-refs/marketplaces/qoo10/api-pages/상품-등록/10009-SetNewGoods.md
// - api-refs/marketplaces/qoo10/api-pages/상품-조회/10006-GetSellerDeliveryGroupInfo.md
// - api-refs/marketplaces/qoo10/api-pages/카테고리브랜드/10039-SearchBrand.md
// - api-refs/marketplaces/qoo10/api-pages/상품-수정/10030-EditGoodsHeaderFooter.md

import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts";

// Normalized doc path note: the Qoo10 docs live under
// C:\dev\api-refs\marketplaces\qoo10\api-pages\*\*.md. This bridge uses
// SetNewGoods, GetSellerDeliveryGroupInfo, SearchBrand, EditGoodsHeaderFooter,
// UpdateGoods, EditGoodsContents, and EditGoodsInventory.

const QOO10_API_BASE = (Deno as any).env.get("QOO10_API_BASE") || "https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi";
const QOO10_API_KEY = (Deno as any).env.get("QOO10_API_KEY") || (Deno as any).env.get("QOO10_CERT_KEY") || "";
const QOO10_SCAN_STATUSES = String((Deno as any).env.get("QOO10_SCAN_STATUSES") || "S2,S1,S3,S0")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const QOO10_SCAN_MAX_ITEMS = Number((Deno as any).env.get("QOO10_SCAN_MAX_ITEMS") || 3000);

const CORS: Record<string, string> = { ...AUTH_CORS, "Access-Control-Max-Age": "3600" };

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
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

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function qoo10Success(raw: any): boolean {
  const code = firstNonEmpty(raw?.ResultCode, raw?.resultCode, raw?.ResultObject?.ResultCode, raw?.result?.ResultCode);
  if (!code) return true;
  return code === "0" || code.toLowerCase() === "success";
}

function qoo10Message(raw: any): string {
  return firstNonEmpty(raw?.ResultMsg, raw?.resultMsg, raw?.Message, raw?.message, raw?.ErrorMsg, raw?.error);
}

function qoo10ErrorCode(raw: any): string {
  return firstNonEmpty(raw?.ResultCode, raw?.resultCode, raw?.ResultObject?.ResultCode, raw?.result?.ResultCode);
}

function rowsFrom(raw: any, keys: string[]): any[] {
  const root = raw?.ResultObject || raw || {};
  const values = keys.flatMap((key) => [root?.[key], raw?.[key]]);
  values.push(root);
  return values.flatMap(asArray);
}

function itemRows(raw: any): any[] {
  return rowsFrom(raw, ["Items", "Item", "items", "item"]);
}

function inventoryRows(raw: any): any[] {
  return rowsFrom(raw, ["Inventory", "Inventories", "Items", "Item", "data", "result"]);
}

function shippingRows(raw: any): any[] {
  return rowsFrom(raw, ["DeliveryGroup", "DeliveryGroups", "Shipping", "Shippings", "Items", "Item", "data", "result"]);
}

function brandRows(raw: any): any[] {
  return rowsFrom(raw, ["Brand", "Brands", "Items", "Item", "data", "result"]);
}

function categoryRows(raw: any): any[] {
  return rowsFrom(raw, ["Category", "Categories", "Items", "Item", "data", "result"]);
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

function normalizeShipping(row: any) {
  return {
    shipping_no: firstNonEmpty(row?.ShippingNo, row?.shippingNo, row?.shipping_no),
    shipping_fee: firstNonEmpty(row?.ShippingFee, row?.shippingFee, row?.shipping_fee),
    shipping_type: firstNonEmpty(row?.ShippingType, row?.shippingType, row?.shipping_type),
    free_condition: firstNonEmpty(row?.FreeCondition, row?.freeCondition, row?.free_condition),
    region: firstNonEmpty(row?.Region, row?.region),
    oversea: firstNonEmpty(row?.Oversea, row?.oversea),
    name: firstNonEmpty(row?.transcName, row?.TranscName, row?.Name, row?.name),
    raw: row,
  };
}

function normalizeBrand(row: any) {
  const rawBrandNo = firstNonEmpty(row?.M_B_NO, row?.BrandNo, row?.brandNo, row?.brand_no);
  return {
    brand_no: rawBrandNo.replace(/\D/g, "") || rawBrandNo,
    brand_name: firstNonEmpty(row?.M_B_NM, row?.BrandName, row?.brandName, row?.brand_name),
    brand_name_en: firstNonEmpty(row?.M_B_NM_EN, row?.BrandNameEn, row?.brandNameEn, row?.brand_name_en),
    raw: row,
  };
}

function normalizeCategory(row: any) {
  return {
    large_code: firstNonEmpty(row?.CATE_L_CD, row?.LargeCode, row?.large_code),
    large_name: firstNonEmpty(row?.CATE_L_NM, row?.LargeName, row?.large_name),
    middle_code: firstNonEmpty(row?.CATE_M_CD, row?.MiddleCode, row?.middle_code),
    middle_name: firstNonEmpty(row?.CATE_M_NM, row?.MiddleName, row?.middle_name),
    small_code: firstNonEmpty(row?.CATE_S_CD, row?.SecondSubCat, row?.SmallCode, row?.small_code),
    small_name: firstNonEmpty(row?.CATE_S_NM, row?.SecondSubCatNm, row?.SmallName, row?.small_name),
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
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { raw_text: text };
  }
  return { status: res.status, raw, text };
}

function failureFromRaw(raw: any, fallback = "qoo10_request_failed") {
  return { ok: false, error: qoo10Message(raw) || fallback, result_code: qoo10ErrorCode(raw) || null, raw };
}

function lookupFailureFromRaw(raw: any, fallback = "qoo10_lookup_failed") {
  const message = qoo10Message(raw) || fallback;
  const notFound = /not\s*found|no\s*data|empty|no item|fail to find/i.test(message || "");
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
          return { goods_no: item.itemCode, seller_code: item.sellerCode, option_code: null, option_name: null, status: item.itemStatus || status, match_type: "seller_product_code_scan", raw: { item: item.raw, scanned_items: scannedItems } };
        }
        const hit = await lookupByKnownItemCode(sku, item.itemCode);
        if (hit) return { ...hit, status: item.itemStatus || hit.status || status, raw: { ...hit.raw, item: item.raw, scanned_items: scannedItems } };
        if (scannedItems >= QOO10_SCAN_MAX_ITEMS) return { notFound: true, scanned_items: scannedItems, failures, stopped: "max_items" };
      }
      const info = pageInfo(list.raw);
      if (!items.length || page >= info.total) break;
      page += 1;
    }
  }
  return { notFound: true, scanned_items: scannedItems, failures };
}

function cleanOptionToken(value: unknown, fallback = ""): string {
  return String(value ?? fallback)
    .trim()
    .replace(/\|\|\*/g, " ")
    .replace(/\$\$/g, " ")
    .slice(0, 50)
    .trim();
}

function clampString(value: unknown, max: number): string {
  return String(value || "").trim().slice(0, max);
}

function normalizeQoo10PriceEnding90(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.ceil(n);
  const sameHundred90 = Math.floor(whole / 100) * 100 + 90;
  return whole <= sameHundred90 ? sameHundred90 : sameHundred90 + 100;
}

function normalizeAvailableDate(type: unknown, value: unknown) {
  const t = String(type || "0").trim();
  if (t === "2") {
    const normalized = String(value || "").trim().replace(/-/g, "/");
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(normalized)) {
      throw new Error("Qoo10 release date must be YYYY/MM/DD when AvailableDateType=2");
    }
    return { type: "2", value: normalized };
  }
  return { type: "0", value: String(value || "3").trim() || "3" };
}

function normalizeGoodsNo(raw: any): string {
  return firstNonEmpty(raw?.ResultObject?.GdNo, raw?.ResultObject?.GoodsNo, raw?.ResultObject?.ItemCode, raw?.GdNo, raw?.GoodsNo, raw?.ItemCode);
}

function buildItemType(options: any[], basePrice: number, forceOptions = false) {
  const normalized = (options || [])
    .map((option) => {
      const optionName = cleanOptionToken(option.option_name || option.name || "Type", "Type");
      const optionValue = cleanOptionToken(option.option_value || option.value || option.label || "Default", "Default");
      const price = normalizeQoo10PriceEnding90(option.price_jpy || option.price || basePrice);
      const delta = Math.round(price - basePrice);
      const stock = Math.max(0, Math.floor(Number(option.stock ?? option.qty ?? 0) || 0));
      const sku = cleanOptionToken(option.sku || option.seller_code || "0", "0");
      return { optionName, optionValue, price, delta, stock, sku, product_id: option.product_id || null };
    })
    .filter((option) => option.sku && option.optionValue);
  if (normalized.length < 1 || (!forceOptions && normalized.length <= 1)) return { itemType: "", options: normalized };
  return {
    itemType: normalized.map((option) => [option.optionName, option.optionValue, String(option.delta), String(option.stock), option.sku].join("||*")).join("$$"),
    options: normalized,
  };
}

async function handleHealthz(): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, service: "qoo10-bridge", error: "QOO10_API_KEY missing" }, 500);
  return jsonResp({ ok: true, service: "qoo10-bridge", version: 3, key_configured: true, scan_statuses: QOO10_SCAN_STATUSES, api_base: QOO10_API_BASE.replace(/\/[^/]+\.qapi$/, "/<qapi>") });
}

async function handleLookupSku(sku: string, itemCodeParam = ""): Promise<Response> {
  const cleanSku = String(sku || "").trim();
  const knownItemCode = String(itemCodeParam || "").trim();
  if (!cleanSku) return jsonResp({ ok: false, error: "sku query param required" }, 400);
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);

  let hit = knownItemCode ? await lookupByKnownItemCode(cleanSku, knownItemCode) : null;
  if (!hit) hit = await lookupBySellerProductCode(cleanSku);
  if (!hit) hit = await scanInventoryForOptionSku(cleanSku);
  if (!hit || hit.notFound) return jsonResp({ ok: false, error: "qoo10_sku_not_found", sku: cleanSku, ...(hit || {}) }, 404);

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

async function handleShippingGroups(): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const res = await qoo10Fetch("ItemsLookup.GetSellerDeliveryGroupInfo", {});
  if (res.status < 200 || res.status >= 300) return jsonResp({ ok: false, error: `qoo10_http_${res.status}`, raw: res.raw }, 502);
  if (!qoo10Success(res.raw)) return jsonResp(failureFromRaw(res.raw, "qoo10_shipping_group_lookup_failed"), 502);
  const rows = shippingRows(res.raw).map(normalizeShipping).filter((row) => row.shipping_no);
  return jsonResp({ ok: true, shipping_groups: rows, raw: res.raw });
}

async function handleBrands(keyword: string): Promise<Response> {
  const cleanKeyword = String(keyword || "").trim();
  if (!cleanKeyword) return jsonResp({ ok: false, error: "keyword query param required" }, 400);
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const res = await qoo10Fetch("CommonInfoLookup.SearchBrand", { keyword: cleanKeyword });
  if (res.status < 200 || res.status >= 300) return jsonResp({ ok: false, error: `qoo10_http_${res.status}`, raw: res.raw }, 502);
  if (!qoo10Success(res.raw)) return jsonResp(failureFromRaw(res.raw, "qoo10_brand_lookup_failed"), 502);
  const rows = brandRows(res.raw).map(normalizeBrand).filter((row) => row.brand_no || row.brand_name);
  return jsonResp({ ok: true, brands: rows, raw: res.raw });
}

async function handleCategories(keyword = ""): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const cleanKeyword = String(keyword || "").trim().toLowerCase();
  const res = await qoo10Fetch("CommonInfoLookup.GetCatagoryListAll", {});
  if (res.status < 200 || res.status >= 300) return jsonResp({ ok: false, error: `qoo10_http_${res.status}`, raw: res.raw }, 502);
  if (!qoo10Success(res.raw)) return jsonResp(failureFromRaw(res.raw, "qoo10_category_lookup_failed"), 502);
  let rows = categoryRows(res.raw).map(normalizeCategory).filter((row) => row.small_code);
  if (cleanKeyword) {
    rows = rows.filter((row) => [row.large_name, row.middle_name, row.small_name, row.small_code].join(" ").toLowerCase().includes(cleanKeyword));
  }
  return jsonResp({ ok: true, categories: rows, raw_count: categoryRows(res.raw).length });
}

async function applyHeaderFooter(itemCode: string, sellerCode: string, headerHtml: string) {
  const header = clampString(headerHtml, 2500);
  if (!header) return null;
  const res = await qoo10Fetch("ItemsContents.EditGoodsHeaderFooter", {
    ItemCode: itemCode,
    SellerCode: sellerCode,
    EditHeaderYN: "Y",
    Header: header,
    EditFooterYN: "N",
    Footer: "",
  });
  if (res.status < 200 || res.status >= 300 || !qoo10Success(res.raw)) return failureFromRaw(res.raw, `qoo10_header_footer_http_${res.status}`);
  return { ok: true, raw: res.raw };
}

async function applyGoodsContents(itemCode: string, sellerCode: string, contents: string) {
  const html = String(contents || "").trim();
  if (!html) return null;
  const res = await qoo10Fetch("ItemsContents.EditGoodsContents", {
    ItemCode: itemCode,
    SellerCode: sellerCode,
    Contents: html,
  });
  if (res.status < 200 || res.status >= 300 || !qoo10Success(res.raw)) return failureFromRaw(res.raw, `qoo10_goods_contents_http_${res.status}`);
  return { ok: true, raw: res.raw };
}

async function updateGoodsBasic(body: any) {
  const itemCode = clampString(body.item_code || body.ItemCode, 10);
  const categoryId = clampString(body.category_id || body.SecondSubCat, 20);
  const title = clampString(body.title || body.ItemTitle, 100);
  const sellerCode = clampString(body.seller_code || body.SellerCode, 100);
  const brandNo = clampString(body.brand_no || body.BrandNo, 10).replace(/\D/g, "");
  const shippingNo = clampString(body.shipping_no || body.ShippingNo, 10);
  const weightKg = Math.max(0, Number(body.weight_kg || body.Weight || 0) || 0);
  const available = normalizeAvailableDate(body.available_date_type || body.AvailableDateType, body.available_date_value || body.AvailableDateValue);

  if (!itemCode) throw new Error("ItemCode/item_code required");
  if (!categoryId) throw new Error("SecondSubCat/category_id required");
  if (!title) throw new Error("ItemTitle/title required");

  const params: Record<string, string> = {
    ItemCode: itemCode,
    SecondSubCat: categoryId,
    ItemTitle: title,
    SellerCode: sellerCode,
    ProductionPlaceType: "2",
    ProductionPlace: String(body.production_place || "KR"),
    AdultYN: "N",
    AvailableDateType: available.type,
    AvailableDateValue: available.value,
  };
  if (brandNo) params.BrandNo = brandNo;
  if (shippingNo) params.ShippingNo = shippingNo;
  if (weightKg > 0) params.Weight = weightKg.toFixed(1);
  if (body.keyword) params.Keyword = clampString(body.keyword, 300);

  const res = await qoo10Fetch("ItemsBasic.UpdateGoods", params);
  if (res.status < 200 || res.status >= 300) return { ok: false, error: `qoo10_http_${res.status}`, raw: res.raw };
  if (!qoo10Success(res.raw)) return failureFromRaw(res.raw, "qoo10_update_goods_failed");
  return { ok: true, item_code: itemCode, seller_code: sellerCode || null, raw: res.raw };
}

async function handleUpdateGoods(req: Request): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "JSON body required" }, 400);
  const result = await updateGoodsBasic(body);
  if (!result?.ok) return jsonResp(result || { ok: false, error: "qoo10_update_goods_failed" }, 502);
  return jsonResp(result);
}

async function handleEditContents(req: Request): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "JSON body required" }, 400);
  const itemCode = clampString(body.item_code || body.ItemCode, 10);
  const sellerCode = clampString(body.seller_code || body.SellerCode, 100);
  const contents = String(body.contents || body.Contents || body.description || "").trim();
  if (!itemCode) return jsonResp({ ok: false, error: "ItemCode/item_code required" }, 400);
  if (!contents) return jsonResp({ ok: false, error: "Contents/contents required" }, 400);
  const result = await applyGoodsContents(itemCode, sellerCode, contents);
  if (!result?.ok) return jsonResp(result || { ok: false, error: "qoo10_goods_contents_failed" }, 502);
  return jsonResp({ ok: true, item_code: itemCode, seller_code: sellerCode || null, raw: result.raw });
}

async function handleHeaderFooter(req: Request): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "JSON body required" }, 400);
  const itemCode = clampString(body.item_code || body.ItemCode, 10);
  const sellerCode = clampString(body.seller_code || body.SellerCode, 100);
  const headerHtml = String(body.header_html || body.Header || "").trim();
  if (!itemCode) return jsonResp({ ok: false, error: "ItemCode/item_code required" }, 400);
  if (!headerHtml) return jsonResp({ ok: false, error: "Header/header_html required" }, 400);
  const result = await applyHeaderFooter(itemCode, sellerCode, headerHtml);
  if (!result?.ok) return jsonResp(result || { ok: false, error: "qoo10_header_footer_failed" }, 502);
  return jsonResp({ ok: true, item_code: itemCode, seller_code: sellerCode || null, raw: result.raw });
}

async function handleEditInventory(req: Request): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "JSON body required" }, 400);

  const itemCode = clampString(body.item_code || body.ItemCode, 10);
  const sellerCode = clampString(body.seller_code || body.SellerCode, 100);
  const basePrice = normalizeQoo10PriceEnding90(body.base_price_jpy || body.item_price_jpy || body.ItemPrice);
  const itemTypeResult = buildItemType(Array.isArray(body.options) ? body.options : [], basePrice, true);
  if (!itemCode) return jsonResp({ ok: false, error: "ItemCode/item_code required" }, 400);
  if (!basePrice) return jsonResp({ ok: false, error: "base_price_jpy required to calculate Qoo10 option price deltas" }, 400);
  if (!itemTypeResult.itemType) return jsonResp({ ok: false, error: "options required for InventoryInfo" }, 400);

  const res = await qoo10Fetch("ItemsOptions.EditGoodsInventory", {
    ItemCode: itemCode,
    SellerCode: sellerCode,
    InventoryInfo: itemTypeResult.itemType,
  });
  if (res.status < 200 || res.status >= 300) return jsonResp({ ok: false, error: `qoo10_http_${res.status}`, raw: res.raw }, 502);
  if (!qoo10Success(res.raw)) return jsonResp(failureFromRaw(res.raw, "qoo10_edit_inventory_failed"), 502);

  const inventory = await fetchInventoryByItemCode(itemCode);
  const expectedSkus = new Set(itemTypeResult.options.map((option) => option.sku));
  const verifiedOptions = inventory.ok
    ? inventory.rows.filter((row: any) => expectedSkus.has(row.itemTypeCode))
    : [];
  const missingSkus = [...expectedSkus].filter((sku) => !verifiedOptions.some((row: any) => sameSku(row.itemTypeCode, sku)));

  return jsonResp({
    ok: missingSkus.length === 0,
    item_code: itemCode,
    seller_code: sellerCode || null,
    inventory_info: itemTypeResult.itemType,
    options: itemTypeResult.options,
    verified_options: verifiedOptions,
    missing_skus: missingSkus,
    raw: res.raw,
    inventory_raw: inventory.ok ? inventory.raw : inventory,
  }, missingSkus.length === 0 ? 200 : 502);
}

async function handleCreateListing(req: Request): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "JSON body required" }, 400);

  const categoryId = clampString(body.category_id || body.SecondSubCat, 9);
  const title = clampString(body.title || body.ItemTitle, 100);
  const sellerCode = clampString(body.seller_code || body.SellerCode, 100);
  const brandNo = clampString(body.brand_no || body.BrandNo, 10).replace(/\D/g, "");
  const shippingNo = clampString(body.shipping_no || body.ShippingNo, 10);
  const imageUrl = clampString(body.main_image || body.StandardImage, 200);
  const description = String(body.description || body.ItemDescription || "").trim();
  const basePrice = normalizeQoo10PriceEnding90(body.base_price_jpy || body.item_price_jpy || body.ItemPrice);
  const itemTypeResult = buildItemType(Array.isArray(body.options) ? body.options : [], basePrice, body.force_options === true);
  const optionStock = itemTypeResult.options.reduce((sum, option) => sum + option.stock, 0);
  const stock = Math.max(0, Math.floor(Number(body.stock ?? body.ItemQty ?? optionStock) || 0));
  const weightKg = Math.max(0, Number(body.weight_kg || body.Weight || 0) || 0);
  const available = normalizeAvailableDate(body.available_date_type || body.AvailableDateType, body.available_date_value || body.AvailableDateValue);

  if (!categoryId || categoryId.length !== 9) return jsonResp({ ok: false, error: "SecondSubCat/category_id must be a 9-digit Qoo10 category code" }, 400);
  if (!title) return jsonResp({ ok: false, error: "ItemTitle/title required" }, 400);
  if (!sellerCode) return jsonResp({ ok: false, error: "SellerCode/seller_code required" }, 400);
  if (!basePrice) return jsonResp({ ok: false, error: "ItemPrice/base_price_jpy required" }, 400);
  if (!shippingNo) return jsonResp({ ok: false, error: "ShippingNo/shipping_no required; select a registered Qoo10 shipping template" }, 400);
  if (!stock && itemTypeResult.options.length <= 1) return jsonResp({ ok: false, error: "ItemQty/stock required" }, 400);

  const params: Record<string, string> = {
    SecondSubCat: categoryId,
    ItemTitle: title,
    SellerCode: sellerCode,
    ProductionPlaceType: "2",
    ProductionPlace: String(body.production_place || "KR"),
    AdultYN: "N",
    RetailPrice: String(Math.max(0, Math.round(Number(body.retail_price_jpy || body.RetailPrice || 0) || 0))),
    ItemPrice: String(basePrice),
    TaxRate: String(body.tax_rate || body.TaxRate || "S"),
    ItemQty: String(stock || optionStock),
    ExpireDate: String(body.expire_date || body.ExpireDate || "2030-12-31"),
    ShippingNo: shippingNo,
    AvailableDateType: available.type,
    AvailableDateValue: available.value,
  };
  if (brandNo) params.BrandNo = brandNo;
  if (weightKg > 0) params.Weight = weightKg.toFixed(1);
  if (imageUrl) params.StandardImage = imageUrl;
  if (description) params.ItemDescription = description;
  if (itemTypeResult.itemType) params.ItemType = itemTypeResult.itemType;
  if (body.keyword) params.Keyword = clampString(body.keyword, 300);

  const res = await qoo10Fetch("ItemsBasic.SetNewGoods", params);
  if (res.status < 200 || res.status >= 300) return jsonResp({ ok: false, error: `qoo10_http_${res.status}`, raw: res.raw }, 502);
  if (!qoo10Success(res.raw)) return jsonResp(failureFromRaw(res.raw, "qoo10_create_listing_failed"), 502);
  const goodsNo = normalizeGoodsNo(res.raw);
  if (!goodsNo) return jsonResp({ ok: false, error: "qoo10_create_listing_missing_goods_no", raw: res.raw }, 502);

  const headerResult = await applyHeaderFooter(goodsNo, sellerCode, String(body.header_html || ""));
  return jsonResp({
    ok: true,
    goods_no: goodsNo,
    platform_item_id: goodsNo,
    seller_code: sellerCode,
    options: itemTypeResult.options,
    raw: res.raw,
    header_result: headerResult,
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
    if (action === "shipping-groups" && req.method === "GET") return await handleShippingGroups();
    if (action === "brands" && req.method === "GET") return await handleBrands(url.searchParams.get("keyword") || "");
    if (action === "categories" && req.method === "GET") return await handleCategories(url.searchParams.get("keyword") || "");
    if (action === "create-listing" && req.method === "POST") return await handleCreateListing(req);
    if (action === "update-goods" && req.method === "POST") return await handleUpdateGoods(req);
    if (action === "edit-contents" && req.method === "POST") return await handleEditContents(req);
    if (action === "edit-inventory" && req.method === "POST") return await handleEditInventory(req);
    if (action === "header-footer" && req.method === "POST") return await handleHeaderFooter(req);
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[qoo10-bridge] error", e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

Deno.serve(handleRequest);
