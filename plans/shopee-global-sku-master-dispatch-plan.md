# Shopee Global SKU Master Dispatch Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Import Shopee Global Product data into master products using Shopee's existing SKU as the canonical SKU, check every supported non-Alibaba platform by SKU, and publish only to platforms where that SKU is not already listed.

**Architecture:** Shopee Global Product is the source of truth for SKU identity. The import flow creates/updates `products` by exact Shopee SKU, stores Shopee Global/Product model mapping in `product_shopee_listings`, then runs a SKU coverage matrix against platform lookup adapters. Existing remote listings are absorbed into `platform_listings`; only missing coverage is sent through `platform-publish`.

**Tech Stack:** Supabase Postgres migrations/RPCs, Supabase Edge Functions (`shopee-bridge`, `platform-publish`, `joom-bridge`, `ebay-bridge`), single-file V2 frontend (`v2/index.html`).

---

## 0. Current Verified State

### Existing schema

- `products.sku` exists and has unique index `products_sku_nonempty_uidx` for non-empty SKU.
- `product_shopee_listings` stores Shopee mapping:
  - `product_id`
  - `region`
  - `global_item_id`
  - `global_model_id`
  - `shop_id`
  - `shop_item_id`
  - `shop_model_id`
  - `status`
- `platform_listings` exists for non-Shopee platform coverage.
- `platform_listing_snapshots` already supports imported remote rows and has `sku`.
- `202605280001_v2_existing_platform_import.sql` already added to `platform_listings`:
  - `external_variant_id`
  - `external_sku`
  - `mapping_status`
  - `publish_origin`
  - `last_seen_at`
  - `raw_snapshot_id`

### Existing bridge support

- `shopee-bridge` has:
  - `/global_items`
  - `/global_item_info`
  - `/global_model_list`
  - `/published_list`
  - `/shop_model_list`
- `joom-bridge` has:
  - `GET /lookup-sku?sku=...`
  - `POST /products/create` flow behind create handler
- `ebay-bridge` has:
  - `GET /lookup-item?sku=...`
  - `POST /publish`
- `platform-publish` exists but only Shopee is wired; Joom/Qoo10/eBay/Alibaba currently fall through to `stubAdapter`.
- No Qoo10 Edge Function was found under `edge-functions/` or `supabase/functions/`; Qoo10 lookup/publish adapter is therefore a build requirement.

### Product/platform policy

- Alibaba is explicitly excluded from this feature even if docs exist in old capability seed data.
- SKU must come from Shopee Global Product:
  - no generated replacement SKU
  - no fallback `-DEFAULT` suffix
  - no case-folded stored SKU
- SKU comparison rule:
  - stored value preserves exact Shopee SKU
  - lookup comparison uses `trim()` only unless a platform API forces a documented normalization

---

## 1. Canonical Data Rules

### Single/no-model Shopee Global Product

Use:

```js
const canonicalSku = String(globalItem.global_item_sku || '').trim();
```

Create/update master:

```js
{
  sku: canonicalSku,
  product_name: globalItem.global_item_name || globalItem.item_name,
  option_name: null,
  shopee_item_id: Number(globalItem.global_item_id),
  global_model_id: null,
}
```

Create/update Shopee mapping:

```js
{
  product_id,
  region,
  global_item_id: Number(globalItem.global_item_id),
  global_model_id: null,
  shop_item_id,
  shop_model_id: null,
  status: 'mapped',
}
```

### Variant/model Shopee Global Product

For each `global_model`:

```js
const canonicalSku = String(model.global_model_sku || model.model_sku || '').trim();
```

Create/update one master row per Shopee model SKU:

```js
{
  sku: canonicalSku,
  product_name: globalItem.global_item_name || globalItem.item_name,
  option_name: deriveOptionLabel(globalItem.tier_variation, model.tier_index),
  shopee_item_id: Number(globalItem.global_item_id),
  global_model_id: Number(model.global_model_id),
  product_group_id: sharedGroupIdForGlobalItem,
  variation_tier_index: model.tier_index,
}
```

Create/update Shopee mapping per region/model:

```js
{
  product_id,
  region,
  global_item_id: Number(globalItem.global_item_id),
  global_model_id: Number(model.global_model_id),
  shop_item_id,
  shop_model_id,
  status: 'mapped',
}
```

### Hard blockers

Block import for any selected row if:

- canonical SKU is empty
- canonical SKU duplicates another selected row with different `global_item_id/global_model_id`
- existing `products.sku` belongs to a different Shopee `global_item_id/global_model_id` and operator did not explicitly choose overwrite/relink
- eBay target is selected and SKU length exceeds 50 characters

---

## 2. Final Runtime Flow

```text
Operator searches Shopee Global Product
  ↓
Select Global Item(s) / models
  ↓
Import by exact Shopee SKU into products
  ↓
Persist Shopee global/shop mappings
  ↓
Build platform coverage matrix by SKU
  ↓
For each supported platform:
  - lookup by SKU
  - if found: absorb mapping into platform_listings
  - if missing: mark not_listed
  - if unsupported: skip
  ↓
Publish only not_listed rows for selected supported platforms
  ↓
Persist create results into platform_listings
```

Supported platforms for this flow:

- `shopee`: mapping only via Global Product/published list
- `joom`: lookup by SKU + create if missing
- `qoo10`: lookup by SKU + create if missing; adapter must be implemented
- `ebay`: lookup by SKU + publish if missing, subject to current eBay publish policy and category/aspect requirements

Excluded:

- `alibaba`: always skipped, shown as unsupported in UI

---

## 3. Implementation Tasks

### Task 1: Add a SKU coverage RPC/view for fast platform status

**Objective:** Given master product IDs, return platform status by SKU across Shopee/Joom/Qoo10/eBay, excluding Alibaba.

**Files:**
- Create migration: `supabase/migrations/202605290001_sku_coverage_matrix.sql`
- No frontend change yet

**SQL:**

```sql
create or replace view public.sku_platform_coverage as
select
  p.id as master_product_id,
  p.sku,
  'shopee'::text as platform,
  case
    when exists (
      select 1 from public.product_shopee_listings psl
      where psl.product_id = p.id
        and psl.shop_item_id is not null
        and coalesce(psl.status, '') in ('mapped', 'listed')
    ) then 'listed'
    when exists (
      select 1 from public.product_shopee_listings psl
      where psl.product_id = p.id
        and psl.global_item_id is not null
    ) then 'mapped_global'
    else 'not_listed'
  end as coverage_status,
  null::text as platform_item_id,
  null::text as external_variant_id,
  null::text as external_sku
from public.products p
where btrim(coalesce(p.sku, '')) <> ''

union all

select
  p.id as master_product_id,
  p.sku,
  platform_name.platform,
  coalesce((
    select case
      when pl.listing_status in ('listed', 'draft', 'pending') then pl.listing_status
      when pl.mapping_status = 'mapped' then 'listed'
      else pl.listing_status
    end
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = platform_name.platform
      and pl.deleted_at is null
    order by pl.updated_at desc
    limit 1
  ), 'not_listed') as coverage_status,
  (
    select pl.platform_item_id
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = platform_name.platform
      and pl.deleted_at is null
    order by pl.updated_at desc
    limit 1
  ) as platform_item_id,
  (
    select pl.external_variant_id
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = platform_name.platform
      and pl.deleted_at is null
    order by pl.updated_at desc
    limit 1
  ) as external_variant_id,
  (
    select pl.external_sku
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = platform_name.platform
      and pl.deleted_at is null
    order by pl.updated_at desc
    limit 1
  ) as external_sku
from public.products p
cross join (values ('joom'), ('qoo10'), ('ebay')) as platform_name(platform)
where btrim(coalesce(p.sku, '')) <> '';

grant select on public.sku_platform_coverage to authenticated;
```

**Verification:**

```sql
select * from public.sku_platform_coverage limit 20;
```

Expected:

- No `alibaba` rows
- Every non-empty product SKU has rows for Shopee/Joom/Qoo10/eBay

---

### Task 2: Add helper to absorb SKU lookup results into `platform_listings`

**Objective:** Create one SQL RPC that records “remote SKU already exists” without publishing duplicate products.

**Files:**
- Modify migration from Task 1 or create `supabase/migrations/202605290002_absorb_platform_sku_lookup.sql`

**SQL:**

```sql
create or replace function public.absorb_platform_sku_lookup(
  p_master_product_id uuid,
  p_platform text,
  p_external_sku text,
  p_platform_item_id text,
  p_external_variant_id text default null,
  p_country text default null,
  p_shop_id text default null,
  p_listing_status text default 'listed',
  p_raw_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_platform = 'alibaba' then
    raise exception 'Alibaba is unsupported for SKU dispatch';
  end if;

  if btrim(coalesce(p_external_sku, '')) = '' then
    raise exception 'external SKU required';
  end if;

  insert into public.platform_listings (
    master_product_id,
    platform,
    shop_id,
    country,
    platform_item_id,
    external_variant_id,
    external_sku,
    listing_status,
    mapping_status,
    publish_origin,
    last_payload,
    last_sync_at,
    last_seen_at
  ) values (
    p_master_product_id,
    p_platform,
    p_shop_id,
    p_country,
    p_platform_item_id,
    p_external_variant_id,
    p_external_sku,
    p_listing_status,
    'mapped',
    'remote_imported',
    p_raw_payload,
    now(),
    now()
  )
  on conflict on constraint platform_listings_dispatcher_uniq
  do update set
    platform_item_id = excluded.platform_item_id,
    external_variant_id = excluded.external_variant_id,
    external_sku = excluded.external_sku,
    listing_status = excluded.listing_status,
    mapping_status = 'mapped',
    publish_origin = 'remote_imported',
    last_payload = excluded.last_payload,
    last_sync_at = now(),
    last_seen_at = now(),
    deleted_at = null,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.absorb_platform_sku_lookup(uuid, text, text, text, text, text, text, text, jsonb) to authenticated;
```

**Note:** If `platform_listings_dispatcher_uniq` is an index rather than a named constraint, implement upsert from the frontend using `.upsert(..., { onConflict: 'master_product_id,platform,shop_id,country' })` or replace this RPC with explicit `select id ... for update` logic.

**Verification:**

- Call RPC with a known product and fake platform `joom` payload in a transaction/local DB.
- Confirm `platform_listings.external_sku = products.sku`.
- Confirm second call updates same row, not duplicate.

---

### Task 3: Implement Shopee Global Product import service in frontend

**Objective:** Convert selected Shopee Global Product rows into master products by exact Shopee SKU.

**Files:**
- Modify: `v2/index.html`

**Add helpers near existing Shopee Global Product search/import code:**

```js
function canonicalShopeeSkuForImport(item, model) {
  const sku = model
    ? String(model.global_model_sku || model.model_sku || '').trim()
    : String(item.global_item_sku || item.item_sku || '').trim();
  return sku;
}

function assertCanonicalSku(sku, contextLabel) {
  if (!sku) throw new Error(`${contextLabel}: Shopee SKU가 비어있어 마스터 상품으로 등록할 수 없습니다.`);
  if (hasNonMarketplaceText && hasNonMarketplaceText(sku)) {
    throw new Error(`${contextLabel}: SKU는 마켓플레이스 호환 문자만 허용됩니다: ${sku}`);
  }
}

function deriveShopeeOptionLabel(item, model) {
  const tierIndex = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const tiers = Array.isArray(item?.tier_variation) ? item.tier_variation : [];
  return tierIndex.map((idx, tierNo) => {
    const tier = tiers[tierNo] || {};
    const opt = (tier.option_list || [])[Number(idx)] || {};
    return opt.option || opt.name || opt.value || '';
  }).filter(Boolean).join(' / ');
}
```

**Core import behavior:**

- For single item: upsert by `products.sku` using `global_item_sku`.
- For models: upsert one `products` row per `global_model_sku`.
- Use a shared `product_group_id` for all models in the same Shopee `global_item_id`.
- Never generate SKU.
- If a selected model has no SKU, fail that row and show it in import log.

**Verification:**

- Select a no-model Shopee Global Product with SKU → one `products` row.
- Select a model Global Product with 3 model SKUs → three `products` rows sharing `product_group_id`.
- Empty SKU row is blocked before DB write.

---

### Task 4: Persist Shopee published mappings after import

**Objective:** After master upsert, map already-published Shopee shop listings by SKU.

**Files:**
- Modify: `v2/index.html`

**Behavior:**

1. For each unique `global_item_id`, call:

```js
GET `${SHOPEE_BRIDGE}/published_list?region=SG&global_item_id=${globalItemId}`
```

2. For each published shop item:
   - if no models: map `shop_item_id` directly
   - if models: call:

```js
GET `${SHOPEE_BRIDGE}/shop_model_list?region=${region}&item_id=${shopItemId}`
```

3. Match shop model to Global model by exact SKU:

```js
shopModel.model_sku === globalModel.global_model_sku
```

4. Upsert `product_shopee_listings` with `global_model_id` and `shop_model_id`.

**Fallback:**

- If model SKU match fails but model counts and ordering match, allow index fallback only with warning:
  - `last_error = 'mapping_inferred_by_index'`
- If model counts differ, skip that region/model and show operator warning.

**Verification:**

- Imported SKU with existing Shopee shop listing shows Shopee LED as mapped/listed.
- No duplicate `product_shopee_listings` rows for same `(product_id, region)`.

---

### Task 5: Add SKU lookup adapters for coverage matrix

**Objective:** Before publishing to non-Shopee platforms, check if the SKU already exists remotely.

**Files:**
- Modify: `v2/index.html` first, using existing bridge endpoints directly
- Later refactor into `platform-publish` adapters

**Frontend helper contract:**

```js
async function lookupPlatformBySku(platform, sku) {
  if (platform === 'alibaba') {
    return { platform, sku, supported: false, found: false, status: 'unsupported' };
  }
  if (platform === 'joom') return lookupJoomBySku(sku);
  if (platform === 'ebay') return lookupEbayBySku(sku);
  if (platform === 'qoo10') return lookupQoo10BySku(sku);
  throw new Error(`Unsupported platform: ${platform}`);
}
```

**Joom implementation:**

```js
async function lookupJoomBySku(sku) {
  const res = await fetch(`${JOOM_BRIDGE}/lookup-sku?sku=${encodeURIComponent(sku)}`, { headers: AUTH_HEADERS });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) return { platform: 'joom', sku, found: false, raw: json };
  return {
    platform: 'joom',
    sku,
    found: true,
    platform_item_id: json.joom_product_id || json.product_id,
    external_variant_id: json.joom_variant_id || json.variant_id,
    listing_status: 'listed',
    raw: json,
  };
}
```

**eBay implementation:**

```js
async function lookupEbayBySku(sku) {
  const res = await fetch(`${EBAY_BRIDGE}/lookup-item?sku=${encodeURIComponent(sku)}`, { headers: AUTH_HEADERS });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) return { platform: 'ebay', sku, found: false, raw: json };
  return {
    platform: 'ebay',
    sku,
    found: true,
    platform_item_id: json.listingId || json.ebay_item_id || json.itemId || sku,
    external_variant_id: null,
    listing_status: json.published === false ? 'draft' : 'listed',
    raw: json,
  };
}
```

**Qoo10 implementation:**

- Add a new `qoo10-bridge` first if none exists.
- Required endpoint:

```text
GET /lookup-sku?sku=...
```

- Normalized response:

```js
{
  ok: true,
  sku,
  goods_no,
  seller_code,
  status,
  raw
}
```

**Verification:**

- SKU existing on Joom returns `found: true` and writes `platform_listings`.
- Unknown SKU returns `found: false` and does not write `listed`.
- Alibaba returns unsupported without network call.

---

### Task 6: Add “Check existing platforms by SKU” UI action

**Objective:** Let the operator verify coverage before publishing.

**Files:**
- Modify: `v2/index.html`

**UI:**

Add button in product list/import result area:

```html
<button id="check-platform-sku-coverage" type="button">SKU로 기존 플랫폼 체크</button>
```

**Behavior:**

- For selected products:
  - validate `products.sku`
  - run lookup for `joom`, `qoo10`, `ebay`
  - skip `alibaba`
  - absorb found rows into `platform_listings`
  - show matrix:

```text
SKU ABC-001
- Shopee: mapped/listed
- Joom: found → mapped
- Qoo10: not found
- eBay: found → mapped
- Alibaba: unsupported
```

**Verification:**

- Running the check updates platform LEDs without publishing.
- No create/publish bridge endpoint is called during this step.

---

### Task 7: Publish only SKU gaps

**Objective:** Send each master product only to platforms where SKU lookup says `not_listed`.

**Files:**
- Modify: `v2/index.html`
- Modify later: `supabase/functions/platform-publish/index.ts` and adapters

**Gap selection:**

```js
const publishTargets = coverageRows.filter((row) =>
  ['joom', 'qoo10', 'ebay'].includes(row.platform)
  && row.coverage_status === 'not_listed'
);
```

**Rules:**

- Alibaba must never be included.
- If lookup failed due to auth/network error, do not publish; mark `error` and require retry.
- If lookup was not run in this session and no cached coverage exists, require lookup first.
- For eBay, enforce SKU max 50, category, description, image/aspect requirements before calling publish.
- For Qoo10, enforce category mapping before calling publish.

**Verification:**

- Product already found on Joom is not sent to Joom create endpoint.
- Same product missing on Qoo10 is queued/sent to Qoo10 only.
- Alibaba never receives a request.

---

### Task 8: Wire real platform-publish adapters incrementally

**Objective:** Move direct frontend bridge calls into dispatcher adapters after the behavior is proven.

**Files:**
- Modify: `supabase/functions/platform-publish/_shared/contract.ts`
- Create: `supabase/functions/platform-publish/adapters/joom.ts`
- Create: `supabase/functions/platform-publish/adapters/qoo10.ts`
- Create: `supabase/functions/platform-publish/adapters/ebay.ts`
- Modify: `supabase/functions/platform-publish/index.ts`

**Contract extension:**

Add lookup capability:

```ts
export type AdapterCapability =
  | 'lookup_by_sku'
  | 'create_listing'
  | ...;
```

**Adapter result should include SKU mapping fields:**

```ts
export type AdapterResult = {
  ok: boolean;
  platformItemId?: string;
  externalVariantId?: string;
  externalSku?: string;
  listingStatus: ...;
  errorCode?: AdapterErrorCode;
  errorMsg?: string;
  rawResponse?: unknown;
};
```

**Registry:**

```ts
const ADAPTERS: Record<string, PlatformAdapter> = {
  shopee: shopeeAdapter,
  joom: joomAdapter,
  qoo10: qoo10Adapter,
  ebay: ebayAdapter,
  // alibaba intentionally omitted
};
```

**Verification:**

- `platform-publish` with `platform='alibaba'` returns unsupported before adapter call.
- `lookup_by_sku` for Joom/eBay works through dispatcher.
- Existing create flow still works for Shopee.

---

## 4. Safety Invariants

These must be enforced in code review:

1. `products.sku` equals Shopee `global_item_sku` or `global_model_sku` exactly after trim.
2. No SKU generation or suffix fallback.
3. No platform create call before SKU lookup.
4. Existing platform SKU means “map only”, not “create again”.
5. Alibaba is skipped/unsupported in all new code paths.
6. Option products are one master row per Shopee model SKU.
7. Raw remote lookup/create response is saved in `last_payload` or snapshot table.
8. Auth/network lookup failures block publish for that platform; they do not imply `not_listed`.
9. eBay 404/not found is the only eBay condition that permits publish; any validation/auth/rate-limit error blocks publish.
10. Qoo10 missing bridge/credentials blocks publish; do not silently treat it as listed or created.

---

## 5. Acceptance Criteria

### Import

- Operator can search/select Shopee Global Product.
- Import creates master products using existing Shopee SKUs.
- Variant products create one row per `global_model_sku`.
- Empty SKU rows are rejected with clear UI message.
- Shopee mappings are stored in `product_shopee_listings`.

### Existing platform check

- Joom/eBay/Qoo10 lookup runs by SKU.
- Existing remote SKU creates/updates `platform_listings` with:
  - `external_sku`
  - `platform_item_id`
  - `external_variant_id` where applicable
  - `mapping_status='mapped'`
  - `publish_origin='remote_imported'`
- Alibaba is shown as unsupported and not queried.

### Publish gaps

- Only `not_listed` platforms are sent create/publish requests.
- Found platforms are never duplicated.
- Lookup errors block publish and surface to operator.
- Platform LEDs update after lookup/import/publish.

---

## 6. Recommended Execution Order

1. Implement DB coverage view + absorb RPC.
2. Add frontend Shopee SKU import helpers and validation.
3. Persist Shopee published mappings after import.
4. Add Joom/eBay direct SKU lookup coverage action.
5. Build Qoo10 bridge `lookup-sku` endpoint.
6. Add Qoo10 coverage action.
7. Add gap-only publish action using existing bridge calls.
8. Refactor into `platform-publish` adapters once behavior is verified.

This order gives value early and prevents duplicate platform publication before all adapters are complete.
