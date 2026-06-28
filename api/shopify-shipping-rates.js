const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgqlwgnmwegzsjelbrih.supabase.co';
const SUPABASE_ANON =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ncWx3Z25td2VnenNqZWxicmloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDkzNDMsImV4cCI6MjA5NDg4NTM0M30.mJtqXO7WJMBUYBYVOS1FrD5qmFX6yZxGwfiGw3HUyJE';
const DEFAULT_KRW_PER_USD = Number(process.env.SHOPIFY_SHIPPING_KRW_PER_USD || 1460);
const SERVICE_NAME = process.env.SHOPIFY_SHIPPING_SERVICE_NAME || 'starphotocard Standard';
const SERVICE_CODE = process.env.SHOPIFY_SHIPPING_SERVICE_CODE || 'SPC_STANDARD';

function json(res, body, status = 200) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function shopifyShippingWeightBucketG(weightG) {
  const weight = Number(weightG || 0);
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  if (weight > 1000) return 0;
  return Math.max(100, Math.ceil(weight / 100) * 100);
}

function shopifyShippingCentsFromKrw(krw, krwPerUsd = DEFAULT_KRW_PER_USD) {
  const amountKrw = Number(krw || 0);
  const exchangeRate = Number(krwPerUsd || 0);
  if (!Number.isFinite(amountKrw) || amountKrw <= 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
  return Math.ceil((amountKrw / exchangeRate) * 100);
}

function totalShippingWeightG(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    if (item && item.requires_shipping === false) return sum;
    const grams = Number(item?.grams || 0);
    if (!Number.isFinite(grams) || grams <= 0) return sum;
    const quantity = Math.max(1, Math.floor(Number(item?.quantity || 1) || 1));
    return sum + grams * quantity;
  }, 0);
}

async function fetchShippingRateRow({ countryCode, weightBucketG }) {
  if (!SUPABASE_URL || !SUPABASE_ANON || !countryCode || !weightBucketG) return null;
  const params = new URLSearchParams({
    select: 'country_code,country_name,weight_g,standard_krw',
    country_code: `eq.${countryCode}`,
    weight_g: `eq.${weightBucketG}`,
    limit: '1',
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/ebay_shipping_country_rates?${params.toString()}`, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function buildShopifyShippingRates(body, options = {}) {
  const rate = body && typeof body === 'object' ? body.rate : null;
  if (!rate || typeof rate !== 'object') return { rates: [] };

  const requestedCurrency = String(rate.currency || 'USD').trim().toUpperCase();
  if (requestedCurrency && requestedCurrency !== 'USD') return { rates: [] };

  const countryCode = normalizeCountryCode(rate.destination?.country);
  const totalWeightG = totalShippingWeightG(rate.items);
  const weightBucketG = shopifyShippingWeightBucketG(totalWeightG);
  if (!countryCode || !weightBucketG) return { rates: [] };

  const resolveRate = typeof options.resolveRate === 'function' ? options.resolveRate : fetchShippingRateRow;
  const row = await resolveRate({ countryCode, weightBucketG });
  const standardKrw = Number(row?.standard_krw || row?.standardKrw || 0);
  const cents = shopifyShippingCentsFromKrw(standardKrw, options.krwPerUsd || DEFAULT_KRW_PER_USD);
  if (!cents) return { rates: [] };

  return {
    rates: [{
      service_name: SERVICE_NAME,
      service_code: SERVICE_CODE,
      description: `${weightBucketG}g tracked shipping to ${countryCode}`,
      currency: 'USD',
      total_price: String(cents),
    }],
  };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return json(res, { rates: [] }, 204);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return json(res, { rates: [] }, 405);
  }

  try {
    const body = req.body && typeof req.body === 'object'
      ? req.body
      : JSON.parse(req.body || '{}');
    return json(res, await buildShopifyShippingRates(body));
  } catch {
    return json(res, { rates: [] });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.buildShopifyShippingRates = buildShopifyShippingRates;
module.exports.shopifyShippingWeightBucketG = shopifyShippingWeightBucketG;
module.exports.shopifyShippingCentsFromKrw = shopifyShippingCentsFromKrw;
