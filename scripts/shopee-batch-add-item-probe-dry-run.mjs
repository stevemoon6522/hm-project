import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const v2Path = join(repoRoot, 'v2', 'index.html');

const DEFAULT_PRODUCT_DOC_ROOT = 'C:/dev/api-refs/marketplaces/shopee/docs_ai/apis/product';
const DEFAULT_GLOBAL_DOC_ROOT = 'C:/dev/api-refs/marketplaces/shopee/docs_ai/apis/global_product';
const ADD_DOC = 'v2.product.batch_add_item.json';
const RESULT_DOC = 'v2.product.get_batch_task_result.json';
const GLOBAL_ADD_DOC = 'v2.global_product.add_global_item.json';
const OPERATING_REGIONS = new Set(['SG', 'TW', 'TH', 'MY', 'PH', 'BR']);

function usage() {
  return `Usage:
  node scripts/shopee-batch-add-item-probe-dry-run.mjs --sample [--json]
  node scripts/shopee-batch-add-item-probe-dry-run.mjs --input path.json [--region SG] [--logistic-id 80007] [--json]
  node scripts/shopee-batch-add-item-probe-dry-run.mjs --from-db --sku SKU --region SG [--logistic-id 80007] [--json]
  node scripts/shopee-batch-add-item-probe-dry-run.mjs --from-lookup --sku SKU --region SG [--json]

This script is non-mutating. It never calls Shopee batch_add_item or product.add_item.`;
}

function parseArgs(argv) {
  const args = {
    sample: false,
    input: '',
    fromDb: false,
    fromLookup: false,
    sku: '',
    productId: '',
    region: 'SG',
    accountKey: '',
    price: null,
    logisticId: '',
    logisticName: '',
    itemStatus: 'UNLIST',
    json: false,
    lookupMaxItems: 1,
    lookupMaxGlobalItems: 1,
    productDocRoot: process.env.SHOPEE_API_REFS_PRODUCT_DIR || DEFAULT_PRODUCT_DOC_ROOT,
    globalDocRoot: process.env.SHOPEE_API_REFS_GLOBAL_PRODUCT_DIR || DEFAULT_GLOBAL_DOC_ROOT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${token}`);
      i += 1;
      return argv[i];
    };

    if (token === '--sample') args.sample = true;
    else if (token === '--input') args.input = next();
    else if (token === '--from-db') args.fromDb = true;
    else if (token === '--from-lookup') args.fromLookup = true;
    else if (token === '--sku') args.sku = next();
    else if (token === '--product-id') args.productId = next();
    else if (token === '--region') args.region = String(next()).toUpperCase();
    else if (token === '--account-key') args.accountKey = next();
    else if (token === '--price') args.price = Number(next());
    else if (token === '--logistic-id') args.logisticId = next();
    else if (token === '--logistic-name') args.logisticName = next();
    else if (token === '--item-status') args.itemStatus = String(next()).toUpperCase();
    else if (token === '--json') args.json = true;
    else if (token === '--lookup-max-items') args.lookupMaxItems = Number(next());
    else if (token === '--lookup-max-global-items') args.lookupMaxGlobalItems = Number(next());
    else if (token === '--product-doc-root') args.productDocRoot = next();
    else if (token === '--global-doc-root') args.globalDocRoot = next();
    else if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  const selectedModes = [args.sample, Boolean(args.input), args.fromDb, args.fromLookup].filter(Boolean).length;
  if (selectedModes > 1) throw new Error('Choose only one input mode: --sample, --input, --from-db, or --from-lookup');
  if (!OPERATING_REGIONS.has(args.region)) throw new Error(`Unsupported region ${args.region}. Expected one of ${[...OPERATING_REGIONS].join(', ')}`);
  if (args.fromDb && !args.sku && !args.productId) throw new Error('--from-db requires --sku or --product-id');
  if (args.fromLookup && !args.sku) throw new Error('--from-lookup requires --sku');
  if (args.price != null && (!Number.isFinite(args.price) || args.price <= 0)) throw new Error('--price must be a positive number when provided');
  if (!['UNLIST', 'NORMAL'].includes(args.itemStatus)) throw new Error('--item-status must be UNLIST or NORMAL');
  if (args.logisticId && (!Number.isFinite(Number(args.logisticId)) || Number(args.logisticId) <= 0)) throw new Error('--logistic-id must be a positive number');

  if (!args.sample && !args.input && !args.fromDb && !args.fromLookup) args.sample = true;
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function readV2Env() {
  const html = readFileSync(v2Path, 'utf8');
  const pick = (name) => html.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'`))?.[1] || '';
  const supabaseUrl = pick('SUPABASE_URL');
  const supabaseAnon = pick('SUPABASE_ANON');
  const defaultAccountKey = pick('SHOPEE_DEFAULT_ACCOUNT_KEY') || 'starphotocard';
  if (!supabaseUrl || !supabaseAnon) throw new Error('SUPABASE_URL or SUPABASE_ANON not found in v2/index.html');
  return { supabaseUrl, supabaseAnon, defaultAccountKey };
}

function shopeeBridgeUrl(env) {
  return `${env.supabaseUrl.replace(/\/$/, '')}/functions/v1/shopee-bridge`;
}

function validateDocs(args) {
  const addDocPath = join(args.productDocRoot, ADD_DOC);
  const resultDocPath = join(args.productDocRoot, RESULT_DOC);
  const globalAddDocPath = join(args.globalDocRoot, GLOBAL_ADD_DOC);
  const addDoc = readJson(addDocPath);
  const resultDoc = readJson(resultDocPath);
  const globalAddDoc = readJson(globalAddDocPath);

  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const required = addDoc.request?.required_params || [];
  expect(addDoc.api?.path === '/api/v2/product/batch_add_item', 'batch_add_item doc path mismatch');
  expect(addDoc.api?.method === 'POST', 'batch_add_item doc method must be POST');
  expect(addDoc.api?.task_type === 4, 'batch_add_item doc task_type must be 4');
  expect(addDoc.auth?.auth_scope === 'shop', 'batch_add_item must be a shop-auth API');
  expect(addDoc.request?.limits?.item_list_max === 100, 'batch_add_item item_list_max must be 100');
  for (const token of [
    'item_list',
    'item_list[].original_price',
    'item_list[].description',
    'item_list[].weight',
    'item_list[].item_name',
    'item_list[].logistic_info',
    'item_list[].category_id',
    'item_list[].image',
  ]) {
    expect(required.includes(token), `batch_add_item doc missing required param: ${token}`);
  }

  const taskTypeParam = (resultDoc.request?.query_params || []).find((p) => p.name === 'task_type');
  expect(resultDoc.api?.path === '/api/v2/product/get_batch_task_result', 'task result doc path mismatch');
  expect((taskTypeParam?.enum_values || []).some((row) => row.value === 4 && row.label === 'add item'), 'task result doc missing task_type=4 add item enum');

  expect(globalAddDoc.api?.path === '/api/v2/global_product/add_global_item', 'current V2 global add doc path mismatch');
  expect(globalAddDoc.auth?.auth_scope === 'merchant', 'current V2 global add doc must be merchant-auth');

  return {
    ok: failures.length === 0,
    failures,
    files: {
      batch_add_item: addDocPath,
      batch_task_result: resultDocPath,
      current_v2_global_add_item: globalAddDocPath,
    },
  };
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return stringArray(parsed);
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  if (value == null) return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeAttributeList(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function sampleFixture() {
  return {
    rawResponse: {
      computed_payload: {
        account_key: 'starphotocard',
        region: 'SG',
        name: 'Dry probe sample product',
        sku: 'DRY-BATCH-ADD-SAMPLE',
        category_id: 100740,
        image_id_list: ['sg_sample_image_id'],
        weight_g: 100,
        price: 26.39,
        stock: 3,
        description: 'Dry probe sample description.',
        attribute_list: [],
        lifecycle_state: 'ready_stock',
        is_pre_order: false,
        targets: [
          {
            region: 'SG',
            shop_id: 1001961186,
            price: 26.39,
            days_to_ship: 2,
            logistic_info: [
              { logistic_id: 80007, enabled: true, is_free: false },
            ],
          },
        ],
      },
    },
  };
}

function extractPayload(raw) {
  const payload =
    raw?.rawResponse?.computed_payload
    || raw?.raw_response?.computed_payload
    || raw?.computed_payload
    || raw?.register_cbsc
    || raw?.payload
    || raw?.add_item
    || raw?.item
    || raw;

  let sourceShape = 'unknown';
  if (Array.isArray(payload?.item_list)) sourceShape = 'prebuilt_batch_add_item';
  else if (payload?.global_item_name || payload?.global_item_sku) sourceShape = 'global_product_add_item_like';
  else if (payload?.name && Array.isArray(payload?.targets)) sourceShape = 'current_v2_register_cbsc';
  else if (payload?.item_name) sourceShape = 'shop_product_add_item_like';

  return { payload, sourceShape };
}

function pickTarget(payload, region) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  return targets.find((row) => String(row?.region || '').toUpperCase() === region)
    || targets[0]
    || {};
}

function normalizeLogisticInfo(source, args) {
  const list = Array.isArray(source) ? source : [];
  const normalized = list
    .map((row) => {
      const logisticId = Number(row?.logistic_id ?? row?.logistics_channel_id ?? row?.channel_id ?? row?.id);
      if (!Number.isFinite(logisticId) || logisticId <= 0) return null;
      const next = {
        logistic_id: logisticId,
        enabled: row?.enabled !== false,
      };
      if (row?.shipping_fee != null && Number.isFinite(Number(row.shipping_fee))) next.shipping_fee = Number(row.shipping_fee);
      if (row?.is_free != null) next.is_free = row.is_free === true;
      return next;
    })
    .filter(Boolean);

  if (normalized.length) return { rows: normalized, source: 'input' };
  if (args.logisticId) {
    return {
      rows: [
        {
          logistic_id: Number(args.logisticId),
          enabled: true,
          is_free: false,
        },
      ],
      source: 'operator_cli_placeholder',
    };
  }
  return { rows: [], source: 'missing' };
}

function hasVariation(payload, target) {
  const source = target?.variation || payload?.variation;
  return Boolean(
    source
    && Array.isArray(source.tier_variation)
    && Array.isArray(source.model)
    && source.tier_variation.length
    && source.model.length,
  );
}

function buildFromPrebuiltItemList(payload, input) {
  return {
    request: { item_list: payload.item_list },
    inferred_fields: [],
    unmapped_current_v2_fields: [],
    has_variation: false,
    correlation: {
      account_key: input.account_key,
      region: input.region,
      sku: payload.item_list?.[0]?.item_sku || input.sku || null,
      product_id: input.product_id || null,
      shop_id: input.shop_id || null,
      source_shape: input.sourceShape,
    },
  };
}

function buildBatchAddItemPayload(input, args) {
  const payload = input.payload || {};
  if (Array.isArray(payload.item_list)) return buildFromPrebuiltItemList(payload, input);

  const region = input.region;
  const target = pickTarget(payload, region);
  const imageIds = stringArray(
    payload?.image?.image_id_list
    || payload?.image_id_list
    || payload?.image_id
    || target?.image_id_list
    || target?.image_id,
  );
  const logistic = normalizeLogisticInfo(target?.logistic_info || target?.logistic || payload?.logistic_info || payload?.logistic, args);
  const isPreOrder = payload?.is_pre_order === true || target?.is_pre_order === true || String(payload?.lifecycle_state || '').toLowerCase() === 'pre_order';
  const daysToShip = firstPositiveNumber(target?.days_to_ship, payload?.days_to_ship, payload?.pre_order?.days_to_ship, isPreOrder ? 10 : 2);
  const price = firstPositiveNumber(args.price, target?.price, payload?.original_price, payload?.price, payload?.global_price, payload?.cost_krw);
  const stock = Number(payload?.stock ?? target?.stock ?? payload?.seller_stock?.[0]?.stock ?? 0);
  const weight = firstPositiveNumber(payload?.weight, payload?.weight_kg, Number(payload?.weight_g || 0) / 1000);

  const item = {
    item_name: sanitizeText(payload?.item_name || payload?.name || payload?.global_item_name),
    description: sanitizeText(payload?.description) || sanitizeText(payload?.name || payload?.item_name || payload?.global_item_name),
    item_sku: sanitizeText(payload?.item_sku || payload?.sku || payload?.global_item_sku),
    category_id: Number(payload?.category_id),
    original_price: price,
    weight,
    image: { image_id_list: imageIds },
    item_status: args.itemStatus,
    condition: payload?.condition || 'NEW',
    pre_order: { is_pre_order: isPreOrder, days_to_ship: daysToShip },
  };

  const inferredFields = [];
  const dimension = payload?.dimension || {};
  const hasDimension = dimension.package_length || dimension.package_width || dimension.package_height
    || payload.package_length_cm || payload.package_width_cm || payload.package_height_cm;
  if (hasDimension) {
    item.dimension = {
      package_length: Number(payload.package_length_cm ?? dimension.package_length) || 20,
      package_width: Number(payload.package_width_cm ?? dimension.package_width) || 15,
      package_height: Number(payload.package_height_cm ?? dimension.package_height) || 5,
    };
  } else {
    item.dimension = { package_length: 20, package_width: 15, package_height: 5 };
    inferredFields.push('item_list[].dimension defaulted to current shopee-bridge add_item defaults 20x15x5 cm');
  }
  if (Number.isFinite(stock) && stock >= 0) item.seller_stock = [{ stock }];
  if (logistic.rows.length) item.logistic_info = logistic.rows;
  if (normalizeAttributeList(payload?.attribute_list).length) item.attribute_list = normalizeAttributeList(payload.attribute_list);

  const unmapped = [];
  for (const field of ['brand', 'targets', 'global_item_id', 'existing_global_item_id', 'publish_existing_global_only']) {
    if (payload[field] != null) unmapped.push(field);
  }
  const variationLike = hasVariation(payload, target) || payload.lookup_has_model === true;
  if (variationLike) unmapped.push(payload.lookup_has_model === true ? 'lookup_has_model' : 'variation');
  if (logistic.source === 'operator_cli_placeholder') inferredFields.push('item_list[].logistic_info supplied by --logistic-id placeholder, not discovered from Shopee logistics read API');

  return {
    request: { item_list: [item] },
    inferred_fields: inferredFields,
    unmapped_current_v2_fields: unmapped,
    has_variation: variationLike,
    logistic_source: logistic.source,
    correlation: {
      account_key: input.account_key,
      region,
      shop_id: Number(target?.shop_id || input.shop_id || 0) || null,
      product_id: input.product_id || null,
      sku: item.item_sku || input.sku || null,
      item_name: item.item_name || null,
      existing_global_item_id: Number(payload?.global_item_id || payload?.existing_global_item_id || input.global_item_id || 0) || null,
      existing_shop_item_id: Number(input.shop_item_id || target?.item_id || 0) || null,
      source_shape: input.sourceShape,
    },
  };
}

function validateBatchAddPayload(batch) {
  const failures = [];
  const warnings = [];
  const missing = [];
  const itemList = batch.request.item_list;
  if (!Array.isArray(itemList)) failures.push('item_list must be an array');
  if (!itemList?.length || itemList.length > 100) failures.push('item_list length must be between 1 and 100');

  (itemList || []).forEach((item, idx) => {
    const requireText = (path, value) => {
      if (!String(value || '').trim()) {
        missing.push(path);
        failures.push(`${path} is required`);
      }
    };
    const requirePositive = (path, value) => {
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        missing.push(path);
        failures.push(`${path} must be greater than 0`);
      }
    };

    requirePositive(`item_list[${idx}].original_price`, item.original_price);
    requireText(`item_list[${idx}].description`, item.description);
    requirePositive(`item_list[${idx}].weight`, item.weight);
    requireText(`item_list[${idx}].item_name`, item.item_name);
    requirePositive(`item_list[${idx}].category_id`, item.category_id);
    if (!item.image || !Array.isArray(item.image.image_id_list) || !item.image.image_id_list.length) {
      missing.push(`item_list[${idx}].image.image_id_list`);
      failures.push(`item_list[${idx}].image.image_id_list is required`);
    }
    if (!Array.isArray(item.logistic_info) || !item.logistic_info.length) {
      missing.push(`item_list[${idx}].logistic_info`);
      failures.push(`item_list[${idx}].logistic_info is required`);
    }
    (item.logistic_info || []).forEach((row, lidx) => {
      requirePositive(`item_list[${idx}].logistic_info[${lidx}].logistic_id`, row.logistic_id);
      if (typeof row.enabled !== 'boolean') failures.push(`item_list[${idx}].logistic_info[${lidx}].enabled must be boolean`);
    });
    if (Array.isArray(item.seller_stock)) {
      item.seller_stock.forEach((row, sidx) => {
        if (!Number.isFinite(Number(row.stock)) || Number(row.stock) < 0) failures.push(`item_list[${idx}].seller_stock[${sidx}].stock must be >= 0`);
      });
    } else {
      warnings.push(`item_list[${idx}].seller_stock is optional in captured doc but operationally expected for registration`);
    }
  });

  if (batch.has_variation) {
    warnings.push('Captured batch_add_item doc has no tier_variation/model fields; option-group mapping is unverified and blocked for this probe.');
  }
  if (batch.correlation.existing_shop_item_id) {
    warnings.push('Source product is already registered in Shopee; a future live batch_add_item call could create a duplicate item and needs a burnable target.');
  }

  return {
    request_shape_ok: failures.length === 0,
    failures,
    missing_required_paths: [...new Set(missing)],
    warnings,
  };
}

function compatibilityStatus(batch, validation) {
  const blockingReasons = [];
  if (batch.has_variation) blockingReasons.push('option_group_mapping_unverified');
  if (validation.missing_required_paths.length) blockingReasons.push('missing_required_batch_add_item_fields');

  let status = 'shape_ready_but_not_cbsc_replacement';
  if (batch.has_variation) status = 'blocked_option_group_unmapped';
  else if (validation.missing_required_paths.length) status = 'blocked_missing_required_fields';

  return {
    status,
    request_shape_ok: validation.request_shape_ok,
    current_v2_replacement_ready: false,
    blocking_reasons: blockingReasons,
    reason_current_v2_replacement_ready_false: [
      'Current V2 primary registration uses merchant-auth global_product.add_global_item, then create_publish_task per region.',
      'batch_add_item is a shop-auth Product API and returns an async task_id, not a global_item_id.',
      'Captured batch_add_item doc does not describe CBSC Global Product publish or option-group setup.',
    ],
  };
}

function sampleInput(args, env) {
  return normalizeInput(sampleFixture(), args, env, 'sample-fixture');
}

function normalizeInput(raw, args, env, source) {
  const { payload, sourceShape } = extractPayload(raw);
  const target = pickTarget(payload, args.region);
  return {
    source,
    payload,
    sourceShape,
    region: args.region,
    account_key: args.accountKey || payload.account_key || raw.account_key || env.defaultAccountKey,
    product_id: raw.product_id || raw.product?.id || payload.product_id || null,
    sku: raw.sku || raw.product?.sku || payload.sku || payload.item_sku || payload.global_item_sku || null,
    shop_id: Number(target.shop_id || raw.shop_id || 0) || null,
    shop_item_id: Number(raw.shop_item_id || raw.listing?.shop_item_id || 0) || null,
    global_item_id: Number(raw.global_item_id || raw.listing?.global_item_id || payload.global_item_id || 0) || null,
  };
}

async function restGet(env, table, query) {
  const url = `${env.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?${query}`;
  const resp = await fetch(url, {
    headers: {
      apikey: env.supabaseAnon,
      Authorization: `Bearer ${env.supabaseAnon}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${table} read failed HTTP ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function loadFromDb(args, env) {
  const productFilter = args.productId
    ? `id=eq.${encodeURIComponent(args.productId)}`
    : `sku=eq.${encodeURIComponent(args.sku)}`;
  const products = await restGet(
    env,
    'products',
    [
      'select=id,sku,product_name,option_name,description,cost_krw,weight_g,inventory,lifecycle_state,shopee_category_id,shopee_image_id,shopee_extra_image_ids,shopee_description,shopee_days_to_ship,shopee_extra_attributes',
      productFilter,
      'limit=2',
    ].join('&'),
  );
  if (!Array.isArray(products) || products.length === 0) throw new Error('No product found for requested selector');
  if (products.length > 1) throw new Error('Multiple products matched. Use --product-id for an exact dry probe.');

  const product = products[0];
  const accountKey = args.accountKey || env.defaultAccountKey;
  const listings = await restGet(
    env,
    'product_shopee_listings',
    [
      'select=product_id,account_key,region,shop_id,shop_item_id,shop_model_id,global_item_id,global_model_id,status,last_synced_price,last_synced_at',
      `product_id=eq.${encodeURIComponent(product.id)}`,
      `account_key=eq.${encodeURIComponent(accountKey)}`,
      `region=eq.${encodeURIComponent(args.region)}`,
      'limit=2',
    ].join('&'),
  );
  const listing = Array.isArray(listings) && listings.length ? listings[0] : {};
  const imageIds = [
    product.shopee_image_id,
    ...(Array.isArray(product.shopee_extra_image_ids) ? product.shopee_extra_image_ids : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
  const lifecycle = String(product.lifecycle_state || '').toLowerCase() === 'pre_order' ? 'pre_order' : 'ready_stock';
  const price = firstPositiveNumber(args.price, listing.last_synced_price, product.cost_krw);
  const payload = {
    account_key: accountKey,
    region: args.region,
    name: product.product_name || product.option_name || product.sku,
    sku: product.sku,
    category_id: product.shopee_category_id,
    image_id_list: imageIds,
    weight_g: product.weight_g,
    price,
    stock: Number(product.inventory || 0),
    description: product.shopee_description || product.description || product.product_name || product.sku,
    attribute_list: Array.isArray(product.shopee_extra_attributes) ? product.shopee_extra_attributes : [],
    lifecycle_state: lifecycle,
    is_pre_order: lifecycle === 'pre_order',
    targets: [
      {
        region: args.region,
        shop_id: Number(listing.shop_id || 0) || null,
        price,
        days_to_ship: firstPositiveNumber(product.shopee_days_to_ship, lifecycle === 'pre_order' ? 10 : 2),
      },
    ],
    global_item_id: Number(listing.global_item_id || 0) || null,
  };

  return normalizeInput({
    payload,
    product,
    listing,
    product_id: product.id,
    sku: product.sku,
    shop_item_id: listing.shop_item_id,
    global_item_id: listing.global_item_id,
  }, args, env, 'supabase-readonly');
}

async function loadFromLookup(args, env) {
  const accountKey = args.accountKey || env.defaultAccountKey;
  const params = new URLSearchParams({
    sku: args.sku,
    regions: args.region,
    account_key: accountKey,
    max_items: String(Math.max(1, Math.min(5000, Math.floor(args.lookupMaxItems || 1)))),
    max_global_items: String(Math.max(1, Math.min(1000, Math.floor(args.lookupMaxGlobalItems || 1)))),
  });
  const resp = await fetch(`${shopeeBridgeUrl(env)}/lookup-sku?${params}`, {
    headers: {
      apikey: env.supabaseAnon,
      Authorization: `Bearer ${env.supabaseAnon}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parse_error: text };
  }
  if (!resp.ok || !json?.ok) throw new Error(`lookup-sku failed HTTP ${resp.status}: ${text}`);

  const row = (Array.isArray(json.region_results) ? json.region_results : [])
    .find((entry) => String(entry?.region || '').toUpperCase() === args.region);
  const hit = row?.hit || (Array.isArray(json.region_hits)
    ? json.region_hits.find((entry) => String(entry?.region || '').toUpperCase() === args.region)
    : null);
  if (!hit) throw new Error(`No lookup hit for sku=${args.sku} region=${args.region}`);

  const payload = {
    account_key: json.account_key || accountKey,
    region: args.region,
    name: hit.item_name || json.global_lookup?.hit?.item_name || args.sku,
    sku: hit.item_sku || hit.model_sku || hit.global_model_sku || args.sku,
    price: firstPositiveNumber(args.price, hit.current_price, hit.original_price),
    stock: 0,
    lifecycle_state: 'ready_stock',
    lookup_has_model: hit.has_model === true || Boolean(hit.model_id || hit.shop_model_id || hit.global_model_id),
    targets: [
      {
        region: args.region,
        shop_id: Number(hit.shop_id || 0) || null,
        price: firstPositiveNumber(args.price, hit.current_price, hit.original_price),
        days_to_ship: 2,
      },
    ],
    global_item_id: Number(hit.global_item_id || 0) || null,
  };

  return normalizeInput({
    payload,
    sku: args.sku,
    shop_item_id: hit.shop_item_id || hit.item_id,
    global_item_id: hit.global_item_id,
  }, args, env, 'bridge-lookup-readonly');
}

function loadInput(args, env) {
  if (args.sample) return sampleInput(args, env);
  if (args.input) return normalizeInput(readJson(resolve(args.input)), args, env, 'local-input');
  throw new Error('No input mode selected');
}

function toOutput({ args, env, docs, input, batch, validation }) {
  const compatibility = compatibilityStatus(batch, validation);
  return {
    ok: docs.ok && validation.request_shape_ok && !batch.has_variation,
    mode: 'dry-run',
    source: input.source,
    will_call_shopee: false,
    will_call_shopee_add_item_api: false,
    will_mutate_listing: false,
    docs,
    current_v2_flow: {
      route: 'shopee-bridge/register_cbsc',
      apis: [
        '/api/v2/global_product/add_global_item',
        '/api/v2/global_product/init_tier_variation',
        '/api/v2/global_product/add_global_model',
        '/api/v2/global_product/create_publish_task',
        '/api/v2/global_product/get_publish_task_result',
      ],
      auth_scope: 'merchant',
    },
    candidate_batch_add_item_flow: {
      path: '/api/v2/product/batch_add_item',
      auth_scope: 'shop',
      task_result: {
        path: '/api/v2/product/get_batch_task_result',
        task_type: 4,
        task_id: '<task_id returned by batch_add_item>',
      },
    },
    selected: {
      account_key: input.account_key,
      region: input.region,
      source_shape: input.sourceShape,
      product_id: input.product_id || null,
      sku: batch.correlation.sku,
      shop_id: batch.correlation.shop_id,
      existing_shop_item_id: batch.correlation.existing_shop_item_id,
      existing_global_item_id: batch.correlation.existing_global_item_id,
    },
    future_batch_add_item: {
      method: 'POST',
      path: '/api/v2/product/batch_add_item',
      body: batch.request,
    },
    future_get_batch_task_result: {
      endpoint: 'shopee-bridge/batch_task_result',
      query: {
        account_key: input.account_key,
        region: input.region,
        task_type: 4,
        task_id: '<task_id returned by batch_add_item>',
      },
    },
    payload_validation: validation,
    compatibility,
    inferred_fields: batch.inferred_fields,
    unmapped_current_v2_fields: batch.unmapped_current_v2_fields,
    correlation_key: batch.correlation,
    safety_notes: [
      'This script did not call Shopee batch_add_item or product.add_item.',
      'A future live probe would create a real shop item and must use a burnable target plus explicit operator approval.',
      'Do not replace current CBSC registration unless Shopee confirms how batch_add_item relates to Global Product publish and option groups.',
    ],
  };
}

function printHuman(out) {
  console.log('Shopee batch_add_item dry probe');
  console.log('===============================');
  console.log(`ok: ${out.ok}`);
  console.log(`source: ${out.source}`);
  console.log(`will_call_shopee: ${out.will_call_shopee}`);
  console.log(`will_call_shopee_add_item_api: ${out.will_call_shopee_add_item_api}`);
  console.log(`docs_ok: ${out.docs.ok}`);
  console.log(`request_shape_ok: ${out.payload_validation.request_shape_ok}`);
  console.log(`compatibility_status: ${out.compatibility.status}`);
  console.log(`current_v2_replacement_ready: ${out.compatibility.current_v2_replacement_ready}`);
  if (out.payload_validation.failures.length) {
    console.log('');
    console.log('Validation failures');
    for (const failure of out.payload_validation.failures) console.log(`- ${failure}`);
  }
  if (out.payload_validation.warnings.length) {
    console.log('');
    console.log('Warnings');
    for (const warning of out.payload_validation.warnings) console.log(`- ${warning}`);
  }
  console.log('');
  console.log('Selected source');
  console.log(JSON.stringify(out.selected, null, 2));
  console.log('');
  console.log('Future batch_add_item body (not sent)');
  console.log(JSON.stringify(out.future_batch_add_item.body, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readV2Env();
  const docs = validateDocs(args);
  const input = args.fromDb ? await loadFromDb(args, env) : (args.fromLookup ? await loadFromLookup(args, env) : loadInput(args, env));
  const batch = buildBatchAddItemPayload(input, args);
  const validation = validateBatchAddPayload(batch);
  const out = toOutput({ args, env, docs, input, batch, validation });
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else printHuman(out);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
