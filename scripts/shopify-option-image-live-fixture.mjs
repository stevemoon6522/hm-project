const DEFAULT_SUPABASE_URL = 'https://mgqlwgnmwegzsjelbrih.supabase.co';
const DEFAULT_IMAGE_CANDIDATES = [
  'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png',
  'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png',
  'https://cdn.shopify.com/s/files/1/0070/7032/files/shopify-logo.png',
  'https://placehold.co/800x800/png?text=Shopify+Option+A',
  'https://placehold.co/800x800/png?text=Shopify+Option+B',
];

function usage() {
  return `Usage:
  node scripts/shopify-option-image-live-fixture.mjs [--dry-run] [--keep]
  node scripts/shopify-option-image-live-fixture.mjs --help

Creates a disposable Shopify Draft product through shopify-bridge/create-product,
verifies two option variants received media.nodes, then archives the product.

Options:
  --dry-run  Call create-product with dry_run:true and verify payload shape only.
  --keep     Do not archive the created product after a live run.
  --help     Show this help.

Environment:
  SUPABASE_URL                    Optional. Defaults to ${DEFAULT_SUPABASE_URL}
  PLATFORM_BRIDGE_INTERNAL_TOKEN  Required unless --help.
  SHOPIFY_SHOP_DOMAIN             Optional. Sent as shop_domain when present.
  SHOPIFY_OPTION_IMAGE_A_URL      Optional first fixture image URL.
  SHOPIFY_OPTION_IMAGE_B_URL      Optional second fixture image URL.
  SHOPIFY_OPTION_IMAGE_URLS       Optional comma-separated extra fixture image URLs.`;
}

function parseArgs(argv) {
  const args = { dryRun: false, keep: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function norm(value) {
  return String(value ?? '').trim();
}

function stripTrailingSlash(value) {
  return norm(value).replace(/\/+$/, '');
}

function splitCsv(value) {
  return norm(value).split(',').map((part) => part.trim()).filter(Boolean);
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = norm(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function fixtureImageCandidates() {
  return unique([
    process.env.SHOPIFY_OPTION_IMAGE_A_URL,
    process.env.SHOPIFY_OPTION_IMAGE_B_URL,
    ...splitCsv(process.env.SHOPIFY_OPTION_IMAGE_URLS),
    ...DEFAULT_IMAGE_CANDIDATES,
  ]);
}

async function validateImageUrl(url) {
  if (!/^https:\/\//i.test(url)) return { ok: false, url, error: 'image_url_must_be_https' };
  const methods = ['HEAD', 'GET'];
  for (const method of methods) {
    try {
      const headers = method === 'GET' ? { Range: 'bytes=0-0' } : undefined;
      const response = await fetch(url, {
        method,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const contentType = response.headers.get('content-type') || '';
      if (response.ok && /^image\//i.test(contentType)) {
        return { ok: true, url: response.url || url, status: response.status, method, content_type: contentType };
      }
      if (method === 'GET' && response.ok && !contentType) {
        return { ok: true, url: response.url || url, status: response.status, method, content_type: null };
      }
    } catch (error) {
      if (method === 'GET') return { ok: false, url, error: error.message || String(error) };
    }
  }
  return { ok: false, url, error: 'image_url_not_reachable' };
}

async function pickFixtureImages() {
  const diagnostics = [];
  const selected = [];
  for (const candidate of fixtureImageCandidates()) {
    const result = await validateImageUrl(candidate);
    diagnostics.push(result);
    if (result.ok && !selected.some((url) => url.toLowerCase() === result.url.toLowerCase())) {
      selected.push(result.url);
      if (selected.length === 2) return selected;
    }
  }
  const errors = diagnostics
    .filter((row) => !row.ok)
    .slice(0, 5)
    .map((row) => ({ url: row.url, error: row.error }));
  throw new Error(`Need two reachable public fixture images. Checked: ${JSON.stringify(errors)}`);
}

function randomSuffix() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${stamp}-${rand}`;
}

function buildPayload({ images, suffix, dryRun }) {
  const title = `Codex Shopify option image fixture ${suffix}`;
  const skuBase = `CODEX-OPTIMG-${suffix}`.replace(/[^A-Z0-9_-]/gi, '-').slice(0, 56);
  const skus = [`${skuBase}-A`, `${skuBase}-B`];
  const payload = {
    product: {
      title,
      status: 'DRAFT',
      vendor: 'starphotocard',
      productType: 'Codex Fixture',
      tags: ['codex-fixture', 'option-image-test'],
      descriptionHtml: '<p>Disposable Shopify option image registration fixture.</p>',
      productOptions: [{ name: 'Version', values: [{ name: 'A' }, { name: 'B' }] }],
    },
    media: [
      { originalSource: images[0], alt: `${title} Version A` },
      { originalSource: images[1], alt: `${title} Version B` },
    ],
    variants: [
      {
        sku: skus[0],
        price: '9.99',
        optionValues: [{ optionName: 'Version', name: 'A' }],
        mediaSrc: [images[0]],
      },
      {
        sku: skus[1],
        price: '10.99',
        optionValues: [{ optionName: 'Version', name: 'B' }],
        mediaSrc: [images[1]],
      },
    ],
    set_inventory: false,
    publish: false,
    cleanup_on_variant_failure: true,
    dry_run: dryRun,
  };
  const shopDomain = norm(process.env.SHOPIFY_SHOP_DOMAIN);
  if (shopDomain) payload.shop_domain = shopDomain;
  return { payload, skus };
}

class BridgeError extends Error {
  constructor(action, status, body) {
    super(`${action} failed with HTTP ${status}: ${compactBody(body)}`);
    this.action = action;
    this.status = status;
    this.body = body;
  }
}

function compactBody(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function compactError(error) {
  if (error instanceof BridgeError) {
    return {
      action: error.action,
      status: error.status,
      body: compactBody(error.body),
    };
  }
  return { message: error.message || String(error) };
}

async function postBridge({ supabaseUrl, token, action, body }) {
  const response = await fetch(`${supabaseUrl}/functions/v1/shopify-bridge/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-platform-bridge-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw_text: text };
  }
  if (!response.ok || json?.ok === false) {
    throw new BridgeError(action, response.status, json);
  }
  return json;
}

function assertDryRunShape(result, expectedSkus) {
  if (result?.ok !== true || result?.dry_run !== true) throw new Error('dry_run create-product did not return ok:true dry_run:true');
  const create = result.payload?.productCreate || {};
  const variants = result.payload?.productVariantsBulkCreate?.variants;
  if (create.product?.status !== 'DRAFT') throw new Error('dry_run payload product status is not DRAFT');
  if (!Array.isArray(create.product?.productOptions) || create.product.productOptions[0]?.name !== 'Version') {
    throw new Error('dry_run payload is missing Version product option');
  }
  if (!Array.isArray(variants) || variants.length !== 2) throw new Error('dry_run payload must include two variants');
  for (const [index, variant] of variants.entries()) {
    if (variant.inventoryItem?.sku !== expectedSkus[index]) throw new Error(`dry_run variant ${index} SKU mismatch`);
    if (!Array.isArray(variant.mediaSrc) || variant.mediaSrc.length === 0) {
      throw new Error(`dry_run variant ${index} must include mediaSrc`);
    }
  }
  return variants.map((variant) => variant.mediaSrc.length);
}

function variantMediaNodes(variant) {
  if (!variant || !variant.media || !Array.isArray(variant.media.nodes)) return [];
  return variant.media.nodes;
}

function assertLiveCreate(result) {
  if (result?.ok !== true) throw new Error('create-product did not return ok:true');
  const productId = norm(result.product_id);
  if (!productId) throw new Error('create-product response is missing product_id');
  const variants = Array.isArray(result.variants) ? result.variants : [];
  if (variants.length !== 2) throw new Error(`Expected two created variants, received ${variants.length}`);
  const mediaCounts = variants.map((variant) => variantMediaNodes(variant).length);
  if (mediaCounts.some((count) => count < 1)) {
    throw new Error(`Every variant must include non-empty media.nodes; counts=${JSON.stringify(mediaCounts)}`);
  }
  return { productId, mediaCounts };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const supabaseUrl = stripTrailingSlash(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL);
  const token = norm(process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN);
  if (!token) throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN is required unless --help is used');

  const images = await pickFixtureImages();
  const suffix = randomSuffix();
  const { payload, skus } = buildPayload({ images, suffix, dryRun: args.dryRun });
  let productId = '';
  let createdForCleanup = null;
  const summary = {
    ok: false,
    product_id: null,
    created_skus: skus,
    variant_media_counts: [],
    cleanup: args.dryRun ? { skipped: true, reason: 'dry_run' } : { attempted: false },
  };

  try {
    const created = await postBridge({ supabaseUrl, token, action: 'create-product', body: payload });
    createdForCleanup = created;
    productId = norm(created.product_id);
    summary.product_id = productId || null;
    if (args.dryRun) {
      summary.variant_media_counts = assertDryRunShape(created, skus);
    } else {
      const live = assertLiveCreate(created);
      productId = live.productId;
      summary.product_id = live.productId;
      summary.variant_media_counts = live.mediaCounts;
    }
    summary.ok = true;
  } catch (error) {
    const bodyProductId = norm(
      error?.body?.product_id
      || error?.body?.platform_item_id
      || createdForCleanup?.product_id
      || createdForCleanup?.platform_item_id,
    );
    const cleanupProductId = productId || bodyProductId;
    if (!productId && cleanupProductId) {
      productId = cleanupProductId;
      summary.product_id = summary.product_id || cleanupProductId;
    }
    summary.error = compactError(error);
    process.exitCode = 1;
  } finally {
    if (!args.dryRun && productId) {
      if (args.keep) {
        summary.cleanup = { attempted: false, skipped: true, reason: '--keep' };
      } else {
        try {
          const cleanup = await postBridge({
            supabaseUrl,
            token,
            action: 'archive-product',
            body: {
              ...(payload.shop_domain ? { shop_domain: payload.shop_domain } : {}),
              product_id: productId,
            },
          });
          summary.cleanup = {
            attempted: true,
            ok: cleanup?.ok === true,
            product_id: cleanup?.product_id || productId,
            status: cleanup?.product?.status || null,
          };
        } catch (cleanupError) {
          summary.cleanup = { attempted: true, ok: false, error: compactError(cleanupError) };
          process.exitCode = 1;
        }
      }
    }
    console.log(JSON.stringify(summary));
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: compactError(error) }));
  process.exitCode = 1;
});
