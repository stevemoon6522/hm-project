// v42: (1) /poll-shop: check status='banned' before polling.
//      (2) pollShop: detect permanent shop errors (banned/unauthorized/not_found)
//          from Shopee API, auto-mark shop as banned, return gracefully instead of throwing.
//      (3) freshToken: detect permanent refresh errors, auto-mark shop as banned.
//      v41 base: include gift items (main_item===false && price===0) in marketplace_order_items.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"GET, POST, OPTIONS" };
const HOST_DEF = "https://partner.shopeemobile.com";
const REGIONS = ["SG","MY","TW","TH","PH","ID","VN","BR","MX","CL","CO","AR","PE","PL","ES","FR","IN"] as const;
type Region = typeof REGIONS[number];
function hostFor(_r: string){ return HOST_DEF; }

const PARTNER_ID  = Deno.env.get("SHOPEE_PARTNER_ID") || "";
const PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
const REDIRECT    = Deno.env.get("SHOPEE_REDIRECT_URL") || "";
const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supa = createClient(SUPA_URL, SUPA_KEY, { auth:{ persistSession:false } });

const LABEL_ELIGIBLE = new Set(["READY_TO_SHIP","PROCESSED","RETRY_SHIP"]);
const SHIPPED_DONE = new Set(["SHIPPED","COMPLETED","TO_CONFIRM_RECEIVE"]);
const EXCLUDED = new Set(["UNPAID","IN_CANCEL","INVOICE_PENDING"]);
const CANCELLED_S = new Set(["CANCELLED"]);
const SHIP_DONE = new Set(["SHIPPED","PROCESSED","COMPLETED","TO_CONFIRM_RECEIVE","IN_CANCEL"]);

function mapStatus(s: string): "pending"|"shipped"|"cancelled"|"excluded"|"unknown" {
  if (LABEL_ELIGIBLE.has(s)) return "pending";
  if (SHIPPED_DONE.has(s)) return "shipped";
  if (EXCLUDED.has(s)) return "excluded";
  if (CANCELLED_S.has(s)) return "cancelled";
  return "unknown";
}

// Detect permanent shop-level errors that indicate the shop is banned/revoked.
// These should not be retried — mark the shop as banned and stop polling.
function isPermanentShopError(err?: string, msg?: string): boolean {
  const s = `${err||""} ${msg||""}`.toLowerCase();
  return /shop_banned|shop_not_found|shopee_shop_banned|unauthorised_shop|shop_account_frozen|account_frozen|shop_frozen|error_auth|auth_error|invalid_access_token|access_token_expired_or_invalid|access_denied/.test(s)
    || /error_code.*["']?(banned|frozen|not_found|not_exist)["']?/.test(s);
}

async function markShopBanned(shopId: string, reason: string) {
  await supa.from("shopee_shops").update({ status: "banned" }).eq("shop_id", shopId);
  console.warn(`[shopee-orders] shop ${shopId} marked as banned: ${reason}`);
}

async function hmac(k: string, m: string){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(m));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function sP(p: string, t: number){ return await hmac(PARTNER_KEY, PARTNER_ID+p+t); }
async function sS(p: string, t: number, at: string, sid: number|string){ return await hmac(PARTNER_KEY, PARTNER_ID+p+t+at+sid); }
const sleep = (ms: number)=>new Promise(r=>setTimeout(r, ms));

function isTransient(err?: string, msg?: string): boolean {
  const s = `${err||""} ${msg||""}`;
  return /system_error|service_unavailable|temporarily|server_error|internal_error|timeout|network|too_many_request|rate_limit/i.test(s);
}

async function decrementStockForShopeeOrder(externalId: string): Promise<{ ran: boolean; items: any[]; reason?: string }> {
  const { data: ord } = await supa.from("marketplace_orders")
    .select("id, stock_decremented_at").eq("marketplace","shopee").eq("external_id", externalId).maybeSingle();
  if (!ord) return { ran: false, items: [], reason: "order not found" };
  if (ord.stock_decremented_at) return { ran: false, items: [], reason: "already decremented" };
  const { data: items } = await supa.from("marketplace_order_items")
    .select("id, sku, variant_sku, qty").eq("order_id", ord.id);
  if (!items || items.length === 0) return { ran: false, items: [], reason: "no items" };
  const results: any[] = [];
  for (const it of items) {
    const sku = (it as any).sku || (it as any).variant_sku || "";
    const qty = (it as any).qty || 1;
    if (!sku) { results.push({ sku: "", qty, matched: false, reason: "empty sku" }); continue; }
    const { data: rpcRows, error: rpcErr } = await supa.rpc("decrement_inventory_bundle", { p_parent_sku: sku, p_qty: qty, p_warehouse: "kr" });
    if (rpcErr) { results.push({ sku, qty, matched: false, reason: rpcErr.message }); continue; }
    const r = (rpcRows as any[])?.[0] || { parent_matched: false, is_bundle: false, components: [] };
    const isBundle = !!r.is_bundle;
    const components: any[] = Array.isArray(r.components) ? r.components : [];
    for (const comp of components) {
      await supa.from("stock_decrements").insert({
        marketplace: "shopee", external_id: externalId,
        sku: comp.sku, qty: comp.qty, warehouse: "kr",
        inventory_id: comp.inventory_id || null,
        before_stock: comp.before_stock ?? null,
        after_stock: comp.after_stock ?? null,
        matched: !!comp.matched,
        bundle_parent_sku: isBundle ? sku : null,
      });
    }
    results.push({
      sku, qty, is_bundle: isBundle, parent_matched: !!r.parent_matched,
      components: components.map((c: any) => ({ sku: c.sku, qty: c.qty, matched: !!c.matched, before: c.before_stock, after: c.after_stock, needs_reorder: c.needs_reorder })),
    });
  }
  const anyMatched = results.some((r: any) => !!r.parent_matched);
  if (anyMatched) {
    await supa.from("marketplace_orders").update({ stock_decremented_at: new Date().toISOString() })
      .eq("marketplace","shopee").eq("external_id", externalId);
  }
  return { ran: anyMatched, items: results };
}

async function shopInfo(host: string, at: string, sid: string|number){
  const p="/api/v2/shop/get_shop_info"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  try { const j=await(await fetch(url)).json(); if(j.error) return { error:`${j.error} ${j.message||""}`.trim() }; return { region:j.region, shop_name:j.shop_name, merchant_id:j.merchant_id }; } catch(e){ return { error:(e as Error).message }; }
}

async function _refreshCall(host: string, refresh_token: string, body_extra: any) {
  const p="/api/v2/auth/access_token/get"; const t=Math.floor(Date.now()/1000); const sig=await sP(p,t);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}`;
  const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ partner_id: Number(PARTNER_ID), refresh_token, ...body_extra })
  });
  return await r.json();
}

async function freshToken(shop: any): Promise<string>{
  const now = Math.floor(Date.now()/1000);
  const exp = Math.floor(new Date(shop.expires_at).getTime()/1000);
  if (exp - now > 60) return shop.access_token;
  const host = hostFor(shop.region);
  let merchantErr: string | null = null;
  if (shop.merchant_id) {
    try {
      const j = await _refreshCall(host, shop.refresh_token, { merchant_id: Number(shop.merchant_id) });
      if (!j.error && j.access_token) {
        const ne = new Date((Math.floor(Date.now()/1000) + (j.expire_in||14400))*1000).toISOString();
        await supa.from("shopee_shops").update({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: ne })
          .eq("merchant_id", shop.merchant_id).eq("status", "active");
        await syncTokensFromShopsTable().catch(()=>{});
        return j.access_token;
      }
      merchantErr = `${j.error||"unknown"} ${j.message||""}`.trim();
      // If permanent error, mark banned immediately
      if (isPermanentShopError(j.error, j.message)) {
        await markShopBanned(shop.shop_id, `refresh merchant failed: ${merchantErr}`);
        throw new Error(`shop_banned: refresh permanently failed for shop ${shop.shop_id}: ${merchantErr}`);
      }
    } catch (e: any) {
      if (e?.message?.startsWith("shop_banned:")) throw e;
      merchantErr = `network: ${e?.message || e}`;
    }
  }
  try {
    const j = await _refreshCall(host, shop.refresh_token, { shop_id: Number(shop.shop_id) });
    if (j.error || !j.access_token) {
      const merchantNote = merchantErr ? ` (merchant attempt: ${merchantErr})` : "";
      const fullErr = `${j.error||"no_token"} ${j.message||""}${merchantNote}`;
      // If permanent error, mark banned
      if (isPermanentShopError(j.error, j.message)) {
        await markShopBanned(shop.shop_id, `refresh shop failed: ${fullErr}`);
        throw new Error(`shop_banned: refresh permanently failed for shop ${shop.shop_id}: ${fullErr}`);
      }
      throw new Error(`refresh failed: ${fullErr}`);
    }
    const ne = new Date((Math.floor(Date.now()/1000) + (j.expire_in||14400))*1000).toISOString();
    await supa.from("shopee_shops").update({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: ne })
      .eq("shop_id", shop.shop_id);
    return j.access_token;
  } catch (e: any) {
    if (e?.message && (e.message.startsWith("refresh failed") || e.message.startsWith("shop_banned:"))) throw e;
    throw new Error(`refresh failed: ${e?.message || e}`);
  }
}

async function syncTokensFromShopsTable(){
  const { data: shops, error } = await supa.from("shopee_shops").select("shop_id, region, merchant_id, access_token, refresh_token, expires_at, last_polled_at, status").eq("status", "active");
  if (error) throw new Error(error.message);
  if (!shops || shops.length===0) return { synced: 0 };
  const score = (s: any) => {
    const polled = s.last_polled_at ? new Date(s.last_polled_at).getTime() : 0;
    const exp = s.expires_at ? new Date(s.expires_at).getTime() : 0;
    return polled * 1e6 + exp;
  };
  const byRegion = new Map<string, any>();
  for (const s of shops) {
    const cur = byRegion.get(s.region);
    if (!cur || score(s) > score(cur)) byRegion.set(s.region, s);
  }
  let count = 0;
  const picks: any[] = [];
  for (const [region, s] of byRegion) {
    const expSec = Math.floor(new Date(s.expires_at).getTime()/1000);
    const row = {
      region, shop_id: Number(s.shop_id), merchant_id: s.merchant_id,
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: expSec, is_sandbox: false,
    };
    const { error: ue } = await supa.from("shopee_tokens").upsert(row, { onConflict: "region" });
    if (!ue) { count++; picks.push({ region, shop_id: s.shop_id, last_polled_at: s.last_polled_at }); }
  }
  return { synced: count, regions: Array.from(byRegion.keys()), picks };
}

async function authUrl(region: string){
  if (!REGIONS.includes(region as Region)) throw new Error(`unsupported region: ${region}`);
  if (!REDIRECT) throw new Error("SHOPEE_REDIRECT_URL secret not set");
  const p="/api/v2/shop/auth_partner"; const t=Math.floor(Date.now()/1000); const sig=await sP(p,t);
  return `${hostFor(region)}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&redirect=${encodeURIComponent(REDIRECT)}`;
}

async function orderDetail(host:string, at:string, sid:string|number, sn:string){
  const p="/api/v2/order/get_order_detail"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}&order_sn_list=${encodeURIComponent(sn)}&response_optional_fields=order_status,package_list`;
  return await(await fetch(url)).json();
}
async function batchOrderStatus(host:string, at:string, sid:string|number, sns:string[]): Promise<Map<string,string>>{
  const out = new Map<string,string>();
  for (let i=0; i<sns.length; i+=50) {
    const chunk = sns.slice(i, i+50);
    const p="/api/v2/order/get_order_detail"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
    const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}&order_sn_list=${chunk.join(",")}&response_optional_fields=order_status`;
    try {
      const j = await(await fetch(url)).json();
      for (const d of (j.response?.order_list||[])) out.set(d.order_sn, d.order_status);
    } catch {}
  }
  return out;
}
async function shipParam(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const p="/api/v2/logistics/get_shipping_parameter"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}&order_sn=${encodeURIComponent(sn)}`+(pkg?`&package_number=${encodeURIComponent(pkg)}`:"");
  return await(await fetch(url)).json();
}
async function trackNum(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const p="/api/v2/logistics/get_tracking_number"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}&order_sn=${encodeURIComponent(sn)}`+(pkg?`&package_number=${encodeURIComponent(pkg)}`:"");
  return await(await fetch(url)).json();
}
async function docParam(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const p="/api/v2/logistics/get_shipping_document_parameter"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  return await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ order_list:[{ order_sn:sn, ...(pkg?{package_number:pkg}:{}) }] })})).json();
}
async function shipOrderRaw(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const param=await shipParam(host,at,sid,sn,pkg);
  const body:any={ order_sn:sn }; if(pkg) body.package_number=pkg;
  const need=param?.response?.info_needed||{}; const dr=param?.response?.dropoff||{}; const pu=param?.response?.pickup||{};
  if("dropoff" in need){ const bid=dr?.branch_list?.[0]?.branch_id; body.dropoff=bid?{ branch_id:bid }:{}; }
  else if("pickup" in need){ const aid=pu?.address_list?.[0]?.address_id; const tid=pu?.address_list?.[0]?.time_slot_list?.[0]?.pickup_time_id; body.pickup={ ...(aid?{address_id:aid}:{}), ...(tid?{pickup_time_id:tid}:{}) }; }
  else if("non_integrated" in need){ body.non_integrated={}; }
  else { body.dropoff={}; }
  const p="/api/v2/logistics/ship_order"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  const j=await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) })).json();
  return { request:body, response:j, param };
}
async function shipOrderWithRetry(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const delays = [0, 400, 1100];
  let last: any = null;
  for (let i=0; i<delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      const r = await shipOrderRaw(host, at, sid, sn, pkg);
      const e = r.response?.error, m = r.response?.message;
      if (!e) return r;
      if (!isTransient(e, m)) return r;
      last = r;
    } catch (e:any) {
      const msg = String(e?.message || e);
      last = { request:{}, response:{ error:"network_error", message:msg }, param:null };
      if (!isTransient("network_error", msg)) return last;
    }
  }
  return last;
}
async function createDocRaw(host:string, at:string, sid:string|number, sn:string, pkg:string|undefined, tn:string|undefined, dt:string){
  const p="/api/v2/logistics/create_shipping_document"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  const item:any={ order_sn:sn, shipping_document_type:dt }; if(pkg) item.package_number=pkg; if(tn) item.tracking_number=tn;
  return await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ order_list:[item] }) })).json();
}
async function docResultRaw(host:string, at:string, sid:string|number, sn:string, pkg:string|undefined, dt:string){
  const p="/api/v2/logistics/get_shipping_document_result"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  return await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ order_list:[{ shipping_document_type:dt, order_sn:sn, ...(pkg?{package_number:pkg}:{}) }] }) })).json();
}
async function downloadDoc(host:string, at:string, sid:string|number, sn:string, pkg:string|undefined, dt:string){
  const p="/api/v2/logistics/download_shipping_document"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}`;
  return await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ order_list:[{ order_sn:sn, ...(pkg?{package_number:pkg}:{}) }], shipping_document_type:dt }) });
}

function isPkgNotNeeded(e?:string,m?:string){ const s=`${e||""} ${m||""}`; return /not_need_(package|pacakge|pacage|pakage)_number|don[''`]?t.{0,5}request.{0,15}package_number|unsplit/i.test(s); }
function isPkgRelDoc(e?:string,m?:string){ const s=`${e||""} ${m||""}`; return /tracking_number_invalid|package_number_invalid|invalid_package/i.test(s); }
function extractFail(d:any){ const i=d?.response?.result_list?.[0]; if(i?.fail_error||i?.fail_message) return { error:i.fail_error, message:i.fail_message }; return { error:d?.error, message:d?.message }; }

async function liveStatus(host:string, at:string, sid:string|number, sn:string){ const j=await orderDetail(host,at,sid,sn); if(j.error) return null; return j.response?.order_list?.[0]?.order_status||null; }

async function tryShip(host:string, at:string, sid:string, sn:string, pkg?:string, ls?:string|null){
  if (ls && SHIP_DONE.has(ls)) return { ok:true, skipped:true, status:ls, used_pkg:pkg, fresh:false };
  if (ls && (CANCELLED_S.has(ls) || EXCLUDED.has(ls))) return { ok:false, skipped:true, error:"not_eligible", message:`status=${ls}`, used_pkg:pkg };
  let p=pkg; let r=await shipOrderWithRetry(host,at,sid,sn,p); let e=r.response?.error, m=r.response?.message;
  if(isPkgNotNeeded(e,m) && p){ p=undefined; r=await shipOrderWithRetry(host,at,sid,sn,undefined); e=r.response?.error; m=r.response?.message; }
  const benign=/already|shipped|order_status_invalid|not.{0,5}ready.{0,5}to.{0,5}ship|not.{0,5}eligible/i.test(`${e||""} ${m||""}`);
  if(e && !benign) return { ok:false, step:"ship_order", error:e, message:m, raw:r, used_pkg:p };
  return { ok:true, raw:r, used_pkg:p, fresh:!e };
}

async function chooseDocType(host:string, at:string, sid:string|number, sn:string, pkg?:string){
  const param=await docParam(host,at,sid,sn,pkg);
  const i=param?.response?.result_list?.[0];
  return { type: i?.suggest_shipping_document_type || i?.selectable_shipping_document_type?.[0] || "NORMAL_AIR_WAYBILL", param };
}

async function fetchTracking(sid:string, sn:string, pkg?:string){
  const ext = `shopee:${sid}:${sn}`;
  const { data: ex } = await supa.from("marketplace_orders").select("id, tracking_number, raw_payload").eq("external_id", ext).maybeSingle();
  if (ex?.tracking_number) return { ok:true, tracking_number: ex.tracking_number, cached:true };
  const cachedPkg = pkg || (ex?.raw_payload as any)?.package_number || undefined;
  const { data: shop, error } = await supa.from("shopee_shops").select("*").eq("shop_id", sid).single();
  if (error||!shop) return { ok:false, error: "shop not found" };
  const at = await freshToken(shop);
  const host = hostFor(shop.region);
  const tj = await trackNum(host, at, shop.shop_id, sn, cachedPkg);
  const tn = tj?.response?.tracking_number;
  if (tj.error || !tn) return { ok:false, error: tj.error || "no tracking_number returned" };
  await supa.from("marketplace_orders").update({ tracking_number: tn }).eq("external_id", ext);
  return { ok:true, tracking_number: tn, cached:false };
}

async function fetchLabel(sid:string, sn:string, pkg?:string): Promise<Response>{
  const { data:shop, error } = await supa.from("shopee_shops").select("*").eq("shop_id", sid).single();
  if(error||!shop) return j({ error:"shop not found" }, 404);
  const at=await freshToken(shop); const host=hostFor(shop.region);
  const ls=await liveStatus(host,at,shop.shop_id,sn);
  if(ls && EXCLUDED.has(ls)) return j({ error:"not_label_eligible", message:`${ls}는 라벨 출력 대상이 아닙니다`, live_status:ls }, 400);
  if(ls==="CANCELLED") return j({ error:"cancelled_order", message:"취소된 주문", live_status:ls }, 400);
  const sr=await tryShip(host,at,shop.shop_id,sn,pkg,ls);
  if((sr as any).ok===false) return j({ error:`ship_order: ${(sr as any).error}`, message:(sr as any).message, live_status:ls }, 502);
  const up=(sr as any).used_pkg;
  if((sr as any).fresh) await sleep(1500);
  const [dt, tj] = await Promise.all([
    chooseDocType(host,at,shop.shop_id,sn,up),
    trackNum(host,at,shop.shop_id,sn,up).catch(()=>null),
  ]);
  const docType = dt.type;
  const tn: string|undefined = (tj as any)?.response?.tracking_number || undefined;
  if (tn) { try { await supa.from("marketplace_orders").update({ tracking_number: tn }).eq("external_id", `shopee:${shop.shop_id}:${sn}`); } catch {} }
  const tryDl=async(pp?:string)=>{ const r=await downloadDoc(host,at,shop.shop_id,sn,pp,docType); const ct=r.headers.get("content-type")||""; if(!ct.includes("application/json")) return { ok:true as const, response:r }; const jj=await r.json(); return { ok:false as const, error:jj.error, message:jj.message }; };
  let dl = await tryDl(up);
  if (dl.ok) { const buf=await dl.response.arrayBuffer(); await supa.from("marketplace_orders").update({ label_printed_at: new Date().toISOString() }).eq("external_id", `shopee:${shop.shop_id}:${sn}`); return new Response(buf, { status:200, headers:{ ...CORS, "Content-Type":"application/pdf" } }); }
  let p2=up; let cR=await createDocRaw(host,at,shop.shop_id,sn,p2,tn,docType); let cf=extractFail(cR);
  if((isPkgNotNeeded(cf.error,cf.message)||isPkgRelDoc(cf.error,cf.message)) && p2){ p2=undefined; cR=await createDocRaw(host,at,shop.shop_id,sn,undefined,tn,docType); cf=extractFail(cR); }
  let last:any=null;
  for(let a=0;a<8;a++){ await sleep(700); const rr=await docResultRaw(host,at,shop.shop_id,sn,p2,docType); last=rr; const it=rr?.response?.result_list?.[0]; if(it?.status==="READY") break; if(it?.status==="FAILED") return j({ error:"shipping_document_failed", detail:it, debug:{ create:cR, doc_type:docType } }, 502); }
  dl = await tryDl(p2);
  if (!dl.ok && p2) { const d2=await tryDl(undefined); if (d2.ok) dl = d2; }
  if(dl.ok){ const buf=await dl.response.arrayBuffer(); await supa.from("marketplace_orders").update({ label_printed_at: new Date().toISOString() }).eq("external_id", `shopee:${shop.shop_id}:${sn}`); return new Response(buf, { status:200, headers:{ ...CORS, "Content-Type":"application/pdf" } }); }
  return j({ error:`download: ${dl.error}`, message:dl.message, live_status:ls, doc_type:docType, debug:{ create:cR, last_status:last?.response?.result_list?.[0], tracking_number:tn } }, 502);
}

async function arrangeOrders(orders:{shop_id:string,order_sn:string,package_number?:string}[]){
  const byShop = new Map<string, typeof orders>();
  for (const o of orders) { const k = String(o.shop_id); if (!byShop.has(k)) byShop.set(k, []); byShop.get(k)!.push(o); }
  const allResults: any[] = [];
  for (const [shopId, group] of byShop) {
    const { data: shop, error } = await supa.from("shopee_shops").select("*").eq("shop_id", shopId).single();
    if (error || !shop) { for (const o of group) allResults.push({ ...o, ok:false, error:"shop not found" }); continue; }
    const at = await freshToken(shop);
    const host = hostFor(shop.region);
    const statusMap = await batchOrderStatus(host, at, shop.shop_id, group.map(o=>o.order_sn));
    const BATCH = 3;
    for (let i=0; i<group.length; i+=BATCH) {
      const batch = group.slice(i, i+BATCH);
      const out = await Promise.all(batch.map(async (o) => {
        try {
          const ls = statusMap.get(o.order_sn) || null;
          const extId = `shopee:${shop.shop_id}:${o.order_sn}`;
          if (ls && SHIP_DONE.has(ls)) {
            const { data: ex } = await supa.from("marketplace_orders").select("id, raw_payload").eq("external_id", extId).maybeSingle();
            if (ex) {
              const newRaw = { ...(ex.raw_payload as any), order_status: ls };
              await supa.from("marketplace_orders").update({ status: "pending", raw_payload: newRaw }).eq("id", ex.id);
            }
            const stock = await decrementStockForShopeeOrder(extId).catch((e) => ({ ran: false, items: [], reason: String(e?.message||e) }));
            return { ...o, ok:true, skipped:true, live_status:ls, stock };
          }
          if (ls && (CANCELLED_S.has(ls) || EXCLUDED.has(ls))) {
            return { ...o, ok:false, skipped:true, error:"not_eligible", live_status:ls };
          }
          const sr = await tryShip(host, at, shop.shop_id, o.order_sn, o.package_number, ls);
          if ((sr as any).ok === false) return { ...o, ok:false, step:"ship_order", error:(sr as any).error, message:(sr as any).message, live_status:ls };
          const { data: ex } = await supa.from("marketplace_orders").select("id, raw_payload, shipped_at").eq("external_id", extId).maybeSingle();
          if (ex) {
            let newOrderStatus: string;
            if ((sr as any).fresh) {
              newOrderStatus = "PROCESSED";
            } else {
              const realStatus = await liveStatus(host, at, shop.shop_id, o.order_sn);
              newOrderStatus = realStatus || ls || (ex.raw_payload as any)?.order_status || "READY_TO_SHIP";
            }
            const newRaw = { ...(ex.raw_payload as any), order_status: newOrderStatus };
            const newMapped = mapStatus(newOrderStatus);
            const newStatus = newMapped === "shipped" ? "shipped" : "pending";
            const upd: any = { raw_payload: newRaw, status: newStatus };
            if (newMapped === "shipped" && !(ex as any).shipped_at) upd.shipped_at = new Date().toISOString();
            if (newStatus === "pending") upd.shipped_at = null;
            await supa.from("marketplace_orders").update(upd).eq("id", ex.id);
          }
          const stock = await decrementStockForShopeeOrder(extId).catch((e) => ({ ran: false, items: [], reason: String(e?.message||e) }));
          return { ...o, ok:true, used_pkg:(sr as any).used_pkg, skipped:(sr as any).skipped||false, fresh:(sr as any).fresh, stock };
        } catch (e:any) { return { ...o, ok:false, error:String(e?.message||e) }; }
      }));
      allResults.push(...out);
    }
  }
  const success = allResults.filter(r=>r.ok).length;
  const skipped = allResults.filter(r=>r.skipped).length;
  const apiCalls = allResults.filter(r=>!r.skipped).length;
  return { ok:true, total:allResults.length, success, skipped, api_calls:apiCalls, failed:allResults.length-success, results:allResults };
}

async function handleCallbackShop(code:string, sid:string, region:string){
  const p="/api/v2/auth/token/get"; const t=Math.floor(Date.now()/1000); const sig=await sP(p,t); const host=hostFor(region);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}`;
  const r=await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ code, shop_id:Number(sid), partner_id:Number(PARTNER_ID) }) })).json();
  if(r.error) return html(`<h2>인증 실패</h2><pre>${esc(JSON.stringify(r,null,2))}</pre>`);
  const ea=new Date((t+(r.expire_in||14400))*1000).toISOString();
  const info=await shopInfo(host,r.access_token,sid);
  const fr=(info as any).region;
  if (!fr || !REGIONS.includes(fr as Region)) {
    return html(`<h2>Region 확인 실패</h2><p>shop_id=${sid}의 실제 region을 확인하지 못해 저장을 중단했습니다.</p><pre>${esc(JSON.stringify(info,null,2))}</pre>`);
  }
  const merchant_id = (r.merchant_id_list||[])[0] || (info as any)?.merchant_id || null;
  const { data: existing } = await supa.from("shopee_shops").select("status").eq("shop_id", String(sid)).maybeSingle();
  if (existing && existing.status === "banned") {
    return html(`<h2>이 샵은 영구 정지(banned) 상태입니다</h2><p>shop_id=${sid} — 재인증 무시됨.</p>`);
  }
  const { error }=await supa.from("shopee_shops").upsert({ shop_id:String(sid), region:fr, shop_name:(info as any).shop_name||null, access_token:r.access_token, refresh_token:r.refresh_token, expires_at:ea, status:"active", authorized_at:new Date().toISOString(), merchant_id }, { onConflict:"shop_id" });
  if(error) return html(`<h2>저장 실패</h2><pre>${esc(error.message)}</pre>`);
  return html(`<h2>✅ 연동 완료</h2><script>setTimeout(()=>window.close(),1500);</script>`);
}

async function handleCallbackMain(code:string, mid:string, region:string){
  const p="/api/v2/auth/token/get"; const t=Math.floor(Date.now()/1000); const sig=await sP(p,t); const host=hostFor(region);
  const url=`${host}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}`;
  const r=await(await fetch(url,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ code, main_account_id:Number(mid), partner_id:Number(PARTNER_ID) }) })).json();
  if(r.error||!r.access_token) return html(`<h2>토큰 교환 실패</h2><pre>${esc(JSON.stringify(r,null,2))}</pre>`);
  const sl:any[]=r.shop_id_list||[]; if(sl.length===0) return html(`<h2>샵 없음</h2>`);
  const ea=new Date((t+(r.expire_in||14400))*1000).toISOString(); const ni=new Date().toISOString();
  const merchant_id = (r.merchant_id_list||[])[0] || null;
  const { data: bannedRows } = await supa.from("shopee_shops").select("shop_id").eq("status", "banned");
  const bannedSet = new Set((bannedRows||[]).map((b:any) => String(b.shop_id)));
  const enr:any[]=[]; const skipped:any[]=[]; const unresolved:any[]=[];
  for(const s of sl){
    if (bannedSet.has(String(s))) { skipped.push({ shop_id: String(s), reason: "banned" }); continue; }
    const info=await shopInfo(host,r.access_token,s);
    const detectedRegion = (info as any).region;
    if (!detectedRegion || !REGIONS.includes(detectedRegion as Region)) {
      unresolved.push({ shop_id: String(s), reason: "region_unresolved", info_error: (info as any).error || null });
      continue;
    }
    enr.push({ shop_id:String(s), region:detectedRegion, shop_name:(info as any).shop_name||null });
  }
  if (enr.length === 0) return html(`<h2>저장할 샵 없음</h2><p>모두 banned 상태입니다.</p>`);
  const rows=enr.map(e=>({ shop_id:e.shop_id, region:e.region, shop_name:e.shop_name, access_token:r.access_token, refresh_token:r.refresh_token, expires_at:ea, status:"active", authorized_at:ni, merchant_id }));
  const { error }=await supa.from("shopee_shops").upsert(rows, { onConflict:"shop_id" });
  if(error) return html(`<h2>저장 실패</h2><pre>${esc(error.message)}</pre>`);
  let syncMsg = "";
  try { const sync = await syncTokensFromShopsTable(); syncMsg = `<p>shopee_tokens sync: <b>${sync.synced}</b>개 region (${(sync.regions||[]).join(", ")})</p>`; }
  catch (e) { syncMsg = `<p style="color:#f88">shopee_tokens sync 실패: ${esc(String((e as Error).message))}</p>`; }
  const skippedMsg = skipped.length ? `<p style="color:#fbbf24">banned 제외: ${skipped.map((x:any)=>x.shop_id).join(", ")}</p>` : "";
  return html(`<h2>✅ 연동 완료</h2><p>저장된 샵: <b>${enr.length}</b>개</p><p>Merchant ID: <b>${merchant_id||"(none)"}</b></p>${syncMsg}${skippedMsg}<script>setTimeout(()=>window.close(),5000);</script>`);
}

async function listOrderSns(at:string, sid:string|number, timeField:"create_time"|"update_time", from:number, to:number, orderStatus?:string){
  const sns:string[]=[]; let cursor="";
  for(let i=0;i<50;i++){
    const p="/api/v2/order/get_order_list"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,sid);
    const url=`${HOST_DEF}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${sid}&time_range_field=${timeField}&time_from=${from}&time_to=${to}&page_size=100`+(cursor?`&cursor=${encodeURIComponent(cursor)}`:"")+(orderStatus?`&order_status=${orderStatus}`:"");
    const j=await(await fetch(url)).json();
    if(j.error){
      if (orderStatus && /invalid|not.support|unknown/i.test(`${j.error} ${j.message||""}`)) return sns;
      throw new Error(`get_order_list(${timeField}, ${orderStatus||"any"}): ${j.error} ${j.message||""}`);
    }
    for(const o of (j.response?.order_list||[])) sns.push(o.order_sn);
    if(!j.response?.more) break;
    cursor=j.response.next_cursor||""; if(!cursor) break;
  }
  return sns;
}

async function pollShop(shop:any, opts:{ days?: number, exact?: boolean }={}){
  // v42: detect permanent shop-level errors and mark as banned instead of throwing
  const at=await freshToken(shop); const now=Math.floor(Date.now()/1000);
  const days = Math.min(60, Math.max(1, opts.days||3));
  const set=new Set<string>();
  if (opts.exact) {
    let cursor = now;
    let remaining = days * 86400;
    const SLOT = 15 * 86400;
    while (remaining > 0) {
      const span = Math.min(SLOT, remaining);
      for (const st of ["READY_TO_SHIP","PROCESSED","RETRY_SHIP"]){
        try { for(const sn of await listOrderSns(at,shop.shop_id,"create_time", cursor - span, cursor, st)) set.add(sn); } catch(e:any) {
          if (isPermanentShopError(e?.message)) {
            await markShopBanned(shop.shop_id, e.message);
            return { inserted:0, updated:0, excluded:0, polled:0, days, exact:true, banned:true, reason:e.message };
          }
          // skip non-permanent errors silently
        }
      }
      cursor -= span;
      remaining -= span;
    }
  } else {
    let cursor = now;
    let remaining = days * 86400;
    const SLOT = 15 * 86400;
    while (remaining > 0) {
      const span = Math.min(SLOT, remaining);
      try {
        for(const sn of await listOrderSns(at,shop.shop_id,"update_time", cursor - span, cursor)) set.add(sn);
      } catch(e:any) {
        if (isPermanentShopError(e?.message)) {
          await markShopBanned(shop.shop_id, e.message);
          return { inserted:0, updated:0, excluded:0, polled:0, days, exact:false, banned:true, reason:e.message };
        }
        throw e; // re-throw non-permanent errors
      }
      cursor -= span;
      remaining -= span;
    }
  }
  const sns=Array.from(set);
  if(sns.length===0) return { inserted:0, updated:0, excluded:0, polled:0, days, exact: !!opts.exact };
  const externalIds = sns.map(sn => `shopee:${shop.shop_id}:${sn}`);
  const allExisting: any[] = [];
  for (let i = 0; i < externalIds.length; i += 50) {
    const chunk = externalIds.slice(i, i + 50);
    const { data } = await supa.from("marketplace_orders").select("id, external_id, status, shipped_at, raw_payload, tracking_number").in("external_id", chunk);
    if (data) allExisting.push(...data);
  }
  const existingMap = new Map<string, any>();
  for (const e of allExisting) existingMap.set(e.external_id, e);
  let inserted=0, updated=0, excluded=0, unknown=0, detailed=0;
  const needsDetail: string[] = [];
  for (const sn of sns) {
    const ext = `shopee:${shop.shop_id}:${sn}`;
    const ex = existingMap.get(ext);
    if (!ex || !(ex.raw_payload as any)?.package_number) { needsDetail.push(sn); continue; }
    if (!opts.exact) needsDetail.push(sn);
    if (opts.exact) needsDetail.push(sn);
  }
  const detailMap = new Map<string, any>();
  for(let i=0;i<needsDetail.length;i+=50){
    const chunk=needsDetail.slice(i,i+50);
    if (chunk.length === 0) break;
    const p="/api/v2/order/get_order_detail"; const t=Math.floor(Date.now()/1000); const sig=await sS(p,t,at,shop.shop_id);
    const opt="buyer_username,recipient_address,item_list,total_amount,currency,order_status,package_list,shipping_carrier";
    const url=`${hostFor(shop.region)}${p}?partner_id=${PARTNER_ID}&timestamp=${t}&sign=${sig}&access_token=${at}&shop_id=${shop.shop_id}&order_sn_list=${chunk.join(",")}&response_optional_fields=${opt}`;
    const j=await(await fetch(url)).json();
    if(j.error) {
      if (isPermanentShopError(j.error, j.message)) {
        await markShopBanned(shop.shop_id, `get_order_detail: ${j.error} ${j.message||""}`)
        return { inserted:0, updated:0, excluded:0, polled:0, days, exact: !!opts.exact, banned:true, reason:`get_order_detail: ${j.error} ${j.message||""}` };
      }
      throw new Error(`get_order_detail: ${j.error} ${j.message||""}`);
    }
    for(const d of j.response?.order_list||[]){ detailMap.set(d.order_sn, d); detailed++; }
  }
  for (const sn of sns) {
    const ext = `shopee:${shop.shop_id}:${sn}`;
    const ex = existingMap.get(ext);
    const d = detailMap.get(sn);
    let shopeeStatus: string;
    if (d) shopeeStatus = d.order_status;
    else if (opts.exact) shopeeStatus = (ex?.raw_payload as any)?.order_status || "";
    else continue;
    if (!shopeeStatus) continue;
    const mapped = mapStatus(shopeeStatus);
    if (mapped === "excluded") {
      if (ex) { await supa.from("marketplace_order_items").delete().eq("order_id", ex.id); await supa.from("marketplace_orders").delete().eq("id", ex.id); }
      excluded++; continue;
    }
    if (mapped === "unknown") { unknown++; continue; }
    if (!d) {
      if (ex && ex.status !== mapped) { await supa.from("marketplace_orders").update({ status: mapped }).eq("id", ex.id); updated++; }
      continue;
    }
    const rec = d.recipient_address || {}; const fp = (d.package_list||[])[0]||{};
    const newTracking = fp.tracking_number || null;
    const payload:any = { marketplace:"shopee", external_id:ext, status:mapped,
      shipping_country: rec.region || shop.region, shipping_city: rec.city || rec.state || "", shipping_postal: rec.zipcode || "",
      total_amount: d.total_amount ?? null, currency: d.currency || "",
      received_at: d.create_time ? new Date(d.create_time*1000).toISOString() : null,
      tracking_number: newTracking ?? (ex?.tracking_number || null),
      raw_payload: { shop_id: shop.shop_id, region: shop.region, order_sn: d.order_sn, package_number: fp.package_number||null, order_status: d.order_status, full: d } };
    if (mapped === "shipped") payload.shipped_at = new Date().toISOString();
    if (ex) {
      // v41: backfill gift items that were skipped by the v40 filter for already-inserted orders
      const _giftFromApi = (d.item_list||[]).filter((it:any) => it.main_item === false && it.model_discounted_price === 0);
      if (_giftFromApi.length > 0) {
        const { data: _existZero } = await supa.from("marketplace_order_items").select("id").eq("order_id", ex.id).eq("unit_price", 0).limit(1);
        if (!_existZero || _existZero.length === 0) {
          await supa.from("marketplace_order_items").insert(
            _giftFromApi.map((it:any) => ({ order_id: ex.id, sku: it.item_sku || "", variant_sku: it.model_sku || "", product_name: it.item_name || "", variant_name: it.model_name || "", qty: it.model_quantity_purchased || 1, unit_price: 0 }))
          ).catch(()=>{});
        }
      }
      const prevStatus = (ex.raw_payload as any)?.order_status;
      if (prevStatus === d.order_status && ex.status === mapped && (newTracking ? newTracking === ex.tracking_number : true)) continue;
      const upd:any = { status: payload.status, tracking_number: payload.tracking_number, raw_payload: payload.raw_payload };
      if (mapped === "shipped" && !ex.shipped_at) upd.shipped_at = payload.shipped_at;
      if (mapped === "pending") upd.shipped_at = null;
      await supa.from("marketplace_orders").update(upd).eq("id", ex.id);
      updated++;
    } else {
      const { data: ord, error: ie } = await supa.from("marketplace_orders").insert(payload).select("id").single();
      if (ie) throw new Error(`insert order: ${ie.message}`);
      // v41: include all items (gifts with main_item===false && price===0 are no longer excluded)
      const items = (d.item_list||[]).map((it:any) => ({ order_id: ord.id, sku: it.item_sku || "", variant_sku: it.model_sku || "", product_name: it.item_name || "", variant_name: it.model_name || "", qty: it.model_quantity_purchased || 1, unit_price: it.model_discounted_price ?? it.model_original_price ?? null }));
      if (items.length > 0) { const { error: te } = await supa.from("marketplace_order_items").insert(items); if (te) throw new Error(`insert items: ${te.message}`); }
      inserted++;
    }
  }
  await supa.from("shopee_shops").update({ last_polled_at:new Date().toISOString() }).eq("shop_id", shop.shop_id);
  return { inserted, updated, excluded, unknown, polled: detailed, listed: sns.length, days, exact: !!opts.exact };
}

function j(b:any, s=200){ return new Response(JSON.stringify(b), { status:s, headers:{ ...CORS, "Content-Type":"application/json" } }); }
function html(b:string){ return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px;background:#0d0f14;color:#eee">${b}</body>`, { status:200, headers:{ ...CORS, "Content-Type":"text/html; charset=utf-8" } }); }
function esc(s:string){ return s.replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!)); }

serve(async (req)=>{
  if(req.method==="OPTIONS") return new Response("ok", { headers:CORS });
  const u=new URL(req.url); const p=u.pathname.replace(/^\/shopee-orders/,"")||"/";
  try {
    if(p==="/diag-env") return j({ ok:true, partner_id: PARTNER_ID, has_partner_key: !!PARTNER_KEY, has_redirect: !!REDIRECT, version: 42 });
    if(p==="/sync-tokens" && (req.method==="POST" || req.method==="GET")) return j({ ok:true, ...(await syncTokensFromShopsTable()) });
    if(p==="/auth-url" && req.method==="POST"){ const { region }=await req.json(); return j({ ok:true, url:await authUrl(region) }); }
    if(p==="/callback" && req.method==="GET"){
      const c=u.searchParams.get("code")||""; const sid=u.searchParams.get("shop_id")||""; const mid=u.searchParams.get("main_account_id")||""; const r=u.searchParams.get("region")||"";
      if(!c) return html("<h2>Missing code</h2>");
      const region = r || "SG";
      if(mid) return await handleCallbackMain(c,mid,region);
      if(sid) return await handleCallbackShop(c,sid,region);
      return html("<h2>Missing shop_id or main_account_id</h2>");
    }
    if(p==="/poll-shop" && req.method==="POST"){
      const b=await req.json().catch(()=>({}));
      const shopId=String(b.shop_id||"");
      const days = Math.min(60, Math.max(1, Number(b.days)||3));
      const exact = !!b.exact;
      if(!shopId) return j({ ok:false, error:"shop_id required" }, 400);
      const { data:shop, error }=await supa.from("shopee_shops").select("*").eq("shop_id", shopId).single();
      if(error||!shop) return j({ ok:false, error:"shop not found" }, 404);
      // v42: refuse to poll banned shops
      if(shop.status === "banned") return j({ ok:false, error:"shop_banned", message:`shop ${shopId} is permanently banned` }, 400);
      try { return j({ ok:true, shop_id:shop.shop_id, region:shop.region, ...(await pollShop(shop, { days, exact })) }); }
      catch(e:any){ return j({ ok:false, shop_id:shop.shop_id, error:String(e?.message||e) }, 500); }
    }
    if(p==="/poll" && req.method==="POST"){
      const b=await req.json().catch(()=>({}));
      const days = Math.min(60, Math.max(1, Number(b.days)||3));
      const exact = !!b.exact;
      const { data:shops, error }=await supa.from("shopee_shops").select("*").eq("status","active");
      if(error) throw new Error(error.message);
      if(!shops||shops.length===0) return j({ ok:true, results:[] });
      const results:any[]=[];
      for(const shop of shops){ try { results.push({ shop_id:shop.shop_id, region:shop.region, ...(await pollShop(shop, { days, exact })) }); } catch(e){ results.push({ shop_id:shop.shop_id, region:shop.region, error:(e as Error).message }); } }
      return j({ ok:true, days, exact, results });
    }
    if(p==="/arrange" && req.method==="POST"){
      const b=await req.json().catch(()=>({}));
      const orders:any[]=Array.isArray(b.orders)?b.orders:[];
      if(orders.length===0) return j({ ok:false, error:"orders 배열 필요" }, 400);
      return j(await arrangeOrders(orders));
    }
    if(p==="/label" && req.method==="GET"){
      const sid=u.searchParams.get("shop_id")||""; const sn=u.searchParams.get("order_sn")||""; const pk=u.searchParams.get("package_number")||undefined;
      if(!sid||!sn) return j({ error:"shop_id and order_sn required" }, 400);
      return await fetchLabel(sid,sn,pk);
    }
    if(p==="/tracking" && req.method==="GET"){
      const sid=u.searchParams.get("shop_id")||""; const sn=u.searchParams.get("order_sn")||""; const pk=u.searchParams.get("package_number")||undefined;
      if(!sid||!sn) return j({ ok:false, error:"shop_id and order_sn required" }, 400);
      const r = await fetchTracking(sid, sn, pk);
      return j(r, r.ok ? 200 : 502);
    }
    if(p==="/shops" && req.method==="GET"){
      const { data, error }=await supa.from("shopee_shops").select("shop_id, region, shop_name, status, expires_at, last_polled_at, authorized_at, merchant_id").order("region",{ ascending:true }).order("authorized_at",{ ascending:false });
      if(error) return j({ error:error.message }, 500);
      return j({ ok:true, shops:data||[] });
    }
    if(p==="/unlink" && req.method==="POST"){
      const { shop_id }=await req.json();
      const { error }=await supa.from("shopee_shops").delete().eq("shop_id", String(shop_id));
      if(error) return j({ error:error.message }, 500);
      return j({ ok:true });
    }
    return j({ error:`unknown path: ${p}` }, 404);
  } catch(e){ return j({ error:(e as Error).message }, 500); }
});
