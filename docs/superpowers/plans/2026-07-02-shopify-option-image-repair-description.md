# Shopify Option Image Repair and Text Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shopify registration recoverable for existing option-image misses, prove real Shopify media association with a disposable live fixture, and replace card/table descriptions with a text-first description that appends detail images at the bottom.

**Architecture:** Keep registration creation in `platform-publish/adapters/shopify.ts`, Shopify Admin API calls in `shopify-bridge`, and all regression checks in `scripts/test-shopify-product-registration.mjs`. Use `ProductVariantsBulkInput.mediaSrc` for first-create and repair because the current app token has `write_products`, and the input works for both `productVariantsBulkCreate` and `productVariantsBulkUpdate`.

**Tech Stack:** Supabase Edge Functions, Shopify Admin GraphQL, Node test scripts, local Shopify API refs in `C:\dev\api-refs\marketplaces\shopify`.

---

## File Structure

- Modify `C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md`
  - Add variant media repair policy using `ProductVariantsBulkInput.mediaSrc`.
- Modify `C:\dev\shopee-dashboard-shopify-sync\supabase\functions\shopify-bridge\index.ts`
  - Add `repair-option-images` endpoint.
  - Add product/variant read helpers and `productVariantsBulkUpdate` media update helper.
  - Return dry-run and live diagnostics.
- Modify `C:\dev\shopee-dashboard-shopify-sync\edge-functions\shopify-bridge\index.ts`
  - Mirror static tokens for deployment checks.
- Modify `C:\dev\shopee-dashboard-shopify-sync\supabase\functions\platform-publish\adapters\shopify.ts`
  - Expand option-image source candidates.
  - Replace table/card default description with text-first minimal HTML.
  - Append detail images at the bottom.
- Modify `C:\dev\shopee-dashboard-shopify-sync\scripts\test-shopify-product-registration.mjs`
  - Add RED/GREEN assertions for repair endpoint, extra image fallback, text description, and detail image rendering.
- Optional create `C:\dev\shopee-dashboard-shopify-sync\scripts\shopify-option-image-live-fixture.mjs`
  - Controlled disposable live fixture: create Draft product, verify variant media, archive.

---

### Task 1: Local API Ref and Regression Contract

**Files:**
- Modify: `C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md`
- Modify: `C:\dev\shopee-dashboard-shopify-sync\scripts\test-shopify-product-registration.mjs`

- [ ] **Step 1: Extend local API ref**

Add this section to `product-variants-bulk-update.graphql.md`:

```markdown
## Variant media repair

`productVariantsBulkUpdate` uses `ProductVariantsBulkInput`, so it can update
variant media associations through:

- `mediaSrc ([String!])`: public media URL to associate with the variant.
- `mediaId (ID)`: existing product media ID to associate with the variant.

V2 repair should use `mediaSrc` because local product rows already carry public
image URLs and current Shopify auth includes `write_products`.

Repair payload:

```graphql
mutation ShopifyBridgeVariantMediaRepair($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product { id title status publishedAt }
    productVariants {
      id
      sku
      media(first: 10) {
        nodes { id alt mediaContentType preview { status } }
      }
    }
    userErrors { field message code }
  }
}
```
```

- [ ] **Step 2: Write failing static tests**

Add assertions in `scripts/test-shopify-product-registration.mjs`:

```js
assert.match(variantsBulkUpdateRef, /Variant media repair/, 'variant bulk update doc must record media repair policy');
assert.match(variantsBulkUpdateRef, /mediaSrc\s*\(\[String!\]\)/, 'variant bulk update doc must record mediaSrc repair support');

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /action === 'repair-option-images'/, `${label} Shopify bridge must expose option image repair`);
  assert.match(source, /async function handleRepairOptionImages/, `${label} Shopify bridge must implement option image repair`);
  assert.match(source, /productVariantsBulkUpdate\(productId: \$productId, variants: \$variants\)/, `${label} Shopify repair must use productVariantsBulkUpdate`);
  assert.match(source, /mediaSrc:\s*mediaSrc/, `${label} Shopify repair must send mediaSrc per matched variant`);
}
```

- [ ] **Step 3: Run RED**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: FAIL on missing `repair-option-images` bridge contract.

---

### Task 2: Existing Product Option Image Repair Endpoint

**Files:**
- Modify: `C:\dev\shopee-dashboard-shopify-sync\supabase\functions\shopify-bridge\index.ts`
- Modify: `C:\dev\shopee-dashboard-shopify-sync\edge-functions\shopify-bridge\index.ts`
- Test: `C:\dev\shopee-dashboard-shopify-sync\scripts\test-shopify-product-registration.mjs`

- [ ] **Step 1: Add media repair helper**

Add after `bulkUpdateVariantInventoryItemSku`:

```ts
function normalizeVariantMediaRows(rows: any[]): any[] {
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => {
      const sku = norm(row?.sku || row?.external_sku);
      const variantId = shopifyVariantGid(row?.variant_id || row?.external_variant_id);
      const mediaSrc = Array.isArray(row?.mediaSrc)
        ? row.mediaSrc.map((url: unknown) => norm(url)).filter((url: string) => /^https:\/\//i.test(url)).slice(0, 10)
        : [norm(row?.mediaSrc || row?.image || row?.imageUrl || row?.option_image_url)].filter((url: string) => /^https:\/\//i.test(url));
      return { sku, variantId, mediaSrc };
    })
    .filter((row: any) => (row.sku || row.variantId) && row.mediaSrc.length);
}

async function bulkRepairVariantMedia(shop: any, productId: string, variants: any[]) {
  const query = `
    mutation ShopifyBridgeVariantMediaRepair($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id title status publishedAt }
        productVariants {
          id
          sku
          media(first: 10) {
            nodes { id alt mediaContentType preview { status } }
          }
        }
        userErrors { field message code }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { productId, variants });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productVariantsBulkUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productVariantsBulkUpdate') };
  }
  return { ok: true, status, raw, variants: raw?.data?.productVariantsBulkUpdate?.productVariants || [] };
}
```

- [ ] **Step 2: Add handler**

Add before `handleLookupSku`:

```ts
async function handleRepairOptionImages(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);

  const productId = shopifyProductGid(body.product_id || body.productId || body.platform_item_id || body.platformItemId);
  if (!productId) return jsonResp({ ok: false, error: 'valid Shopify product_id required' }, 400);

  const shop = await configuredShop(normalizeShopDomain(body.shop_domain || body.shop));
  const scopes = shopScopeSet(shop);
  if (!scopes.has('write_products')) {
    return jsonResp({ ok: false, error: 'missing_scopes', missing_scopes: ['write_products'], shop_domain: shop.shop_domain }, 403);
  }

  const read = await readProductSkuTargets(shop, productId);
  if (!read.ok) return jsonResp({ ok: false, error: read.error || 'product lookup failed', raw: read.raw }, read.status || 502);

  const requestedRows = normalizeVariantMediaRows(body.variants || body.option_images || []);
  if (!requestedRows.length) return jsonResp({ ok: false, error: 'variants[] with sku or variant_id and mediaSrc is required' }, 400);

  const variants = requestedRows.map((requested: any) => {
    const target = requested.variantId
      ? read.variants.find((variant: any) => norm(variant?.id) === requested.variantId)
      : read.variants.find((variant: any) => norm(variant?.sku || variant?.inventoryItem?.sku) === requested.sku);
    if (!target?.id) return { missing: true, sku: requested.sku, variant_id: requested.variantId || null, mediaSrc: requested.mediaSrc };
    return { id: target.id, sku: requested.sku || norm(target?.sku), mediaSrc: requested.mediaSrc };
  });

  const missing = variants.filter((row: any) => row.missing);
  if (missing.length) return jsonResp({ ok: false, error: 'variant_not_found', product_id: productId, missing, variants: read.variants.map(summarizeSkuVariant) }, 404);

  const payloadVariants = variants.map((row: any) => ({ id: row.id, mediaSrc: row.mediaSrc }));
  if (body.dry_run === true) {
    return jsonResp({ ok: true, dry_run: true, shop_domain: shop.shop_domain, product_id: productId, variants: payloadVariants });
  }

  const repaired = await bulkRepairVariantMedia(shop, productId, payloadVariants);
  if (!repaired.ok) return jsonResp({ ok: false, error: repaired.error || 'productVariantsBulkUpdate failed', raw: repaired.raw }, repaired.status || 502);
  return jsonResp({ ok: true, shop_domain: shop.shop_domain, product_id: productId, variants: repaired.variants, raw: repaired.raw });
}
```

- [ ] **Step 3: Add route**

Add in `handleRequest`:

```ts
if (action === 'repair-option-images' && req.method === 'POST') return await handleRepairOptionImages(req);
```

- [ ] **Step 4: Update edge mirror**

Add static tokens:

```ts
// action === 'repair-option-images'
// async function handleRepairOptionImages
// productVariantsBulkUpdate(productId: $productId, variants: $variants)
// mediaSrc: mediaSrc
```

- [ ] **Step 5: Run GREEN**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: `Shopify product registration checks passed`.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/shopify-bridge/index.ts edge-functions/shopify-bridge/index.ts scripts/test-shopify-product-registration.mjs
git commit -m "feat: add Shopify option image repair endpoint" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 3: Expand Option Image Source Coverage

**Files:**
- Modify: `C:\dev\shopee-dashboard-shopify-sync\supabase\functions\platform-publish\adapters\shopify.ts`
- Test: `C:\dev\shopee-dashboard-shopify-sync\scripts\test-shopify-product-registration.mjs`

- [ ] **Step 1: Write failing test for array fallbacks**

Add to the image helper assertions:

```js
assert.equal(
  shopifyImageFns.shopifyVariantImageUrlFrom({
    extra_images: ['https://cdn.example.com/extra-option.jpg'],
    main_image: 'https://cdn.example.com/fallback.jpg',
  }),
  'https://cdn.example.com/extra-option.jpg',
  'Shopify option image mapping must use per-row extra_images when no explicit option image exists',
);
```

- [ ] **Step 2: Run RED**

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: FAIL on `extra_images` fallback.

- [ ] **Step 3: Add image candidate expansion**

Replace `shopifyVariantImageUrlFrom` with:

```ts
function shopifyImageCandidatesFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [value];
}

function shopifyVariantImageUrlFrom(row: Record<string, unknown>): string {
  const candidates = [
    row.shopee_option_image_url,
    row._custom_option_image_url,
    row._main_image,
    row.main_image,
    row._wms_image_url,
    row.image_url,
    row.ebay_variation_image_url,
    ...shopifyImageCandidatesFrom(row.extra_images),
    ...shopifyImageCandidatesFrom(row._extra_images),
    ...shopifyImageCandidatesFrom(row._detail_image_urls),
    ...shopifyImageCandidatesFrom((row as any)?.observed?.detail_image_urls),
  ];
  for (const value of candidates) {
    const url = shopifyPublicImageUrl(value);
    if (url) return url;
  }
  return '';
}
```

- [ ] **Step 4: Run GREEN**

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/platform-publish/adapters/shopify.ts scripts/test-shopify-product-registration.mjs
git commit -m "fix: broaden Shopify option image source fallback" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 4: Text-First Description With Components and Bottom Detail Images

**Files:**
- Modify: `C:\dev\shopee-dashboard-shopify-sync\supabase\functions\platform-publish\adapters\shopify.ts`
- Test: `C:\dev\shopee-dashboard-shopify-sync\scripts\test-shopify-product-registration.mjs`

- [ ] **Step 1: Write failing description tests**

Replace current default description assertions with:

```js
const shopifyDescription = descriptionHtmlFrom({
  product_name: '[READY STOCK] LE SSERAFIM 2nd Studio Album PUREFLOW pt.1 (COMPACT ver.)',
  sku: 'G2-LES-PUREF-COMP-VOL1',
  lifecycle_state: 'ready_stock',
  components_extracted_en: 'Outbox, Booklet, CD-R, Photocard, Postcard, Sticker',
  extra_images: ['https://cdn.example.com/detail-1.jpg', 'https://cdn.example.com/detail-2.jpg'],
}, {});
assert(shopifyDescription.includes('Product Details'), 'Shopify text description must include Product Details section');
assert(shopifyDescription.includes('- Outbox'), 'Shopify text description must list master components');
assert(shopifyDescription.includes('- Photocard'), 'Shopify text description must list extracted components');
assert(shopifyDescription.includes('Detail Images'), 'Shopify text description must append detail image section');
assert(shopifyDescription.includes('<img src="https://cdn.example.com/detail-1.jpg"'), 'Shopify detail image section must render first detail image');
assert(!shopifyDescription.includes('<table'), 'Shopify default description must not use table card layout');
assert(!shopifyDescription.includes('<ul>'), 'Shopify default description must not use list HTML for the text section');
```

- [ ] **Step 2: Run RED**

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: FAIL because current default uses table/card HTML.

- [ ] **Step 3: Add text and detail image helpers**

Add near description helpers:

```ts
function shopifyTextEscape(value: unknown): string {
  return s(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function shopifyDetailImageUrlsFrom(master: Record<string, unknown>): string[] {
  const candidates = [
    ...(Array.isArray(master.extra_images) ? master.extra_images : []),
    ...(Array.isArray((master as any)._extra_images) ? (master as any)._extra_images : []),
    ...(Array.isArray((master as any)._detail_image_urls) ? (master as any)._detail_image_urls : []),
    ...(Array.isArray((master as any)?.observed?.detail_image_urls) ? (master as any).observed.detail_image_urls : []),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const url = shopifyPublicImageUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, 12);
}

function shopifyDetailImagesHtmlFrom(master: Record<string, unknown>, title: string): string {
  const urls = shopifyDetailImageUrlsFrom(master);
  if (!urls.length) return '';
  return [
    'Detail Images',
    ...urls.map((url, index) => `<img src="${shopifyTextEscape(url)}" alt="${shopifyTextEscape(title)} detail image ${index + 1}" style="max-width:100%;height:auto;">`),
  ].join('\n\n');
}

function shopifyTextDescriptionFrom(master: Record<string, unknown>, title: string, lifecycleState: string): string {
  const componentLines = shopifyComponentLines(master.components_extracted_en);
  const stockLine = lifecycleState === 'ready_stock'
    ? 'Ready stock items usually ship within 1 business day after order confirmation, excluding weekends and Korean holidays.'
    : 'Pre-order items ship after official release and warehouse arrival. Distributor delays may change the schedule.';
  const includes = componentLines.length
    ? componentLines.map((line) => `- ${line}`).join('\n')
    : 'Official manufacturer contents for the selected version.';
  const body = [
    'Product Details',
    '',
    title,
    '',
    'Official K-pop item from Korea.',
    'Condition: Brand new / factory sealed / official product',
    `Availability: ${lifecycleState === 'ready_stock' ? 'Ready stock' : 'Pre-order'}`,
    '',
    'Includes',
    '',
    includes,
    '',
    'Random inclusions follow the official manufacturer policy and cannot be selected unless the option name says so.',
    'Contents may vary slightly by version or manufacturer update.',
    '',
    'Shipping',
    '',
    stockLine,
    'Tracking will be uploaded after dispatch. The first carrier scan may take 24-48 hours.',
    '',
    'Important Notes',
    '',
    'Product details, contents, preview images, and release information may be changed by the manufacturer without prior notice.',
    'Outer packaging is made to protect the product inside. Minor marks, dents, scratches, or pressure lines on outer packaging may occur during production or shipping and are not considered defects.',
  ].join('\n');
  return body;
}
```

- [ ] **Step 4: Replace default description generator**

Replace `shopifyEbayDescriptionHtmlFrom` default usage with:

```ts
function shopifyDefaultDescriptionHtmlFrom(master: Record<string, unknown>, title: string, lifecycleState: string): string {
  const text = shopifyTextDescriptionFrom(master, title, lifecycleState);
  const detailImages = shopifyDetailImagesHtmlFrom(master, title);
  return [shopifyTextEscape(text).replace(/\n/g, '<br>\n'), detailImages].filter(Boolean).join('<br>\n<br>\n');
}

function descriptionHtmlFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  const override = shopify.description_html || shopify.description;
  const raw = s(override).trim();
  if (!raw) {
    return shopifyDefaultDescriptionHtmlFrom(
      master,
      stripLifecycleTags(master.product_name) || cleanText(master.sku),
      lifecycleOf(master),
    ).slice(0, 8000);
  }
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return shopifyTextEscape(raw).replace(/\n/g, '<br>\n');
}
```

- [ ] **Step 5: Run GREEN**

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/platform-publish/adapters/shopify.ts scripts/test-shopify-product-registration.mjs
git commit -m "feat: use text-first Shopify descriptions" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 5: Disposable Live Fixture Verification

**Files:**
- Create: `C:\dev\shopee-dashboard-shopify-sync\scripts\shopify-option-image-live-fixture.mjs`

- [ ] **Step 1: Create fixture script**

Create `scripts/shopify-option-image-live-fixture.mjs`:

```js
const bridge = 'https://mgqlwgnmwegzsjelbrih.supabase.co/functions/v1/shopify-bridge';
const token = process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN || '';
if (!token) throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN is required');

const skuBase = `CODEX-OPTIMG-${Date.now()}`;
const headers = { 'Content-Type': 'application/json', 'x-platform-bridge-token': token };

async function post(action, body) {
  const res = await fetch(`${bridge}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(`${action} failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const createBody = {
  product: {
    title: `Codex Shopify option image fixture ${skuBase}`,
    status: 'DRAFT',
    productOptions: [{ name: 'Version', values: [{ name: 'VOL1' }, { name: 'VOL2' }] }],
  },
  media: [
    { originalSource: 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png', alt: 'Fixture main image' },
  ],
  variants: [
    {
      sku: `${skuBase}-VOL1`,
      price: '9.99',
      optionValues: [{ optionName: 'Version', name: 'VOL1' }],
      mediaSrc: ['https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png'],
    },
    {
      sku: `${skuBase}-VOL2`,
      price: '10.99',
      optionValues: [{ optionName: 'Version', name: 'VOL2' }],
      mediaSrc: ['https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png'],
    },
  ],
};

let productId = '';
try {
  const created = await post('create-product', createBody);
  productId = created.product_id || created.platform_item_id;
  const variants = Array.isArray(created.variants) ? created.variants : [];
  const missingMedia = variants.filter((variant) => !Array.isArray(variant.media?.nodes) || variant.media.nodes.length === 0);
  console.log(JSON.stringify({ productId, variantCount: variants.length, missingMedia: missingMedia.map((variant) => variant.sku || variant.id) }, null, 2));
  if (!productId || variants.length !== 2 || missingMedia.length) process.exitCode = 1;
} finally {
  if (productId) {
    await post('archive-product', { product_id: productId });
    console.log(JSON.stringify({ archived: productId }, null, 2));
  }
}
```

- [ ] **Step 2: Run live fixture**

Run:

```powershell
node scripts\shopify-option-image-live-fixture.mjs
```

Expected:

```json
{
  "variantCount": 2,
  "missingMedia": []
}
```

The script must archive the created product in `finally`.

- [ ] **Step 3: Commit fixture or delete it**

If this script becomes part of regular smoke testing:

```powershell
git add scripts/shopify-option-image-live-fixture.mjs
git commit -m "test: add Shopify option image live fixture" -m "Co-Authored-By: Codex <codex@openai.com>"
```

If not keeping it, delete before final commit:

```powershell
Remove-Item -LiteralPath scripts\shopify-option-image-live-fixture.mjs
```

---

### Task 6: Deploy and Smoke

**Files:**
- Deploy: `platform-publish`
- Deploy: `shopify-bridge`

- [ ] **Step 1: Run full local checks**

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-v2-platform-coverage.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected: all exit `0`.

- [ ] **Step 2: Deploy Edge Functions**

```powershell
supabase functions deploy platform-publish --project-ref mgqlwgnmwegzsjelbrih
supabase functions deploy shopify-bridge --project-ref mgqlwgnmwegzsjelbrih
```

Expected: both deploy successfully.

- [ ] **Step 3: Smoke repair endpoint dry-run against current PUREFLOW product if variant IDs are available**

Use the known product GID and current option image URLs:

```powershell
@'
const bridge = 'https://mgqlwgnmwegzsjelbrih.supabase.co/functions/v1/shopify-bridge';
const token = process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN;
const body = {
  product_id: 'gid://shopify/Product/REPLACE_WITH_PUREFLOW_PRODUCT_ID',
  dry_run: true,
  variants: [
    { sku: 'G2-LES-PUREF-PHO-VOL1', mediaSrc: ['https://REPLACE_WITH_OPTION_IMAGE_URL'] }
  ]
};
const res = await fetch(`${bridge}/repair-option-images`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-platform-bridge-token': token },
  body: JSON.stringify(body),
});
const json = await res.json();
console.log(JSON.stringify({ status: res.status, ok: json.ok, variants: json.variants }, null, 2));
if (!res.ok || !json.ok || !json.variants?.[0]?.mediaSrc?.length) process.exit(1);
'@ | node -
```

Expected: dry-run variant payload contains `mediaSrc`.

- [ ] **Step 4: Push**

```powershell
git push origin HEAD:codex/shopify-sku-sync-mapping
git push origin HEAD:main
```

Expected: both pushes succeed.

---

## Self-Review

- Spec coverage:
  - Existing option image misses: Task 2 repair endpoint.
  - Real Shopify media proof: Task 5 disposable live fixture.
  - Description text format: Task 4 text-first description generator.
  - Detail images at bottom: Task 4 `shopifyDetailImagesHtmlFrom`.
  - Master product components: Task 4 `shopifyComponentLines(master.components_extracted_en)`.
- Placeholder scan:
  - The only replacement markers are in the smoke command for real production IDs and URLs. They are intentionally operator-supplied values for the already-existing PUREFLOW product, not implementation placeholders.
- Type consistency:
  - `mediaSrc` is consistently an array of HTTPS strings.
  - Shopify product IDs use product GIDs through `shopifyProductGid`.
  - Variant IDs use ProductVariant GIDs through `shopifyVariantGid`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-02-shopify-option-image-repair-description.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.

