import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const targetPath = join(__dirname, 'platform-test-target.json');
const indexPath = join(root, 'v2', 'index.html');

const CONFIRM = {
  ebayPublish: 'PUBLISH_EBAY_LISTING',
  ebayPolicy: 'UPDATE_EBAY_FULFILLMENT_POLICY',
  ebayWithdraw: 'WITHDRAW_EBAY_LISTING',
  joomDelete: 'DELETE_JOOM_PRODUCT',
  qoo10Delete: 'DELETE_QOO10_LISTING',
  shopeeDelete: 'DELETE_SHOPEE_GLOBAL_ITEM',
};

const DEFAULT_TEST_IMAGE = 'https://staronemall2.wisacdn.com/_data/product/c24/m9980/5f89fa5684d4141047298b2acfe4aac6.png';
const DEFAULT_TEST_DETAIL_IMAGE = 'https://staronemall2.wisacdn.com/_data/attach/c24/m19/dae3838cec72eb5fa6ebcb933edc951a.jpg';

const DIAGNOSIS_PACKS = {
  'shopee-registration': {
    purpose: 'Diagnose Shopee Global Product registration and regional publish failures.',
    compare_order: [
      'failed/success payload',
      'variant SKU to Shopee model mapping',
      'publish region and publishable shop state',
      'product image IDs and region image IDs',
      'brand, category, mandatory attributes, stock, price, and DTS',
      'shopee-bridge or platform-publish stage log',
    ],
    local_api_docs: [
      'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.add_global_item.json',
      'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.add_global_model.json',
      'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.create_publish_task.json',
      'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.get_publish_task_result.json',
    ],
    regression_commands: [
      'node scripts/test-v2-shopee-registration-hardening.mjs',
      'node scripts/test-v2-shopee-registration-platform-mapping.mjs',
      'node scripts/test-v2-platform-test-cycle.mjs',
    ],
  },
  'price-sync': {
    purpose: 'Diagnose partial marketplace price sync failures.',
    compare_order: [
      'dry-run diff',
      'target platform listing and model IDs',
      'last known good local price snapshot',
      'live marketplace result when a write was intended',
      'rollback payload or prior marketplace value',
    ],
    local_api_docs: [
      'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.get_global_item_info.json',
      'C:\\dev\\api-refs\\marketplaces\\joom\\openapi.yaml',
      'C:\\dev\\api-refs\\marketplaces\\ebay\\sell\\inventory.yaml',
    ],
    regression_commands: [
      'node scripts/test-v2-price-snapshot-dry-run-ui.mjs',
      'node scripts/test-v2-price-sync-v1-parity.mjs',
      'node scripts/test-v2-shopee-bulk-price-stability.mjs',
    ],
  },
  'joom-registration': {
    purpose: 'Diagnose Joom product registration failures.',
    compare_order: [
      'brand and category',
      'detail image URLs and upload result',
      'variant SKU, price, stock, and weight',
      'Joom bridge request payload',
      'Joom response body',
    ],
    local_api_docs: [
      'C:\\dev\\api-refs\\marketplaces\\joom\\openapi.yaml',
    ],
    regression_commands: [
      'node scripts/test-v2-joom-register-images-sku.mjs',
      'node scripts/test-v2-joom-registration-platform-mapping.mjs',
      'node scripts/test-joom-detail-resource-limit-regression.mjs',
    ],
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readV2Env() {
  const html = readFileSync(indexPath, 'utf8');
  const url = process.env.SUPABASE_URL || html.match(/const SUPABASE_URL = '([^']+)'/)?.[1];
  const anon = process.env.SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON
    || html.match(/const SUPABASE_ANON = '([^']+)'/)?.[1];
  if (!url || !anon) throw new Error('SUPABASE_URL or SUPABASE_ANON not found in env or v2/index.html');
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
    main_image: args.mainImage || DEFAULT_TEST_IMAGE,
    extra_images: [DEFAULT_TEST_DETAIL_IMAGE],
    description: args.description || 'API registration smoke-test product for starphotocard.',
    joom_category_id: args.joomCategoryId || 'music_albums',
    shopee_brand_name: args.brand || 'JENNIE',
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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';
  const h = {
    apikey: serviceKey || env.anon,
    Authorization: `Bearer ${serviceKey || env.anon}`,
    'Content-Type': 'application/json',
  };
  if (internalToken) h['x-platform-bridge-token'] = internalToken;
  return fetchJson(`${env.url}/functions/v1/${functionName}/${action}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

async function fetchImageDataUrl(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Image fetch failed HTTP ${resp.status}: ${imageUrl}`);
  const contentType = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mime = /^image\/(png|jpeg|jpg)$/.test(contentType)
    ? contentType.replace('image/jpg', 'image/jpeg')
    : (/\.png(?:\?|$)/i.test(imageUrl) ? 'image/png' : 'image/jpeg');
  const bytes = Buffer.from(await resp.arrayBuffer());
  return `data:${mime};base64,${bytes.toString('base64')}`;
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
    'extra_images',
    'description',
    'shopee_category_id',
    'shopee_brand_id',
    'shopee_brand_name',
    'shopee_image_id',
    'shopee_extra_image_ids',
    'shopee_description',
    'shopee_extra_attributes',
    'shopee_days_to_ship',
    'shopee_global_item_sku',
    'shopee_global_model_sku',
    'joom_product_id',
    'joom_variant_id',
    'joom_status',
    'joom_mapping_status',
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

async function loadShopeeRows(env, productId, key = env.anon) {
  const query = [
    'select=product_id,account_key,region,global_item_id,global_model_id,shop_id,shop_item_id,shop_model_id,status,last_error',
    `product_id=eq.${encodeURIComponent(productId)}`,
    'account_key=eq.starphotocard',
  ].join('&');
  return restGet(env, 'product_shopee_listings', query, key);
}

async function loadPlatformListings(env, productId, serviceKey) {
  if (!serviceKey) return { skipped: true, reason: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  const query = [
    'select=id,platform,shop_id,country,platform_item_id,listing_status,error_msg,deleted_at',
    `master_product_id=eq.${encodeURIComponent(productId)}`,
    'deleted_at=is.null',
  ].join('&');
  return restGet(env, 'platform_listings', query, serviceKey);
}

function uniqueTruthy(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
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

function requireBridgeOperatorAuth() {
  const token = process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';
  if (!token && !serviceKey) {
    throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN or SUPABASE_SERVICE_ROLE_KEY is required for bridge cleanup/register calls');
  }
  return token;
}

async function inspect(env, target, args, serviceKey) {
  const product = await loadProduct(env, target, args, serviceKey || env.anon, { fallbackToTarget: true });
  const [shopeeRows, platformListings] = await Promise.all([
    loadShopeeRows(env, product.id),
    loadPlatformListings(env, product.id, serviceKey),
  ]);
  const packName = args.pack ? String(args.pack) : '';
  if (packName && !DIAGNOSIS_PACKS[packName]) {
    throw new Error(`Unknown diagnosis pack '${packName}'. Use ${Object.keys(DIAGNOSIS_PACKS).join(', ')}.`);
  }
  return {
    ok: true,
    target,
    product,
    diagnosis_pack: packName ? {
      name: packName,
      ...DIAGNOSIS_PACKS[packName],
    } : undefined,
    available_diagnosis_packs: Object.keys(DIAGNOSIS_PACKS),
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
  return ebayRegister(env, product, { live: false }, internalToken);
}

async function ebayRegister(env, product, args, internalToken) {
  const live = args.live === true;
  const body = {
    product_id: product.id,
    dry_run: !live,
    confirm: live ? CONFIRM.ebayPublish : undefined,
    force: args.force === true,
  };
  if (args.ebaySku) body.sku = args.ebaySku;
  return edgePost(env, 'ebay-bridge', 'register-product', body, internalToken);
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

function uniqueEbayTestSku(product, args) {
  if (args.ebaySku) return safeTestSku(args.ebaySku);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  return safeTestSku(product.sku || 'SDV2-EBAY', `EBAY${stamp}`);
}

async function ebayWithdrawSku(env, args, internalToken) {
  const live = args.live === true;
  const ebaySku = String(args.ebaySku || args.sku || '').trim();
  return edgePost(env, 'ebay-bridge', 'withdraw-sku', {
    sku: ebaySku,
    offer_id: args.offerId || args.ebayOfferId || undefined,
    marketplace_id: args.marketplaceId || 'EBAY_US',
    dry_run: !live,
    confirm: live ? CONFIRM.ebayWithdraw : undefined,
  }, internalToken);
}

async function ebayCycle(env, product, args, internalToken) {
  const live = args.live === true;
  const ebaySku = uniqueEbayTestSku(product, args);
  let preview;
  try {
    preview = await ebayRegister(env, product, { ...args, live: false, ebaySku }, internalToken);
  } catch (error) {
    preview = {
      ok: false,
      error: error.message || String(error),
      status: error.status || null,
      detail: error.json || null,
    };
  }
  if (!preview?.ok || !preview?.payload) {
    return { ok: false, live, ebay_sku: ebaySku, register_preview: preview, delete: { skipped: true, reason: 'register dry-run returned no payload' } };
  }
  const payload = { ...preview.payload, sku: ebaySku, dry_run: !live };
  if (!live) {
    return {
      ok: true,
      live: false,
      ebay_sku: ebaySku,
      register: await edgePost(env, 'ebay-bridge', 'publish-headless', payload, internalToken),
      delete: await ebayWithdrawSku(env, { ...args, live: false, ebaySku }, internalToken),
    };
  }

  let register;
  try {
    register = await edgePost(env, 'ebay-bridge', 'publish-headless', {
      ...payload,
      dry_run: false,
      confirm: CONFIRM.ebayPublish,
    }, internalToken);
  } catch (error) {
    register = {
      ok: false,
      error: error.message || String(error),
      status: error.status || null,
      detail: error.json || null,
    };
  }
  const offerId = String(register?.ebay_offer_id || register?.offerId || '').trim();
  const cleanup = offerId
    ? await ebayWithdrawSku(env, { ...args, live: true, ebaySku, offerId }, internalToken)
    : { skipped: true, reason: 'register returned no ebay_offer_id' };
  return {
    ok: register?.ok !== false && cleanup?.ok !== false,
    live: true,
    ebay_sku: ebaySku,
    ebay_offer_id: offerId || null,
    ebay_item_id: register?.ebay_item_id || null,
    register,
    delete: cleanup,
  };
}

async function ebayPolicy(env, product, args, internalToken) {
  const live = args.live === true;
  return edgePost(env, 'ebay-bridge', 'ensure-fulfillment-policy', {
    product_id: product.id,
    dry_run: !live,
    fulfillment_policy_id: args.fulfillmentPolicyId || '233825118025',
    fulfillment_policy_name: args.fulfillmentPolicyName || 'READY STOCK',
    lifecycle_state: args.lifecycleState || product.lifecycle_state || 'ready_stock',
    confirm: live ? CONFIRM.ebayPolicy : undefined,
  }, internalToken);
}

async function joomDelete(env, product, args, internalToken, serviceKey) {
  const live = args.live === true;
  const productId = String(args.joomProductId || args.joomSku || product.joom_product_id || product.sku || '').trim();
  if (!productId) return { ok: false, skipped: true, reason: 'No Joom product id or SKU available' };
  const productIds = args.productIds
    ? String(args.productIds).split(',').map((id) => id.trim()).filter(isUuid)
    : (args.joomSku ? [] : (isUuid(product.id) ? [product.id] : []));
  const result = await edgePost(env, 'joom-bridge', 'delete', {
    productId,
    product_ids: productIds,
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

function safeTestSku(baseSku, suffix = '') {
  const base = String(baseSku || 'SDV2-TEST')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42) || 'SDV2-TEST';
  const cleanSuffix = String(suffix || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '')
    .slice(0, 18);
  return cleanSuffix ? `${base}-${cleanSuffix}`.slice(0, 64) : base.slice(0, 64);
}

function uniqueJoomTestSku(product, args) {
  if (args.joomSku) return safeTestSku(args.joomSku);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  return safeTestSku(product.sku || 'SDV2-JOOM', `JOOM${stamp}`);
}

function joomPublishBody(product, args = {}) {
  const sku = uniqueJoomTestSku(product, args);
  const name = String(args.joomTitle || product.product_name || product.sku || sku).trim();
  const mainImage = String(args.mainImage || product.main_image || DEFAULT_TEST_IMAGE).trim();
  const extraImages = Array.isArray(product.extra_images) ? product.extra_images : [];
  const detailImages = [
    ...extraImages,
    args.detailImage || DEFAULT_TEST_DETAIL_IMAGE,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  return {
    row: {
      sku,
      cost: Number(args.costKrw || product.cost_krw || 16000),
      weight: Number(args.weightG || product.weight_g || 150),
    },
    scrapedAssets: {
      mainImage,
      name,
      detailImages,
      extraImages: [],
    },
    variantsConfig: [{
      name: String(args.optionName || product.option_name || 'DEFAULT').trim() || 'DEFAULT',
      sku,
      inventory: Number(args.inventory || product.inventory || 1),
      enabled: true,
      weight: Number(args.weightG || product.weight_g || 150),
      image: mainImage,
    }],
    categoryId: String(args.joomCategoryId || product.joom_category_id || 'music_albums').trim(),
    enabled: true,
    namePrefix: '',
    artist: String(args.artist || product.shopee_brand_name || 'JENNIE').trim(),
    album: String(args.album || 'Ruby').trim(),
    contents: String(args.description || product.description || 'API registration smoke-test product for starphotocard.').trim(),
    brand: String(args.brand || product.shopee_brand_name || 'JENNIE').trim(),
  };
}

async function joomRegister(env, product, args, internalToken) {
  const live = args.live === true;
  const body = joomPublishBody(product, args);
  return edgePost(env, 'joom-bridge', live ? 'publish' : 'dryrun', body, internalToken);
}

async function joomCycle(env, product, args, internalToken, serviceKey) {
  const live = args.live === true;
  const joomSku = uniqueJoomTestSku(product, args);
  const register = await joomRegister(env, product, { ...args, joomSku }, internalToken);
  if (!live) {
    return {
      ok: register.ok !== false,
      live: false,
      joom_sku: joomSku,
      register,
      delete: await joomDelete(env, product, { ...args, live: false, joomSku }, internalToken, serviceKey),
    };
  }
  if (!register?.ok || !register?.joom_product_id) {
    return { ok: false, live: true, joom_sku: joomSku, register, delete: { skipped: true, reason: 'Joom register failed or returned no product id' } };
  }
  const cleanup = await joomDelete(env, product, {
    ...args,
    live: true,
    joomSku,
    joomProductId: register.joom_product_id,
    productIds: '',
  }, internalToken, serviceKey);
  return {
    ok: register.ok !== false && cleanup.ok !== false,
    live: true,
    joom_sku: joomSku,
    register,
    delete: cleanup,
  };
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

function uniqueQoo10SellerCode(product, args) {
  if (args.sellerCode) return safeTestSku(args.sellerCode);
  if (args.qoo10SellerCode) return safeTestSku(args.qoo10SellerCode);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  return safeTestSku(product.sku || 'SDV2-QOO10', `Q10${stamp}`);
}

function qoo10RegisterBody(product, args = {}) {
  const sellerCode = uniqueQoo10SellerCode(product, args);
  const title = String(args.qoo10Title || product.product_name || product.sku || sellerCode).trim().slice(0, 100);
  const imageUrl = String(args.mainImage || product.main_image || DEFAULT_TEST_IMAGE).trim();
  return {
    category_id: String(args.qoo10CategoryId || product.qoo10_category_id || '300002851').trim(),
    title,
    seller_code: sellerCode,
    shipping_no: String(args.shippingNo || product.qoo10_shipping_no || '715009').trim(),
    main_image: imageUrl,
    description: String(args.description || product.description || 'API registration smoke-test product for starphotocard.').trim(),
    base_price_jpy: Number(args.priceJpy || args.basePriceJpy || 1290),
    stock: Number(args.inventory || product.inventory || 3),
    weight_kg: Number(args.weightKg || ((Number(args.weightG || product.weight_g || 150) || 150) / 1000)),
    production_place: 'KR',
    header_html: String(args.headerHtml || `<img src="${imageUrl}">`).trim(),
    keyword: 'KPOP,JENNIE,Ruby',
  };
}

async function qoo10Register(env, product, args, internalToken) {
  const live = args.live === true;
  const body = qoo10RegisterBody(product, args);
  if (!live) return { ok: true, dry_run: true, payload: body };
  return edgePost(env, 'qoo10-bridge', 'create-listing', body, internalToken);
}

async function qoo10Cycle(env, product, args, internalToken, platformListings, serviceKey) {
  const live = args.live === true;
  const sellerCode = uniqueQoo10SellerCode(product, args);
  let register;
  try {
    register = await qoo10Register(env, product, { ...args, sellerCode }, internalToken);
  } catch (error) {
    register = {
      ok: false,
      error: error.message || String(error),
      status: error.status || null,
      detail: error.json || null,
    };
  }
  if (!live) {
    return {
      ok: true,
      live: false,
      seller_code: sellerCode,
      register,
      delete: { skipped: true, reason: 'dry_run_payload_only' },
    };
  }
  const itemCode = String(register?.goods_no || register?.platform_item_id || register?.detail?.goods_no || register?.detail?.platform_item_id || '').trim();
  const cleanup = itemCode
    ? await qoo10Delete(env, product, { ...args, live: true, itemCode, sellerCode }, internalToken, platformListings, serviceKey)
    : { skipped: true, reason: 'register returned no item code' };
  return {
    ok: register?.ok !== false && cleanup?.ok !== false,
    live: true,
    seller_code: sellerCode,
    item_code: itemCode || null,
    register,
    delete: cleanup,
  };
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

function uniqueShopeeTestSku(product, args) {
  if (args.shopeeSku) return safeTestSku(args.shopeeSku);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  return safeTestSku(product.sku || 'SDV2-SHOPEE', `SHP${stamp}`);
}

function defaultShopeeAttributeList(categoryId) {
  const cat = Number(categoryId);
  if (cat === 100740) {
    return [
      { attribute_id: 100037, attribute_value_list: [{ value_id: 48, original_value_name: 'Korea' }] },
      { attribute_id: 100693, attribute_value_list: [{ value_id: 3574, original_value_name: 'Music & Concerts' }] },
    ];
  }
  if (cat === 101390) {
    return [
      { attribute_id: 100037, attribute_value_list: [{ value_id: 48, original_value_name: 'Korea' }] },
    ];
  }
  return [];
}

function mergeShopeeAttributeLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const attr of list) {
      const id = Number(attr?.attribute_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      byId.set(id, { ...attr, attribute_id: id });
    }
  }
  return Array.from(byId.values());
}

function resolveShopeeDaysToShip(product, args, region) {
  if (args.daysToShip) return Number(args.daysToShip);
  const value = product?.shopee_days_to_ship;
  if (value && typeof value === 'object') {
    const lifecycle = product.lifecycle_state === 'pre_order' ? 'pre_order' : 'ready_stock';
    const scoped = value[lifecycle]?.[region] ?? value[lifecycle]?.[String(region).toUpperCase()];
    if (Number.isFinite(Number(scoped))) return Number(scoped);
  }
  if (Number.isFinite(Number(value))) return Number(value);
  return 3;
}

function shopeeRegisterBody(product, args = {}) {
  const sku = uniqueShopeeTestSku(product, args);
  const region = String(args.region || 'SG').trim().toUpperCase();
  const price = Number(args.costKrw || product.cost_krw || 16000);
  const stock = Number(args.inventory || product.inventory || 3);
  const imageUrl = String(args.mainImage || product.main_image || DEFAULT_TEST_IMAGE).trim();
  const name = String(args.shopeeTitle || product.product_name || product.sku || sku).trim().slice(0, 120);
  const categoryId = Number(args.shopeeCategoryId || product.shopee_category_id || 100740);
  const brandId = Number(args.shopeeBrandId || product.shopee_brand_id || 0);
  const brandName = brandId > 0
    ? String(args.brand || product.shopee_brand_name || 'No Brand').trim()
    : 'No Brand';
  const imageId = String(args.shopeeImageId || product.shopee_image_id || '').trim();
  const attributeList = mergeShopeeAttributeLists(
    defaultShopeeAttributeList(categoryId),
    product.shopee_extra_attributes,
  );
  const daysToShip = resolveShopeeDaysToShip(product, args, region);
  const body = {
    product_id: product.id,
    account_key: args.accountKey || 'starphotocard',
    region,
    name,
    sku,
    category_id: categoryId,
    brand: { brand_id: brandId, original_brand_name: brandName },
    image_url: imageUrl,
    weight_g: Number(args.weightG || product.weight_g || 150),
    price,
    stock,
    description: String(args.description || product.shopee_description || product.description || 'API registration smoke-test product for starphotocard.').trim(),
    targets: [{
      region,
      price,
      stock,
      days_to_ship: daysToShip,
      image_url: imageUrl,
    }],
    lifecycle_state: 'ready_stock',
    is_pre_order: false,
  };
  if (attributeList.length) body.attribute_list = attributeList;
  if (imageId) {
    body.image_id = imageId;
    body.image_id_list = [imageId];
    body.targets = body.targets.map((target) => ({ ...target, image_id: imageId, image_id_list: [imageId] }));
  }
  return body;
}

function shopeeGlobalItemId(result) {
  return Number(result?.global_item_id || result?.response?.global_item_id || result?.detail?.global_item_id || result?.detail?.response?.global_item_id || 0) || null;
}

async function shopeeRegister(env, product, args, internalToken) {
  const live = args.live === true;
  const body = shopeeRegisterBody(product, args);
  if (!live) return { ok: true, dry_run: true, payload: body };
  if (!args.shopeeImageId) {
    const imageDataUrl = await fetchImageDataUrl(body.image_url);
    const upload = await edgePost(env, 'shopee-bridge', 'upload_image', {
      account_key: body.account_key,
      region: body.region,
      image_base64: imageDataUrl,
      source_url: body.image_url,
      main_image_url: body.image_url,
      layer_version: 'platform-test-cycle',
      output_hash: safeTestSku(body.sku, 'IMG'),
    }, internalToken);
    if (!upload?.ok || !upload?.image_id) {
      return { ok: false, stage: 'upload_image', upload };
    }
    body.image_id = upload.image_id;
    body.image_id_list = [upload.image_id];
    body.targets = body.targets.map((target) => ({ ...target, image_id: upload.image_id, image_id_list: [upload.image_id] }));
  }
  return edgePost(env, 'shopee-bridge', 'register_cbsc', body, internalToken);
}

async function shopeeCycle(env, product, args, internalToken) {
  const live = args.live === true;
  const shopeeSku = uniqueShopeeTestSku(product, args);
  let register;
  try {
    register = await shopeeRegister(env, product, { ...args, shopeeSku }, internalToken);
  } catch (error) {
    register = {
      ok: false,
      error: error.message || String(error),
      status: error.status || null,
      detail: error.json || null,
    };
  }
  if (!live) {
    return {
      ok: true,
      live: false,
      shopee_sku: shopeeSku,
      register,
      delete: { skipped: true, reason: 'dry_run_payload_only' },
    };
  }
  const globalItemId = shopeeGlobalItemId(register);
  let cleanup = { skipped: true, reason: 'register returned no global_item_id' };
  if (globalItemId) {
    cleanup = await edgePost(env, 'shopee-bridge', 'delete_global_item_headless', {
      account_key: args.accountKey || 'starphotocard',
      region: args.region || 'SG',
      global_item_id: globalItemId,
      dry_run: false,
      reset_local: true,
      confirm: CONFIRM.shopeeDelete,
    }, internalToken);
  }
  const publishOk = register?.ok !== false
    && Array.isArray(register?.results)
    && register.results.some((row) => row?.ok === true);
  return {
    ok: publishOk && cleanup?.ok !== false,
    live: true,
    shopee_sku: shopeeSku,
    global_item_id: globalItemId,
    register,
    delete: cleanup,
  };
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

  const internalToken = requireBridgeOperatorAuth();
  const product = await loadProduct(env, target, args, serviceKey || env.anon, { fallbackToTarget: true });
  const shopeeRows = await loadShopeeRows(env, product.id, serviceKey || env.anon);
  const platformListings = await loadPlatformListings(env, product.id, serviceKey);

  const commands = {
    'ebay-register': () => ebayRegister(env, product, args, internalToken),
    'ebay-register-dry-run': () => ebayRegisterDryRun(env, product, internalToken),
    'ebay-cycle': () => ebayCycle(env, product, args, internalToken),
    'ebay-withdraw-sku': () => ebayWithdrawSku(env, args, internalToken),
    'ebay-policy': () => ebayPolicy(env, product, args, internalToken),
    'ebay-withdraw': () => ebayWithdraw(env, product, args, internalToken),
    'joom-register': () => joomRegister(env, product, args, internalToken),
    'joom-cycle': () => joomCycle(env, product, args, internalToken, serviceKey),
    'joom-delete': () => joomDelete(env, product, args, internalToken, serviceKey),
    'qoo10-register': () => qoo10Register(env, product, args, internalToken),
    'qoo10-cycle': () => qoo10Cycle(env, product, args, internalToken, platformListings, serviceKey),
    'qoo10-delete': () => qoo10Delete(env, product, args, internalToken, platformListings, serviceKey),
    'shopee-register': () => shopeeRegister(env, product, args, internalToken),
    'shopee-cycle': () => shopeeCycle(env, product, args, internalToken),
    'shopee-delete': () => shopeeDelete(env, product, args, internalToken, shopeeRows),
    'dry-run-all': async () => {
      const qoo10DrySellerCode = uniqueQoo10SellerCode(product, args);
      return {
        ok: true,
        live: false,
        ebay_register: await ebayRegisterDryRun(env, product, internalToken),
        ebay_cycle: await ebayCycle(env, product, { ...args, live: false }, internalToken),
        ebay_policy: await ebayPolicy(env, product, { ...args, live: false }, internalToken),
        ebay_withdraw: await ebayWithdraw(env, product, { ...args, live: false }, internalToken),
        joom_register: await joomRegister(env, product, { ...args, live: false }, internalToken),
        joom_delete: await joomDelete(env, product, { ...args, live: false }, internalToken, serviceKey),
        qoo10_register: await qoo10Register(env, product, { ...args, live: false, sellerCode: qoo10DrySellerCode }, internalToken),
        qoo10_delete: await qoo10Delete(env, product, { ...args, live: false, itemCode: args.itemCode || '1234567890', sellerCode: qoo10DrySellerCode }, internalToken, platformListings, serviceKey),
        shopee_register: await shopeeRegister(env, product, { ...args, live: false }, internalToken),
        shopee_delete: await shopeeDelete(env, product, { ...args, live: false }, internalToken, shopeeRows),
      };
    },
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
    throw new Error(`Unknown command '${command}'. Use inspect, inspect --pack shopee-registration, inspect --pack price-sync, inspect --pack joom-registration, ensure-product, dry-run-all, ebay-register, ebay-register-dry-run, ebay-cycle, ebay-withdraw-sku, ebay-policy, ebay-withdraw, joom-register, joom-cycle, joom-delete, qoo10-register, qoo10-cycle, qoo10-delete, shopee-register, shopee-cycle, shopee-delete, cleanup-all.`);
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
