// @ts-nocheck
// qoo10-bridge — minimal SKU lookup bridge for V2 platform SKU sync.
//
// Endpoints:
//   GET /healthz            — env/API-key readiness check
//   GET /lookup-sku?sku=... — ItemsLookup.GetAllGoodsInfo by SellerCode

import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts";

const QOO10_API_BASE = (Deno as any)["env"]["get"]("QOO10_API_BASE") || "https://api.qoo10.sg/GMKT.INC.Front.QAPIService/Giosis.qapi";
const QOO10_API_KEY = (Deno as any)["env"]["get"]("QOO10_API_KEY") || (Deno as any)["env"]["get"]("QOO10_CERT_KEY") || "";

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

function qoo10Success(raw: any): boolean {
  const code = firstNonEmpty(raw?.ResultCode, raw?.resultCode, raw?.ResultObject?.ResultCode, raw?.result?.ResultCode);
  if (!code) return true;
  return code === "0" || code.toLowerCase() === "success";
}

function qoo10Rows(raw: any): any[] {
  const candidates = [
    raw?.ResultObject,
    raw?.ResultObject?.Items,
    raw?.ResultObject?.Item,
    raw?.Items,
    raw?.Item,
    raw?.data,
    raw?.result,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
  }
  return [];
}

function normalizeRow(row: any, requestedSku: string) {
  const sellerCode = firstNonEmpty(row?.SellerCode, row?.sellerCode, row?.seller_code, row?.SellerCode1, row?.seller_code1);
  const goodsNo = firstNonEmpty(row?.GoodsNo, row?.goodsNo, row?.goods_no, row?.ItemCode, row?.itemCode, row?.ItemNo, row?.itemNo);
  const status = firstNonEmpty(row?.ItemStatus, row?.itemStatus, row?.Status, row?.status, row?.SellStatus, row?.sellStatus) || "listed";
  return {
    sellerCode,
    goodsNo,
    status,
    skuMatches: sellerCode === requestedSku,
  };
}

async function qoo10Fetch(command: string, params: Record<string, string>): Promise<{ status: number; raw: any; text: string }> {
  const qs = new URLSearchParams({ key: QOO10_API_KEY, returnType: "json", ...params });
  const res = await fetch(`${QOO10_API_BASE}/${command}?${qs}`, { method: "GET" });
  const text = await res.text();
  let raw: any = null;
  try { raw = JSON.parse(text); } catch { raw = { raw_text: text }; }
  return { status: res.status, raw, text };
}

async function handleHealthz(): Promise<Response> {
  if (!QOO10_API_KEY) return jsonResp({ ok: false, service: "qoo10-bridge", error: "QOO10_API_KEY missing" }, 500);
  return jsonResp({ ok: true, service: "qoo10-bridge", version: 1, key_configured: true });
}

async function handleLookupSku(sku: string): Promise<Response> {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) return jsonResp({ ok: false, error: "sku query param required" }, 400);
  if (!QOO10_API_KEY) return jsonResp({ ok: false, error: "QOO10_API_KEY missing" }, 500);

  const { status, raw, text } = await qoo10Fetch("ItemsLookup.GetAllGoodsInfo", { SellerCode: cleanSku });
  if (status < 200 || status >= 300) {
    return jsonResp({ ok: false, error: `qoo10_http_${status}`, raw: text.slice(0, 1000) }, status);
  }
  if (!qoo10Success(raw)) {
    const message = firstNonEmpty(raw?.ResultMsg, raw?.resultMsg, raw?.Message, raw?.message, raw?.ErrorMsg, raw?.error);
    const notFound = /not\s*found|no\s*data|empty|없|존재/i.test(message || "");
    return jsonResp({ ok: false, error: message || "qoo10_lookup_failed", raw }, notFound ? 404 : 502);
  }

  const rows = qoo10Rows(raw)
    .map((row) => ({ row, normalized: normalizeRow(row, cleanSku) }))
    .filter(({ normalized }) => normalized.goodsNo);
  const exact = rows.find(({ normalized }) => normalized.skuMatches) || rows[0];
  if (!exact) {
    return jsonResp({ ok: false, error: "qoo10_sku_not_found", sku: cleanSku, raw }, 404);
  }

  return jsonResp({
    ok: true,
    sku: cleanSku,
    goods_no: exact.normalized.goodsNo,
    seller_code: exact.normalized.sellerCode || cleanSku,
    status: exact.normalized.status,
    raw,
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
    if (action === "lookup-sku" && req.method === "GET") return await handleLookupSku(url.searchParams.get("sku") || "");
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[qoo10-bridge] error", e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

// @ts-ignore
Deno.serve(handleRequest);
