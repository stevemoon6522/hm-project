const SUPABASE_URL = 'https://bpdafetvjyvvwbksvowu.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwZGFmZXR2anl2dndia3N2b3d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODM4MjYsImV4cCI6MjA5Mjc1OTgyNn0.p9hYSOhVyLUUO8UyRJ7Av56pLgkPUAi1XCMtc6r-AZA';

const ACTIVE_REGIONS = ['SG', 'TW', 'TH', 'MY', 'PH'];
const STALE_SYNC_HOURS = 72;
const STALE_COST_DAYS = 14;
const PRICE_DELTA_RISK_PCT = 50;
const REGION_MULTIPLIER = { SG: 0.014, TW: 0.30, TH: 0.40, MY: 0.04, PH: 0.60, BR: 0.07 };
const REGION_FROM_COUNTRY_CODE = { SG: 'SG', TW: 'TW', TH: 'TH', MY: 'MY', PH: 'PH', BR: 'BR' };
const DEGRADED_APPROVAL_TOKEN = 'APPROVE_V2_DEGRADED_MUTATION';
const FAILURE_STATUSES = new Set(['error', 'failed', 'timeout']);
const REMOTE_SYNC_ACTIONS = new Set(['update_global_price', 'update_global_item', 'set_price_sync_on', 'set_sync_field']);

function json(res, body, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function authHeaders() {
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY_SERVICE_ROLE ||
    '';
  const key = serviceKey || SUPABASE_ANON;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function fetchAll(table, query, maxRows = 10000, pageSize = 1000) {
  const headers = authHeaders();
  let offset = 0;
  const rows = [];
  while (offset < maxRows) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      headers: {
        ...headers,
        'Range-Unit': 'items',
        Range: `${offset}-${offset + pageSize - 1}`,
        Prefer: 'count=none',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${table} ${res.status}: ${text || res.statusText}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows.slice(0, maxRows);
}

async function fetchCount(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      ...authHeaders(),
      'Range-Unit': 'items',
      Range: '0-0',
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${table} ${res.status}: ${text || res.statusText}`);
  }
  const cr = res.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+|\*)$/);
  if (m && m[1] !== '*') return Number(m[1]);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

function isOlderThan(iso, ms) {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > ms;
}

function buildCountrySettingsMap(countrySettings) {
  const out = new Map();
  for (const row of countrySettings || []) {
    const cc = String(row.country_code || row.region || '').toUpperCase();
    const region = REGION_FROM_COUNTRY_CODE[cc] || cc;
    if (!region) continue;
    out.set(region, row || {});
  }
  return out;
}

function toRate(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n / 100 : 0;
}

function estimatePriceFromCountrySettings(costKrw, row) {
  const exchangeRate = Number(row.exchange_rate || 0);
  if (!(exchangeRate > 0) || !(costKrw > 0)) return null;
  const purchaseVat = toRate(row.purchase_vat);
  const pg = toRate(row.pg_fee);
  const sales = toRate(row.sales_fee);
  const fsp = toRate(row.fsp_fee);
  const other = toRate(row.other_fee);
  const ccb = toRate(row.fsp_ccb);
  const settle = toRate(row.settlement_fee);
  const gst = toRate(row.gst);
  const importDuty = toRate(row.import_duty);
  const fixed = Number(row.fixed_service_fee || 0);
  const effectiveCost = costKrw * (1 - purchaseVat);
  const base = effectiveCost / exchangeRate;
  const totalRate = pg + sales + fsp + other + ccb + settle + gst + importDuty;
  const denom = 1 - totalRate;
  if (!(denom > 0.01)) return null;
  return Math.round(((base + Math.max(0, fixed)) / denom) * 100) / 100;
}

function evaluateMarginFormula(formula, context) {
  if (!formula || typeof formula !== 'string') return null;
  const safe = formula.trim();
  if (!safe) return null;
  if (/[^0-9a-zA-Z_+\-*/().,\s]/.test(safe)) return null;
  try {
    const fn = new Function('ctx', `with (ctx) { return (${safe}); }`);
    const val = Number(fn(context));
    if (!Number.isFinite(val) || val <= 0) return null;
    return Math.round(val * 100) / 100;
  } catch {
    return null;
  }
}

function resolveTargetPrice(cost, region, countryMap) {
  const country = countryMap.get(region);
  if (country) {
    const formulaValue = evaluateMarginFormula(country.margin_formula, {
      cost_krw: cost,
      cost,
      exchange_rate: Number(country.exchange_rate || 0),
      pg_fee: Number(country.pg_fee || 0),
      sales_fee: Number(country.sales_fee || 0),
      fsp_fee: Number(country.fsp_fee || 0),
      other_fee: Number(country.other_fee || 0),
      settlement_fee: Number(country.settlement_fee || 0),
      gst: Number(country.gst || 0),
      fsp_ccb: Number(country.fsp_ccb || 0),
      import_duty: Number(country.import_duty || 0),
      fixed_service_fee: Number(country.fixed_service_fee || 0),
      purchase_vat: Number(country.purchase_vat || 0),
    });
    if (formulaValue && formulaValue > 0) return { price: formulaValue, mode: 'formula' };
    const derived = estimatePriceFromCountrySettings(cost, country);
    if (derived && derived > 0) return { price: derived, mode: 'country_settings_derived' };
  }
  const mult = REGION_MULTIPLIER[region];
  if (!(mult > 0)) return { price: null, mode: 'fallback_multiplier' };
  return { price: Math.round(cost * mult * 100) / 100, mode: 'fallback_multiplier' };
}

function requiresApproval(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || '').toLowerCase();
  if (status === 'approval_required' || status === 'needs_approval') return true;
  const msg = String(row.error_msg || '').toLowerCase();
  if (msg.includes('approval_required') || msg.includes('approval required')) return true;
  const resp = row.response && typeof row.response === 'object' ? row.response : null;
  return !!(resp && resp.approval_required && typeof resp.approval_required === 'object');
}

function hasExplicitApproval(row) {
  const payload = row && row.request_payload && typeof row.request_payload === 'object'
    ? row.request_payload
    : null;
  return String(payload?.degraded_approval || '') === DEGRADED_APPROVAL_TOKEN;
}

function computeApprovalPendingCount(approvalRows) {
  if (!Array.isArray(approvalRows) || approvalRows.length === 0) {
    return { count: 0, sourceMode: 'fallback_zero' };
  }
  const latestByKey = new Map();
  for (const row of approvalRows) {
    const key = String(row.payload_hash || row.id || '');
    if (!key || latestByKey.has(key)) continue;
    latestByKey.set(key, row);
  }
  let pending = 0;
  for (const row of latestByKey.values()) {
    if (requiresApproval(row) && !hasExplicitApproval(row)) pending += 1;
  }
  return { count: pending, sourceMode: 'mutation_log_approval_required' };
}

function mutationBatchKey(row) {
  const payloadHash = String(row.payload_hash || '').trim();
  if (payloadHash) return `hash:${payloadHash}`;
  const action = String(row.action || '');
  const region = String(row.region || '');
  const gid = String(row.target_global_item_id || '');
  const gmid = String(row.target_global_model_id || '');
  const sid = String(row.target_shop_item_id || '');
  return `legacy:${action}|${region}|${gid}|${gmid}|${sid}`;
}

function analyzeFailedBatches(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      unresolvedCount: 0,
      rawErrorRows: 0,
      sourceMode: 'fallback_zero',
    };
  }
  const latestTerminalByKey = new Map();
  let rawErrorRows = 0;
  for (const row of rows) {
    const status = String(row.status || '').toLowerCase();
    if (status === 'error') rawErrorRows += 1;
    if (status === 'dry_run') continue;
    const key = mutationBatchKey(row);
    if (!key || latestTerminalByKey.has(key)) continue;
    latestTerminalByKey.set(key, status);
  }
  let unresolved = 0;
  for (const status of latestTerminalByKey.values()) {
    if (FAILURE_STATUSES.has(status)) unresolved += 1;
  }
  return {
    unresolvedCount: unresolved,
    rawErrorRows,
    sourceMode: 'mutation_log_latest_terminal_status',
  };
}

function buildRemoteSyncCheckpointByRegion(mutationRows) {
  const out = {};
  for (const row of mutationRows || []) {
    const region = String(row.region || '').toUpperCase();
    if (!ACTIVE_REGIONS.includes(region)) continue;
    if (!REMOTE_SYNC_ACTIONS.has(String(row.action || '').toLowerCase())) continue;
    if (String(row.status || '').toLowerCase() !== 'ok') continue;
    const rid = String(row.request_id || row.response?.request_id || '').trim();
    if (!rid) continue;
    const ts = new Date(row.created_at || '').getTime();
    if (!Number.isFinite(ts)) continue;
    if (!out[region] || ts > out[region].ts) out[region] = { ts, requestId: rid };
  }
  return out;
}

function computeDriftSummary(listings, mutationRows) {
  const staleSyncMs = STALE_SYNC_HOURS * 3600000;
  const checkpoints = buildRemoteSyncCheckpointByRegion(mutationRows);
  const activeRemoteRegions = Object.keys(checkpoints);
  const mode = activeRemoteRegions.length > 0
    ? 'remote_aware_mutation_log_checkpoint'
    : 'local_stale_heuristic';
  const driftByRegion = {};
  let driftCount = 0;

  for (const l of listings || []) {
    const region = String(l.region || '').toUpperCase();
    if (!ACTIVE_REGIONS.includes(region)) continue;
    const checkpoint = checkpoints[region];
    let drift = false;
    if (!l.shop_item_id) {
      drift = true;
    } else if (checkpoint) {
      const syncedAt = new Date(l.last_synced_at || '').getTime();
      drift = !Number.isFinite(syncedAt) || syncedAt < checkpoint.ts;
    } else {
      drift = isOlderThan(l.last_synced_at, staleSyncMs);
    }
    if (drift) {
      driftCount += 1;
      driftByRegion[region] = (driftByRegion[region] || 0) + 1;
    }
  }
  return {
    count: driftCount,
    byRegion: driftByRegion,
    sourceMode: mode,
    remoteCheckpointByRegion: activeRemoteRegions.reduce((acc, r) => {
      acc[r] = new Date(checkpoints[r].ts).toISOString();
      return acc;
    }, {}),
  };
}

function computeSummary(products, listings, failedSummary, countrySettings, approvalSummary, driftSummary) {
  const staleCostMs = STALE_COST_DAYS * 86400000;
  const countryMap = buildCountrySettingsMap(countrySettings);
  const hasFormulaRow = (countrySettings || []).some((r) => r && String(r.margin_formula || '').trim() !== '');
  const listingByProduct = new Map();
  let usedFormula = false;
  let usedDerived = false;
  let usedFallback = false;

  for (const l of listings) {
    const region = String(l.region || '').toUpperCase();
    if (!ACTIVE_REGIONS.includes(region)) continue;
    const pid = String(l.product_id || '');
    if (!pid) continue;
    if (!listingByProduct.has(pid)) listingByProduct.set(pid, []);
    listingByProduct.get(pid).push({ ...l, region });
  }

  let preOrderCount = 0;
  let missingCostCount = 0;
  let missingWeightCount = 0;
  let staleCostCount = 0;
  let pricingRiskCount = 0;

  for (const p of products) {
    const lc = String(p.lifecycle_state || '').toLowerCase();
    const cost = Number(p.cost_krw || 0);
    const weight = Number(p.weight_g || 0);
    const pid = String(p.id || '');

    if (lc === 'pre_order') preOrderCount += 1;
    if (!(cost > 0)) missingCostCount += 1;
    if (!(weight > 0)) missingWeightCount += 1;
    const staleCost = lc === 'ready_stock' && isOlderThan(p.cost_updated_at || p.created_at, staleCostMs);
    if (staleCost) staleCostCount += 1;

    let risky = !(cost > 0) || staleCost;
    if (!risky) {
      const rows = listingByProduct.get(pid) || [];
      risky = rows.some((l) => {
        const oldPrice = Number(l.last_synced_price || 0);
        const resolved = resolveTargetPrice(cost, l.region, countryMap);
        if (resolved.mode === 'formula') usedFormula = true;
        else if (resolved.mode === 'country_settings_derived') usedDerived = true;
        else if (resolved.mode === 'fallback_multiplier') usedFallback = true;
        const newPrice = resolved.price;
        if (!(oldPrice > 0) || !(newPrice > 0) || !(cost > 0)) return false;
        const delta = (Math.abs(newPrice - oldPrice) / oldPrice) * 100;
        return delta >= PRICE_DELTA_RISK_PCT;
      });
    }
    if (risky) pricingRiskCount += 1;
  }

  const marginSourceMode = usedFormula
    ? 'formula_based'
    : usedDerived
      ? 'country_settings_derived'
      : 'fallback_multiplier';

  return {
    failed_batch_remaining_count: Number(failedSummary?.unresolvedCount || 0),
    failed_batch_raw_error_rows_count: Number(failedSummary?.rawErrorRows || 0),
    failed_batch_source_mode: failedSummary?.sourceMode || 'fallback_zero',
    approval_pending_count: Number(approvalSummary?.count || 0),
    products_total: products.length,
    pre_order_count: preOrderCount,
    missing_cost_count: missingCostCount,
    missing_weight_count: missingWeightCount,
    stale_cost_count: staleCostCount,
    pricing_risk_count: pricingRiskCount,
    sync_drift_count: Number(driftSummary?.count || 0),
    sync_drift_by_region: driftSummary?.byRegion || {},
    sync_drift_source_mode: driftSummary?.sourceMode || 'local_stale_heuristic',
    sync_drift_remote_checkpoint_by_region: driftSummary?.remoteCheckpointByRegion || {},
    has_margin_formula: hasFormulaRow || marginSourceMode !== 'fallback_multiplier',
    margin_source_mode: marginSourceMode,
    margin_formula_available: hasFormulaRow,
    approval_source_mode: approvalSummary?.sourceMode || 'fallback_zero',
    source_mode: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'vercel_api_service_role' : 'vercel_api_anon_fallback',
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, { ok: false, error: 'method_not_allowed' }, 405);
  }
  try {
    const [products, listings, countrySettings, mutationRows] = await Promise.all([
      fetchAll(
        'products',
        '?select=id,lifecycle_state,cost_krw,weight_g,cost_updated_at,created_at&order=created_at.desc',
        20000,
        1000
      ),
      fetchAll(
        'product_shopee_listings',
        '?select=product_id,region,shop_item_id,last_synced_price,last_synced_at&order=region.asc',
        50000,
        1000
      ),
      fetchAll('country_settings', '?select=*', 1000, 1000).catch(() => []),
      fetchAll(
        'shopee_mutation_log',
        '?select=id,payload_hash,action,region,target_global_item_id,target_global_model_id,target_shop_item_id,status,error_msg,response,request_payload,created_at&actor=eq.v2-wizard&order=created_at.desc',
        5000,
        1000
      ).catch(() => []),
    ]);
    const approvalSummary = computeApprovalPendingCount(mutationRows);
    const failedSummary = analyzeFailedBatches(mutationRows);
    const driftSummary = computeDriftSummary(listings, mutationRows);
    const summary = computeSummary(products, listings, failedSummary, countrySettings, approvalSummary, driftSummary);
    summary.source_mode = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY_SERVICE_ROLE
    ) ? 'vercel_api_service_role' : 'vercel_api_anon_fallback';
    return json(res, { ok: true, summary });
  } catch (error) {
    return json(res, { ok: false, error: String(error && error.message ? error.message : error), summary: null });
  }
};
