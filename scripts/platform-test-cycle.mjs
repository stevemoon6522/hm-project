import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const targetPath = join(__dirname, 'platform-test-target.json');
const indexPath = join(root, 'v2', 'index.html');

const CONFIRM = {
  ebayWithdraw: 'WITHDRAW_EBAY_LISTING',
  joomDelete: 'DELETE_JOOM_PRODUCT',
  qoo10Delete: 'DELETE_QOO10_LISTING',
  shopeeDelete: 'DELETE_SHOPEE_GLOBAL_ITEM',
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readV2Env() {
  const html = readFileSync(indexPath, 'utf8');
  const url = html.match(/const SUPABASE_URL = '([^']+)'/)?.[1];
  const anon = html.match(/const SUPABASE_ANON = '([^']+)'/)?.[1];
  if (!url || !anon) throw new Error('SUPABASE_URL or SUPABASE_ANON not found in v2/index.html');
  return { url, anon };
}

function targetProduct(target, args = {}) {
  return {
    id: String(args.productId || target.product_id || '').trim(),
    sku: String(args.sku || target.sku || '').trim(),
    product_name: String(args.title || target.title || '').trim(),
    option_name: args.optionName || 'CD Digipack',
    lifecycle_state: 'ready_stock',
    cost_krw: Number(args.costKrw || 16000),
    weight_g: Number(args.weightG || 150),
    inventory: Number(args.inventory || 3),
    main_image: args.mainImage || 'https://placehold.co/1200x1200/png?text=JENNIE+Ruby+CD+Digipack',
    _source: 'scripts/platform-test-target.json fallback',
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function headers(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw_text: text };
  }
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${json?.error || json?.message || text}`);
    err.status = resp.status;
    err.json = json;
    throw err;
  }
  return json;
}

async function restGet(env, table, query, key = env.anon) {
  return fetchJson(`${env.url}/rest/v1/${table}?${query}`, {
    headers: headers(key),
  });
}

async function restPatch(env, table, filter, payload, key = env.anon) {
  return fetchJson(`${env.url}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...headers(key), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
}

async function restPost(env, table, payload, key = env.anon, query = '') {
  const suffix = query ? `?${query}` : '';
  return fetchJson(`${env.url}/rest/v1/${table}${suffix}`, {
    method: 'POST',
    headers: { ...headers(key), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
}

async function edgePost(env, functionName, action, body, internalToken) {
  const h = {
    ...headers(env.anon),
    'x-platform-bridge-token': internalToken || '',
  };
  return fetchJson(`${env.url}/functions/v1/${functionName}/${action}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

async function loadProduct(env, target, args, key = env.anon, options = {}) {
  const productId = String(args.productId || target.product_id || '').trim();
  const sku = String(args.sku || target.sku || '').trim();
  const title = String(args.title || target.title || '').trim();
  const select = [
    'id',
    'sku',
    'product_name',
    'option_name',
    'lifecycle_state',
    'cost_krw',
    'weight_g',
    'inventory',
    'main_image',
    'joom_product_id',
    'joom_variant_id',
    'joom_status',
    'joom_mapping_status',
    'ebay_sku',
    'ebay_offer_id',
    'ebay_item_id',
    'ebay_status',
    'ebay_marketplace_id',
    'qoo10_category_id',
  ].join(',');
  const queries = [];
  if (productId) queries.push(`select=${select}&id=eq.${encodeURIComponent(productId)}`);
  if (sku) queries.push(`select=${select}&sku=eq.${encodeURIComponent(sku)}`);
  if (title) queries.push(`select=${select}&product_name=eq.${encodeURIComponent(title)}`);

  let rows = [];
  for (const query of queries) {
    rows = await restGet(env, 'products', query, key);
    if (Array.isArray(rows) && rows.length) break;
  }

  if (!Array.isArray(rows) || rows.length !== 1) {
    if (options.fallbackToTarget) {
      const fallback = targetProduct(target, args);
      if (fallback.id && fallback.sku) return fallback;
    }
    throw new Error(`Expected one test product row, got ${Array.isArray(rows) ? rows.length : 0}`);
  }
  return rows[0];
}

async function ensureProduct(env, target, args, key = env.anon) {
  try {
    const product = await loadProduct(env, target, args, key);
    return { ok: true, created: false, product };
  } catch {
    const productId = String(args.productId || target.product_id || '').trim();
    const sku = String(args.sku || target.sku || '').trim();
    const title = String(args.title || target.title || '').trim();
    if (!productId || !sku || !title) {
      throw new Error('Target product_id, sku, and title are required to create the test product');
    }
    const payload = {
      id: productId,
      sku,
      product_name: title,
      option_name: args.optionName || 'CD Digipack',
      lifecycle_state: 'ready_stock',
      cost_krw: Number(args.costKrw || 16000),
      weight_g: Number(args.weightG || 150),
      inventory: Number(args.inventory || 3),
      days_to_ship: 2,
      main_image: args.mainImage || 'https://placehold.co/1200x1200/png?text=JENNIE+Ruby+CD+Digipack',
      description: args.description || 'API registration smoke-test product for starphotocard.',
      ebay_category_id: '176984',
    };
    const rows = await restPost(env, 'products', payload, key);
    return { ok: true, created: true, product: Array.isArray(rows) ? rows[0] : rows };
  }
}

async function loadShopeeRows(env, productId) {
  const query = [
    'select=product_id,region,global_item_id,global_model_id,shop_id,shop_item_id,shop_model_id,status,last_error',
    `product_id=eq.${encodeURIComponent(productId)}`,
  ].join('&');
  return restGet(env, 'product_shopee_listings', query);
}

async function loadPlatformListings(env, productId, serviceKey) {
  if (!serviceKey) return { skipped: true, reason: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  const query = [
    'select=id,platform,shop_id,country,platform_item_id,listing_status,mapping_status,error_msg,deleted_at',
    `master_product_id=eq.${encodeURIComponent(productId)}`,
    'deleted_at=is.null',
  ].join('&');
  return restGet(env, 'platform_listings', query, serviceKey);
}

function uniqueTruthy(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

function pickQoo10ItemCode(args, platformListings) {
  if (args.itemCode) return String(args.itemCode);
  if (!Array.isArray(platformListings)) return '';
  const qoo10 = platformListings.find((row) => row.platform === 'qoo10' && row.platform_item_id);
  return qoo10?.platform_item_id ? String(qoo10.platform_item_id) : '';
}

function pickShopeeGlobalItemId(args, shopeeRows) {
  if (args.globalItemId) return String(args.globalItemId);
  const ids = uniqueTruthy((shopeeRows || []).map((row) => row.global_item_id));
  return ids.length === 1 ? ids[0] : '';
}

function requireInternalToken() {
  const token = process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN || '';
  if (!token) throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN is required for bridge cleanup/register calls');
  return token;
}

async function inspect(env, target, args, serviceKey) {
  const product = await loadProduct(env, target, args, serviceKey || env.anon, { fallbackToTarget: true });
  const [shopeeRows, platformListings] = await Promise.all([
    loadShopeeRows(env, product.id),
    loadPlatformListings(env, product.id, serviceKey),
  ]);
  return {
    ok: true,
    target,
    product,
    mappings: {
      ebay: {
        sku: product.ebay_sku || product.sku,
        item_id: product.ebay_item_id || null,
        offer_id: product.ebay_offer_id || null,
        status: product.ebay_status || null,
        marketplace_id: product.ebay_marketplace_id || 'EBAY_US',
      },
      joom: {
        product_id: product.joom_product_id || null,
        variant_id: product.joom_variant_id || null,
        status: product.joom_status || null,
        mapping_status: product.joom_mapping_status || null,
      },
      shopee: shopeeRows,
      qoo10: platformListings,
    },
  };
}

async function ebayRegisterDryRun(env, product, internalToken) {
  return edgePost(env, 'ebay-bridge', 'register-product', {
    product_id: product.id,
    dry_run: true,
  }, internalToken);
}

async function ebayWithdraw(env, product, args, internalToken) {
  const live = args.live === true;
  return edgePost(env, 'ebay-bridge', 'withdraw-product', {
    product_id: product.id,
    dry_run: !live,
    confirm: live ? CONFIRM.ebayWithdraw : undefined,
    reset_local: args.resetLocal !== false,
  }, internalToken);
}

async function joomDelete(env, product, args, internalToken, serviceKey) {
  const live = args.live === true;
  const productId = String(args.joomProductId || product.joom_product_id || product.sku || '').trim();
  if (!productId) return { ok: false, skipped: true, reason: 'No Joom product id or SKU available' };
  const result = await edgePost(env, 'joom-bridge', 'delete', {
    productId,
    dry_run: !live,
    confirm: live ? CONFIRM.joomDelete : undefined,
  }, internalToken);
  if (live && result.ok && serviceKey) {
    const now = new Date().toISOString();
    result.local_reset = await restPatch(env, 'products', `id=eq.${encodeURIComponent(product.id)}`, {
      joom_product_id: null,
      joom_variant_id: null,
      joom_status: 'archived',
      joom_mapping_status: null,
      joom_mapping_error: 'operator_test_cleanup',
      joom_published_at: null,
      joom_last_synced_price: null,
      joom_last_synced_at: now,
    }, serviceKey);
  } else if (live && result.ok && !serviceKey) {
    result.local_reset = { skipped: true, reason: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  }
  return result;
}

async function qoo10Delete(env, product, args, internalToken, platformListings, serviceKey) {
  const itemCode = pickQoo10ItemCode(args, platformListings);
  if (!itemCode) return { ok: false, skipped: true, reason: 'No Qoo10 item code found; pass --item-code <ItemCode>' };
  const live = args.live === true;
  const result = await edgePost(env, 'qoo10-bridge', 'delete', {
    item_code: itemCode,
    seller_code: args.sellerCode || product.sku,
    dry_run: !live,
    confirm: live ? CONFIRM.qoo10Delete : undefined,
  }, internalToken);
  if (live && result.ok && serviceKey) {
    result.local_reset = await restPatch(env, 'platform_listings', [
      `master_product_id=eq.${encodeURIComponent(product.id)}`,
      'platform=eq.qoo10',
      `platform_item_id=eq.${encodeURIComponent(itemCode)}`,
      'deleted_at=is.null',
    ].join('&'), {
      listing_status: 'not_listed',
      mapping_status: 'unmatched',
      error_msg: 'operator_test_cleanup',
      deleted_at: new Date().toISOString(),
    }, serviceKey);
  } else if (live && result.ok && !serviceKey) {
    result.local_reset = { skipped: true, reason: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  }
  return result;
}

async function shopeeDelete(env, product, args, internalToken, shopeeRows) {
  const globalItemId = pickShopeeGlobalItemId(args, shopeeRows);
  if (!globalItemId && !args.productId && !product.id) {
    return { ok: false, skipped: true, reason: 'No Shopee global_item_id found' };
  }
  const live = args.live === true;
  return edgePost(env, 'shopee-bridge', 'delete_global_item_headless', {
    product_id: product.id,
    global_item_id: globalItemId || undefined,
    region: args.region || 'SG',
    dry_run: !live,
    confirm: live ? CONFIRM.shopeeDelete : undefined,
    reset_local: args.resetLocal !== false,
  }, internalToken);
}

async function run() {
  if (!existsSync(targetPath)) throw new Error(`Missing ${targetPath}`);
  const target = readJson(targetPath);
  const env = readV2Env();
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'inspect';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';

  if (command === 'inspect') {
    console.log(JSON.stringify(await inspect(env, target, args, serviceKey), null, 2));
    return;
  }

  if (command === 'ensure-product') {
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for ensure-product when products RLS blocks anon writes');
    console.log(JSON.stringify(await ensureProduct(env, target, args, serviceKey), null, 2));
    return;
  }

  const internalToken = requireInternalToken();
  const product = await loadProduct(env, target, args, serviceKey || env.anon, { fallbackToTarget: true });
  const shopeeRows = await loadShopeeRows(env, product.id);
  const platformListings = await loadPlatformListings(env, product.id, serviceKey);

  const commands = {
    'ebay-register-dry-run': () => ebayRegisterDryRun(env, product, internalToken),
    'ebay-withdraw': () => ebayWithdraw(env, product, args, internalToken),
    'joom-delete': () => joomDelete(env, product, args, internalToken, serviceKey),
    'qoo10-delete': () => qoo10Delete(env, product, args, internalToken, platformListings, serviceKey),
    'shopee-delete': () => shopeeDelete(env, product, args, internalToken, shopeeRows),
    'dry-run-all': async () => ({
      ok: true,
      live: false,
      ebay_register: await ebayRegisterDryRun(env, product, internalToken),
      ebay_withdraw: await ebayWithdraw(env, product, { ...args, live: false }, internalToken),
      joom_delete: await joomDelete(env, product, { ...args, live: false }, internalToken, serviceKey),
      qoo10_delete: await qoo10Delete(env, product, { ...args, live: false }, internalToken, platformListings, serviceKey),
      shopee_delete: await shopeeDelete(env, product, { ...args, live: false }, internalToken, shopeeRows),
    }),
    'cleanup-all': async () => {
      if (!args.live) throw new Error('cleanup-all requires --live');
      return {
        ok: true,
        live: true,
        ebay_withdraw: await ebayWithdraw(env, product, args, internalToken),
        joom_delete: await joomDelete(env, product, args, internalToken, serviceKey),
        qoo10_delete: await qoo10Delete(env, product, args, internalToken, platformListings, serviceKey),
        shopee_delete: await shopeeDelete(env, product, args, internalToken, shopeeRows),
      };
    },
  };

  if (!commands[command]) {
    throw new Error(`Unknown command '${command}'. Use inspect, ensure-product, dry-run-all, ebay-register-dry-run, ebay-withdraw, joom-delete, qoo10-delete, shopee-delete, cleanup-all.`);
  }

  const result = await commands[command]();
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message || String(error),
    status: error.status || null,
    detail: error.json || null,
  }, null, 2));
  process.exit(1);
});
