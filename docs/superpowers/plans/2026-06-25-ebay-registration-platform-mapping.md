# eBay Registration Platform Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** eBay 상품 등록 성공 시 `products.ebay_*` legacy 컬럼뿐 아니라 `platform_listings` 표준 매핑까지 저장해서, eBay 탭/LED/coverage/가격동기화가 즉시 `mapped` 상태를 보도록 만든다.

**Architecture:** `ebay-bridge`를 eBay publish side effect의 표준 저장 지점으로 삼는다. 브라우저 UI는 계속 eBay 등록 모달을 사용하되, bridge가 service-role로 `platform_listings`를 upsert하고, DB rollup/view는 기존 `products.ebay_*` legacy row도 fallback으로 읽는다. 아티스트 괄호 정규화는 V2 모달, headless bridge, platform-publish adapter 모두 같은 의미를 갖도록 테스트로 잠근다.

**Tech Stack:** V2 single-file app (`v2/index.html`), Supabase Edge Functions (`supabase/functions/ebay-bridge`, `edge-functions/ebay-bridge`, `supabase/functions/platform-publish`), Supabase SQL migrations, Node static regression tests.

---

## 조사 결과

문제는 두 흐름이 갈라져 있어서 발생한다.

1. eBay 탭의 `등록` 버튼은 `platform-publish` dispatcher를 타지 않고 기존 eBay 등록 모달을 연다.
   - 진입: `v2/index.html` `platformOpenExistingModal(..., 'ebay')` -> `openRegisterEbayGroupModal()` -> `window.mrOpenEbayModal(...)`
   - 발행: `mrConfirmEbayModal()` -> `ebay-bridge/publish` 또는 `ebay-bridge/publish-variation`
   - 저장: `mrPersistEbayPublishResult()`가 `products.ebay_*`만 업데이트한다.

2. eBay 탭의 상태/LED/coverage는 `platform_listing_rollups`와 `platform_listings`를 중심으로 계산한다.
   - `platformStatusForGroup()` -> `rollupFor()` -> `state.rollups`
   - `state.rollups`는 `platform_listing_rollups` view에서 온다.
   - 현재 rollup view는 non-Shopee에서 `platform_listings`를 주로 보고, legacy fallback은 Joom만 확실히 들어가 있다.

3. 따라서 `[READY STOCK] BTS - OFFICIAL LIGHT STICK V4 ARMY BOMB`이 eBay에는 실제 등록됐더라도 `platform_listings` row가 없으면 eBay 탭은 `missing`으로 보일 수 있다.

4. 현재 세션에서는 로그인 세션/service-role env가 없어 Supabase의 실제 BTS row를 직접 확인하지 못했다. 익명 REST 조회는 0건이었고, 이는 products RLS/인증 조건과 일치한다. 구현 시에는 로그인 UI 또는 service-role 환경에서 해당 product row를 먼저 확인한다.

5. 로컬 eBay API 기준 문서:
   - `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`
   - `POST /sell/inventory/v1/offer/{offerId}/publish` 응답은 `listingId`를 제공한다.
   - `POST /sell/inventory/v1/offer/publish_by_inventory_item_group` 응답도 `listingId`를 제공한다.
   - `GET /sell/inventory/v1/offer?sku=...`는 published offer의 `offerId`, `status`, listing container를 확인하는 데 쓰인다.

## File Structure

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\supabase\functions\ebay-bridge\index.ts`
  - eBay publish 성공 후 `platform_listings` 표준 매핑을 service-role로 저장하는 helper 추가.
  - single publish, variation publish, headless register-product 경로가 같은 helper를 사용하게 한다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\edge-functions\ebay-bridge\index.ts`
  - Supabase function mirror. `supabase/functions/ebay-bridge/index.ts`와 byte-level 동일해야 한다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\supabase\functions\platform-publish\_shared\grouping.ts`
  - eBay adapter도 괄호형 아티스트 prefix를 같은 방식으로 해석하도록 title parser helper를 공유한다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\supabase\functions\platform-publish\adapters\ebay.ts`
  - `aspectsFrom()`에서 새 shared parser를 사용한다.
  - `[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [...]`는 `Artist=ILLIT`, `Release Title=NOT CUTE ANYMORE`가 되도록 한다.

- Create: `C:\dev\shopee-dashboard-ebay-artist-fix\supabase\migrations\202606250001_ebay_platform_listings_backfill.sql`
  - 기존 `products.ebay_*` legacy mapping을 `platform_listings`에 backfill한다.
  - `platform_listing_rollups` view에 eBay legacy fallback을 추가한다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\v2\index.html`
  - coverage fallback query에 eBay legacy 컬럼을 포함한다.
  - DB view가 아직 반영되지 않은 환경에서도 `products.ebay_item_id`가 있으면 eBay coverage fallback이 mapped로 보이게 한다.
  - 브라우저에서 SECURITY DEFINER absorb RPC를 직접 호출하지 않는다.

- Create: `C:\dev\shopee-dashboard-ebay-artist-fix\scripts\test-v2-ebay-platform-listing-mapping.mjs`
  - eBay publish 결과가 표준 mapping에 저장되는지 static regression으로 잠근다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\scripts\test-v2-platform-coverage.mjs`
  - eBay legacy fallback과 coverage fallback을 테스트한다.

- Modify: `C:\dev\shopee-dashboard-ebay-artist-fix\scripts\test-v2-ebay-headless-register-product.mjs`
  - headless eBay publish도 `platform_listings` mapping helper를 통과하는지 테스트한다.

## Task 1: Failing Regression Tests

**Files:**
- Create: `scripts/test-v2-ebay-platform-listing-mapping.mjs`
- Modify: `scripts/test-v2-platform-coverage.mjs`
- Modify: `scripts/test-v2-ebay-headless-register-product.mjs`

- [ ] **Step 1: Add a focused static test for eBay publish mapping side effects**

Create `scripts/test-v2-ebay-platform-listing-mapping.mjs` with these assertions:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const supabaseBridgePath = join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts');
const edgeBridgePath = join(root, 'edge-functions', 'ebay-bridge', 'index.ts');
const migrationPath = join(root, 'supabase', 'migrations', '202606250001_ebay_platform_listings_backfill.sql');
const htmlPath = join(root, 'v2', 'index.html');

for (const path of [supabaseBridgePath, edgeBridgePath, migrationPath, htmlPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const bridge = readFileSync(supabaseBridgePath, 'utf8');
const edge = readFileSync(edgeBridgePath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const hash = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

assert.equal(hash(bridge), hash(edge), 'supabase and edge-functions ebay-bridge copies must match');

for (const token of [
  'async function persistEbayPlatformListingMapping',
  'async function persistEbayPublishPlatformMappings',
  'publish_origin: "v2_created"',
  'mapping_status: "mapped"',
  'listing_status: "listed"',
  'platform_item_id: ebayItemId',
  'external_sku: sku',
  'external_variant_id: externalVariantId',
  'await persistEbayPublishPlatformMappings("single", body, raw)',
  'await persistEbayPublishPlatformMappings("variation", body, raw)',
]) {
  assert(bridge.includes(token), `ebay-bridge missing platform mapping token: ${token}`);
}

for (const token of [
  'products.ebay_item_id',
  "'ebay'::text as platform",
  "upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')",
  "coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US')",
  "'v2_created'::text as publish_origin",
  'platform_listing_rollups',
]) {
  assert(migration.includes(token), `eBay backfill migration missing token: ${token}`);
}

for (const token of [
  'ebay_sku,ebay_offer_id,ebay_item_id,ebay_status,ebay_last_synced_price,ebay_marketplace_id,ebay_last_synced_at',
  "pushRow(product.id, 'ebay'",
  "platform_item_id: product.ebay_item_id",
  "external_variant_id: product.ebay_offer_id || product.ebay_sku",
  "listing_status: 'listed'",
  "mapping_status: 'mapped'",
]) {
  assert(html.includes(token), `V2 coverage fallback missing eBay legacy token: ${token}`);
}

console.log('v2 eBay platform listing mapping checks passed');
```

- [ ] **Step 2: Extend existing coverage test**

In `scripts/test-v2-platform-coverage.mjs`, add eBay-specific checks next to the existing Joom legacy fallback checks:

```js
assert(html.includes('ebay_sku,ebay_offer_id,ebay_item_id'), 'coverage fallback must include legacy eBay product mappings');
assert(html.includes("pushRow(product.id, 'ebay'"), 'coverage fallback must convert legacy eBay mappings into coverage rows');
assert(migration.includes('products.ebay_item_id') || html.includes('products.ebay_item_id'), 'coverage migration/test path must cover eBay legacy item IDs');
```

- [ ] **Step 3: Extend headless register test**

In `scripts/test-v2-ebay-headless-register-product.mjs`, add these tokens to the existing token list:

```js
'async function persistEbayPublishPlatformMappings',
'await persistEbayPublishPlatformMappings("single", payload, publishJson)',
'publish_origin: "v2_created"',
'platform_item_id: ebayItemId',
```

- [ ] **Step 4: Run tests and confirm RED**

Run:

```bash
node scripts/test-v2-ebay-platform-listing-mapping.mjs
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-ebay-headless-register-product.mjs
```

Expected:
- `test-v2-ebay-platform-listing-mapping.mjs` fails because the new migration and bridge helper do not exist yet.
- `test-v2-platform-coverage.mjs` fails on eBay fallback tokens.
- `test-v2-ebay-headless-register-product.mjs` fails on mapping helper tokens.

## Task 2: Persist eBay Publish Results Into platform_listings

**Files:**
- Modify: `supabase/functions/ebay-bridge/index.ts`
- Modify: `edge-functions/ebay-bridge/index.ts`

- [ ] **Step 1: Add a platform listing upsert helper**

Add this helper near the existing publish-run helpers in `supabase/functions/ebay-bridge/index.ts`:

```ts
async function persistEbayPlatformListingMapping(args: {
  productId: string;
  sku: string;
  ebayItemId: string;
  externalVariantId?: string | null;
  marketplaceId?: string | null;
  listingMode: "single" | "variation";
  title?: string | null;
  priceUsd?: unknown;
  quantity?: unknown;
  rawPayload?: any;
}): Promise<string | null> {
  const productId = s(args.productId).trim();
  const sku = s(args.sku).trim();
  const ebayItemId = s(args.ebayItemId).trim();
  if (!productId || !sku || !ebayItemId) return null;

  const now = new Date().toISOString();
  const country = s(args.marketplaceId || "EBAY_US").trim() || "EBAY_US";
  const externalVariantId = s(args.externalVariantId || "").trim() || null;
  const remotePrice = Number(args.priceUsd || 0);
  const remoteStock = Number(args.quantity || 0);
  const patch = {
    master_product_id: productId,
    platform: "ebay",
    shop_id: null,
    country,
    platform_item_id: ebayItemId,
    external_variant_id: externalVariantId,
    external_sku: sku,
    title: s(args.title).trim() || null,
    currency: "USD",
    remote_price: Number.isFinite(remotePrice) && remotePrice > 0 ? remotePrice : null,
    remote_stock: Number.isFinite(remoteStock) && remoteStock >= 0 ? remoteStock : null,
    listing_status: "listed",
    mapping_status: "mapped",
    publish_origin: "v2_created",
    last_payload: args.rawPayload || {},
    last_sync_at: now,
    last_seen_at: now,
    error_msg: null,
    error_code: null,
    deleted_at: null,
    updated_at: now,
  };

  const { data: updated, error: updateError } = await supabase
    .from("platform_listings")
    .update(patch)
    .eq("master_product_id", productId)
    .eq("platform", "ebay")
    .eq("country", country)
    .is("shop_id", null)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(`platform listing update failed: ${updateError.message || String(updateError)}`);
  if (updated?.id) return updated.id;

  const { data: inserted, error: insertError } = await supabase
    .from("platform_listings")
    .insert(patch)
    .select("id")
    .maybeSingle();
  if (!insertError) return inserted?.id || null;

  if (String(insertError.code || "") !== "23505") {
    throw new Error(`platform listing insert failed: ${insertError.message || String(insertError)}`);
  }

  const { data: recovered, error: recoverError } = await supabase
    .from("platform_listings")
    .update(patch)
    .eq("master_product_id", productId)
    .eq("platform", "ebay")
    .eq("country", country)
    .is("shop_id", null)
    .select("id")
    .maybeSingle();
  if (recoverError) throw new Error(`platform listing recover failed: ${recoverError.message || String(recoverError)}`);
  return recovered?.id || null;
}
```

- [ ] **Step 2: Add a publish response mapper**

Add this helper below `persistEbayPlatformListingMapping`:

```ts
async function persistEbayPublishPlatformMappings(
  listingMode: "single" | "variation",
  body: any,
  raw: any
): Promise<string[]> {
  const ebayItemId = s(raw?.ebay_item_id).trim();
  if (!ebayItemId) return [];

  if (listingMode === "single") {
    const id = await persistEbayPlatformListingMapping({
      productId: body.productId || body.product_id,
      sku: body.sku,
      ebayItemId,
      externalVariantId: raw.ebay_offer_id || null,
      marketplaceId: raw.marketplace_id || body.marketplaceId || "EBAY_US",
      listingMode,
      title: body.title,
      priceUsd: body.priceUsd,
      quantity: body.quantity,
      rawPayload: { listingMode, request: body, response: raw },
    });
    return id ? [id] : [];
  }

  const offersBySku = raw?.offers_by_sku && typeof raw.offers_by_sku === "object" ? raw.offers_by_sku : {};
  const ids: string[] = [];
  for (const variation of Array.isArray(body.variations) ? body.variations : []) {
    const sku = s(variation?.sku).trim();
    const offer = offersBySku[sku] || {};
    const id = await persistEbayPlatformListingMapping({
      productId: variation?.productId || variation?.product_id,
      sku,
      ebayItemId,
      externalVariantId: offer.offerId || offer.ebay_offer_id || sku,
      marketplaceId: raw.marketplace_id || body.marketplaceId || "EBAY_US",
      listingMode,
      title: body.title,
      priceUsd: variation?.priceUsd,
      quantity: variation?.quantity,
      rawPayload: { listingMode, inventoryGroupKey: body.inventoryGroupKey, variation, offer, response: raw },
    });
    if (id) ids.push(id);
  }
  return ids;
}
```

- [ ] **Step 3: Call the helper after successful publish**

Change `withEbayPublishRun()` so a successful raw response persists mappings:

```ts
const raw = await jsonFromResponse(resp);
if (resp.status < 400 && raw?.ok) {
  try {
    const platformListingIds = await persistEbayPublishPlatformMappings(listingMode, body, raw);
    if (platformListingIds.length) raw.platform_listing_ids = platformListingIds;
  } catch (e) {
    console.warn("[ebay-bridge] platform listing persist skipped", e);
  }
}
await finishEbayPublishRun(runId, resp.status < 400 && raw?.ok ? "published" : "failed", raw, raw?.error || raw?.message || "");
return jsonResp(raw, resp.status);
```

This preserves publish success even if a non-critical local mapping write fails, but logs the failure for diagnosis.

- [ ] **Step 4: Call the helper in headless register-product**

After `persistHeadlessEbayPublishResult(product, payload, publishJson)`, add:

```ts
const platformListingIds = await persistEbayPublishPlatformMappings("single", payload, publishJson).catch((e) => {
  console.warn("[ebay-bridge] headless platform listing persist skipped", e);
  return [];
});
```

Include `platform_listing_ids: platformListingIds` in the JSON response.

- [ ] **Step 5: Mirror edge function**

Copy the Supabase function to the mirror:

```powershell
Copy-Item -LiteralPath .\supabase\functions\ebay-bridge\index.ts -Destination .\edge-functions\ebay-bridge\index.ts
```

- [ ] **Step 6: Run tests and confirm partial GREEN**

Run:

```bash
node scripts/test-v2-ebay-platform-listing-mapping.mjs
node scripts/test-v2-ebay-headless-register-product.mjs
```

Expected:
- Bridge helper tokens pass.
- Migration/fallback assertions still fail until Task 3 and Task 4 are implemented.

## Task 3: Backfill Existing eBay Legacy Mappings

**Files:**
- Create: `supabase/migrations/202606250001_ebay_platform_listings_backfill.sql`

- [ ] **Step 1: Create idempotent backfill migration**

Create this migration:

```sql
-- Backfill eBay legacy product mapping columns into platform_listings.
-- This covers products that were published through ebay-bridge before the
-- standard platform_listings side effect existed.

insert into public.platform_listings (
  master_product_id,
  platform,
  shop_id,
  country,
  platform_item_id,
  external_variant_id,
  external_sku,
  title,
  currency,
  remote_price,
  listing_status,
  mapping_status,
  publish_origin,
  last_payload,
  last_sync_at,
  last_seen_at,
  error_msg,
  error_code
)
select
  p.id,
  'ebay',
  null,
  coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US'),
  p.ebay_item_id,
  coalesce(nullif(p.ebay_offer_id, ''), nullif(p.ebay_sku, ''), nullif(p.sku, '')),
  coalesce(nullif(p.ebay_sku, ''), nullif(p.sku, '')),
  p.product_name,
  'USD',
  p.ebay_last_synced_price,
  'listed',
  'mapped',
  'v2_created',
  jsonb_build_object(
    'legacy_source', 'products.ebay_columns',
    'ebay_status', p.ebay_status,
    'ebay_listing_mode', p.ebay_listing_mode,
    'ebay_inventory_group_key', p.ebay_inventory_group_key,
    'ebay_variation_axis', p.ebay_variation_axis,
    'ebay_variation_value', p.ebay_variation_value
  ),
  coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at),
  coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at),
  null,
  null
from public.products p
where p.ebay_item_id is not null
  and upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')
  and not exists (
    select 1
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = 'ebay'
      and coalesce(pl.country, '') = coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US')
      and pl.deleted_at is null
  );
```

- [ ] **Step 2: Recreate platform_listing_rollups with eBay legacy fallback**

Append a `create or replace view public.platform_listing_rollups as ...` block based on the current latest view, adding an eBay fallback union parallel to the existing Joom fallback:

```sql
  union all

  select
    p.id as master_product_id,
    'ebay'::text as platform,
    null::text as shop_id,
    coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US') as country,
    p.ebay_item_id as platform_item_id,
    coalesce(nullif(p.ebay_offer_id, ''), nullif(p.ebay_sku, ''), nullif(p.sku, '')) as external_variant_id,
    coalesce(nullif(p.ebay_sku, ''), nullif(p.sku, '')) as external_sku,
    p.product_name as title,
    'USD'::text as currency,
    p.ebay_last_synced_price as remote_price,
    null::numeric as remote_stock,
    'listed'::text as listing_status,
    'mapped'::text as mapping_status,
    'v2_created'::text as publish_origin,
    coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at) as last_seen_at,
    null::text as error_msg
  from public.products p
  where p.ebay_item_id is not null
    and upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')
    and not exists (
      select 1
      from public.platform_listings pl
      where pl.master_product_id = p.id
        and pl.platform = 'ebay'
        and pl.deleted_at is null
    )
```

The full view must preserve:
- Shopee rollup branch.
- `platform_listings` non-Shopee branch.
- existing Joom legacy fallback.
- new eBay legacy fallback.
- `grant select on public.platform_listing_rollups to authenticated;`
- `platform_listing_coverage` recreation if the current migration version defines it from rollups.

- [ ] **Step 3: Validate SQL statically**

Run:

```bash
node scripts/test-v2-ebay-platform-listing-mapping.mjs
node scripts/test-v2-platform-coverage.mjs
```

Expected:
- Migration token assertions pass.
- V2 fallback assertions may still fail until Task 4.

## Task 4: Add V2 Coverage Fallback for Legacy eBay Columns

**Files:**
- Modify: `v2/index.html`

- [ ] **Step 1: Include eBay legacy columns in coverage fallback query**

In `coverageFetchFallback()`, extend the products select string from:

```js
.select('id,sku,product_name,option_name,lifecycle_state,joom_product_id,...')
```

to include:

```js
ebay_sku,ebay_offer_id,ebay_item_id,ebay_status,ebay_last_synced_price,ebay_marketplace_id,ebay_last_synced_at,ebay_published_at
```

- [ ] **Step 2: Push legacy eBay rows into fallback coverage**

After the existing Joom legacy fallback block, add:

```js
products.forEach(function(product) {
  const status = String(product.ebay_status || '').toUpperCase();
  if (!product.ebay_item_id || importedPlatformKeys.has(key(product.id, 'ebay'))) return;
  if (!['PUBLISHED', 'MAPPED', 'LISTED'].includes(status)) return;
  pushRow(product.id, 'ebay', {
    platform: 'ebay',
    country: product.ebay_marketplace_id || 'EBAY_US',
    platform_item_id: product.ebay_item_id,
    external_variant_id: product.ebay_offer_id || product.ebay_sku,
    external_sku: product.ebay_sku || product.sku,
    listing_status: 'listed',
    mapping_status: 'mapped',
    currency: 'USD',
    remote_price: product.ebay_last_synced_price,
    last_sync_at: product.ebay_last_synced_at || product.ebay_published_at || product.updated_at,
    error_msg: null,
  });
});
```

- [ ] **Step 3: Run fallback tests**

Run:

```bash
node scripts/test-v2-ebay-platform-listing-mapping.mjs
node scripts/test-v2-platform-coverage.mjs
```

Expected: both pass.

## Task 5: Apply Parenthesized Artist Parsing to platform-publish eBay Adapter

**Files:**
- Modify: `supabase/functions/platform-publish/_shared/grouping.ts`
- Modify: `supabase/functions/platform-publish/adapters/ebay.ts`
- Modify: `scripts/test-v2-platform-coverage.mjs` or create a small focused parser test.

- [ ] **Step 1: Add shared title parser test**

Add a focused extraction/assertion to a new or existing test:

```js
assert(ebayAdapter.includes('deriveKpopFromTitle'), 'eBay platform-publish adapter must use shared K-pop title parser');
assert(grouping.includes('export function deriveKpopFromTitle'), 'shared grouping helpers must export deriveKpopFromTitle');
assert(grouping.includes('parenthesized dash-prefix artists'), 'shared parser must document the ILLIT parenthesized artist case');
```

- [ ] **Step 2: Export shared parser**

In `_shared/grouping.ts`, add:

```ts
export function deriveKpopFromTitle(value: unknown): { artist: string; album: string; version: string } {
  const raw = text(value);
  const stripped = raw
    .replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dash = stripped.match(/^\s*(.+?)\s*-\s*(.+?)\s*$/);
  if (dash) {
    const artistRaw = dash[1].trim();
    const artist = artistRaw.match(/^\(([^()]+)\)$/)?.[1]?.trim() || artistRaw.replace(/\([^)]*\)\s*$/, '').trim();
    const remainder = dash[2].replace(/\[[^\]]*(?:ver|version|name)[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (artist && remainder) return { artist, album: remainder, version: '' };
  }

  const bracket = stripped.match(/\[([^\]]+)\]/);
  const paren = stripped.match(/\(([^)]+)\)/);
  const leading = stripped.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim().split(/\s+/)[0] || '';
  return {
    artist: leading.replace(/[^A-Za-z0-9&.-]/g, ''),
    album: bracket?.[1]?.trim() || stripped,
    version: (paren?.[1] || '').replace(/\bver(?:sion)?\.?\b/ig, '').trim(),
  };
}
```

- [ ] **Step 3: Use parser in eBay adapter**

In `adapters/ebay.ts`, change the import:

```ts
import { buildVariationItems, deriveKpopFromTitle, inferKpopArtistName, parentSku, publishableGroupRows } from '../_shared/grouping.ts';
```

Then update `aspectsFrom()`:

```ts
const derived = deriveKpopFromTitle(master.product_name || master.sku);
const existingArtist = s(master.artist || master.brand || master.shopee_brand_name || '').trim();
const artist = existingArtist && !/^no brand$/i.test(existingArtist)
  ? existingArtist
  : (derived.artist || inferKpopArtistName(master));
const title = s(master.album || master.release_title || derived.album || stripLifecycleTags(master.product_name || master.sku)).trim();
```

- [ ] **Step 4: Run parser and adapter tests**

Run:

```bash
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-ebay-headless-register-product.mjs
node scripts/test-v2-ebay-kpop-listing-flow.mjs
```

Expected: all pass.

## Task 6: BTS Existing Listing Repair Verification

**Files:**
- No code file if the backfill migration covers it.
- Optional local note only if a manual product ID/item ID is discovered during verification.

- [ ] **Step 1: Identify the BTS product row with authenticated access**

Use one of these authenticated methods:

```powershell
# Browser/UI method:
# eBay tab search: BTS OFFICIAL LIGHT STICK V4 ARMY BOMB

# Service-role method if env is available:
$env:SUPABASE_SERVICE_ROLE_KEY='<service key from approved secure env>'
node scripts/platform-test-cycle.mjs --help
```

Expected:
- Find the product row(s) for `[READY STOCK] BTS - OFFICIAL LIGHT STICK V4 ARMY BOMB`.
- Record whether `products.ebay_item_id` is populated.

- [ ] **Step 2: If products.ebay_item_id exists**

Apply the migration/backfill, then reload `/v2/`.

Expected:
- `platform_listings` has an active row:
  - `platform='ebay'`
  - `platform_item_id=<BTS ebay item id>`
  - `external_sku=<BTS SKU>`
  - `listing_status='listed'`
  - `mapping_status='mapped'`
  - `publish_origin='v2_created'`
- eBay tab status becomes `등록됨/mapped`, not `미등록/missing`.

- [ ] **Step 3: If products.ebay_item_id is empty but live eBay listing exists**

Use the existing eBay tab `SKU 매핑` action for that row, or call `platform-publish` `capability='sync'` with an authenticated session.

Expected:
- `platform-publish` calls `ebay-bridge/lookup-item`.
- Found SKU is absorbed through service-role `absorb_platform_sku_lookup`.
- eBay tab status becomes mapped.

- [ ] **Step 4: Prevent duplicate live listing**

Before re-registering BTS, verify that either `products.ebay_item_id` or `platform_listings.platform_item_id` exists.

Expected:
- The UI should show mapped, so the operator does not accidentally publish another BTS listing for the same SKU.

## Task 7: Full Verification, Commit, Deploy

**Files:**
- All files above.

- [ ] **Step 1: Run static and unit checks**

Run:

```bash
node scripts/test-v2-ebay-platform-listing-mapping.mjs
node scripts/test-v2-ebay-headless-register-product.mjs
node scripts/test-v2-ebay-kpop-listing-flow.mjs
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-platform-test-cycle.mjs
npm run verify:v2-deploy-source
```

Expected: all pass.

- [ ] **Step 2: Local render smoke**

Run local server:

```powershell
npx http-server . -p 4176 -c-1
```

Capture or inspect:

```powershell
npx playwright screenshot --wait-for-timeout=3000 http://127.0.0.1:4176/v2/ artifacts-ebay-platform-mapping-local.png
```

Expected:
- V2 login/app shell renders.
- No blank page.
- Console does not show a syntax error from `v2/index.html`.

- [ ] **Step 3: Commit**

```bash
git add v2/index.html supabase/functions/ebay-bridge/index.ts edge-functions/ebay-bridge/index.ts supabase/functions/platform-publish/_shared/grouping.ts supabase/functions/platform-publish/adapters/ebay.ts supabase/migrations/202606250001_ebay_platform_listings_backfill.sql scripts/test-v2-ebay-platform-listing-mapping.mjs scripts/test-v2-platform-coverage.mjs scripts/test-v2-ebay-headless-register-product.mjs docs/superpowers/plans/2026-06-25-ebay-registration-platform-mapping.md
git commit -m "Fix eBay registration platform mapping"
```

Commit body:

```text
Co-Authored-By: Codex <codex@openai.com>
```

- [ ] **Step 4: Push and deploy V2**

```bash
git push origin main
vercel deploy --prod --yes --scope team_BSXbyvxAbEt0zWZlQXIPqKc5
```

Expected:
- Vercel deployment runs `npm run vercel-build`.
- `verify-v2-deploy-source` passes in Vercel output.
- Production alias updates for the existing project, not a new temporary project.

- [ ] **Step 5: Deploy Supabase Edge Function and migration**

Use the project’s normal Supabase deployment path for:

```bash
supabase db push
supabase functions deploy ebay-bridge
```

Expected:
- Migration applies idempotently.
- `ebay-bridge` serves the updated mapping persistence helper.

- [ ] **Step 6: Live smoke**

Check:

```powershell
$resp = Invoke-WebRequest -UseBasicParsing -Uri "https://shopee-dashboard-kohl.vercel.app/v2/"
$resp.StatusCode
$resp.Content.Contains("persistEbayPublishPlatformMappings")
```

Expected:
- HTTP 200.
- Deployed source contains new eBay mapping code.
- eBay tab search for BTS shows mapped once DB migration/backfill is live.

## Risks And Guardrails

- Do not call `absorb_platform_sku_lookup` directly from browser code. Existing tests explicitly block this.
- Do not remove `products.ebay_*` writes yet. They are still used by headless paths and price sync compatibility.
- Do not globally strip all parentheses from product names. Only normalize derived eBay aspect values; names such as `(G)I-DLE` must not be corrupted.
- If `platform-publish` and `ebay-bridge` both upsert the same mapping, the result should remain idempotent. The bridge helper should update existing rows instead of creating duplicates.
- If BTS has no local `products.ebay_item_id`, do not re-register it. Run SKU lookup/sync first.

## Self-Review

- Spec coverage: future eBay registration path is covered by bridge persistence; existing BTS mapping is covered by backfill or SKU sync; artist/title parsing is covered across V2/headless/platform-publish paths.
- Placeholder scan: no TODO/TBD placeholders are left in the execution steps.
- Type consistency: `platform_item_id` stores eBay listing ID, `external_sku` stores SKU, `external_variant_id` stores offer ID when available or SKU fallback for legacy/variation identity.

