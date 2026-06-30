# Shopee Registration Latency Review Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify Shopee API-backed ways to make V2 Shopee product registration faster without weakening publication correctness, cleanup safety, or local Platform Listing mapping.

**Architecture:** Keep the current CBSC/KRSC Shopee Global Product flow as the default path: Global Product creation, optional Global Model setup, Shop Item publication, result verification, and local mapping. Review only API calls that are provably redundant, cacheable, scopeable, or safely deferrable based on local Shopee docs and live timing evidence.

**Tech Stack:** Supabase Edge Function `shopee-bridge`, `platform-publish` Shopee adapter, Node smoke/regression scripts, local Shopee API docs under `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis`.

---

## Resolved Decisions

- [x] Default registration goal: keep **Shopee Global Product coverage**. Do not optimize the default path as a single-shop-only upload flow.
- [x] Treat shop-level `product.batch_add_item` only as a separately named future mode, not as a replacement for the CBSC/KRSC Global Product registration flow.
- [x] Move `get_shop_publishable_status` out of the default fast path. Call it only for strict diagnostics or after publish failures, while keeping `get_publishable_shop(shop_id_list)`, `create_publish_task`, and `get_published_list` in the normal path.
- [x] Preserve English Shopee Shop Item names and option names for TW/TH/BR. Do not omit `item.item_name`, `item.description`, or `item.standardise_tier_variation` from the default fast path when those fields carry the Global Product's English copy.
- [x] For TW title length conflicts, auto-generate a `TW English Short Name` and continue registration. The generator removes availability phrases such as `READY STOCK` or `PRE ORDER` first; if the name is still over 60 characters, remove version terms next. Idol and album terms remain protected.
- [x] If the TW name still exceeds 60 characters after removing availability phrases and version terms, stop automatic registration before calling Shopee APIs and require manual title review.
- [x] Identify removable version terms from V2 structured option/version data first, not from free-text title guessing.
- [x] For multi-version products, TW `item.item_name` should be the common product title only; individual version names remain in `standardise_tier_variation[].variation_option_list[].variation_option_name`.
- [x] Do not build automatic shortening for Shopee option names. starphotocard has not seen Shopee option-name length failures in 3+ years of operation, so keep only a defensive preflight error if an option name somehow exceeds the Shopee limit.
- [x] Store Shopee registration read-cache state in Supabase DB, not Edge Function memory or `shopee_mutation_log`.
- [x] Use `24h` TTL for `get_attribute_tree`, `6h` TTL for `get_channel_list`, plus operator `force_refresh` and forced-refresh retry after logistics/channel publish failures.

---

## Evidence Snapshot

Latest deployed stabilization:

- Commit: `c053fab Stabilize Shopee publish polling latency`
- Supabase Edge Function: `shopee-bridge` ACTIVE v143
- Live SG disposable registration/delete cycles after stabilization:
  - Run 1: `40.0s`, `poll_attempts=9`, `verified_via_early_published_list_9`, delete OK
  - Run 2: `26.6s`, `poll_attempts=9`, `verified_via_early_published_list_9`, delete OK
  - Run 3: `27.7s`, `poll_attempts=9`, `verified_via_early_published_list_9`, delete OK

Interpretation:

- `get_publish_task_result` still lags behind actual publication.
- `get_published_list` early verification is now doing useful work.
- Remaining avoidable latency is likely in repeated read/preflight calls before or around `create_publish_task`, not in the mandatory write APIs themselves.

## Local Shopee Docs Checked

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_model.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publish_task_result.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_published_list.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publishable_shop.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_shop_publishable_status.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_attribute_tree.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\media_space\v2.media_space.upload_image.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\logistics\v2.logistics.get_channel_list.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_add_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.init_tier_variation.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_tier_variation.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_item_limit.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_global_item_limit.json`

## Docs Finding: English Regional Names

Shopee API docs support keeping TW/TH/BR regional Shop Item names and option names in English, but the default fast path must send or sync those fields explicitly.

- `create_publish_task` accepts optional `item.item_name`; docs say Shopee uses the uploaded value, and only auto-translates the Global Product name when this field is omitted.
- `create_publish_task` accepts optional `item.description`; docs say Shopee uses the uploaded value, and only auto-translates the Global Product description when this field is omitted.
- `create_publish_task` accepts optional `item.standardise_tier_variation[].variation_name` and `variation_option_name`, allowing the publish payload to carry English variation and option names.
- `set_sync_field` includes required booleans `name_and_description` and `tier_variation_name_and_option` for shop regions including `TW`, `TH`, and `BR`.
- `product.init_tier_variation` / `product.update_tier_variation` docs also expose `standardise_tier_variation[].variation_name` and `variation_option_name`, confirming option names are writable fields in Shopee's standardised variation structure.
- `product.get_item_limit` exposes `item_name_length_limit.max_limit`; V2 treats TW Shop Item names as a 60-character limit.
- `global_product.get_global_item_limit` exposes `global_item_name_length_limit.max_limit`, so Global Product name limits and regional Shop Item name limits must be treated separately.

Decision for latency review:

- Do not make `item.item_name`, `item.description`, or `item.standardise_tier_variation` omission part of the default fast path.
- Minimal publish payload can only be an isolated probe mode, and must verify the resulting Shop Item name, description, variation name, and option names after publish.
- For TW, when the Global English Name is over 60 characters, send a generated `TW English Short Name` in `create_publish_task.item.item_name` instead of omitting the field or letting Shopee auto-translate.
- `TW English Short Name` generation order:
  1. Start from the Global English Name.
  2. Remove stock-state phrases like `READY STOCK` or `PRE ORDER`.
  3. If still over 60 characters, remove version terms identified from V2 structured option/version data first.
  4. Preserve idol and album identifiers.
  5. If still over 60 characters, fail preflight and stop automatic registration.
- Version source priority:
  1. `products.variation_option_names`
  2. `products.option_name`
  3. Other approved V2 option/version metadata already attached to the Master Product rows
  4. Conservative fallback title patterns only when no structured source exists
- Multi-version rule:
  - TW `create_publish_task.item.item_name` carries the common product title.
  - Version-specific names stay in `item.standardise_tier_variation[].variation_option_list[].variation_option_name`.
  - Do not concatenate all versions into TW `item.item_name`.
- Option-name length rule:
  - Do not auto-shorten Shopee option names.
  - If an option name exceeds the Shopee limit, fail preflight with the exact option name and region.
  - Treat this as an exceptional data issue, not a normal registration branch.

## API Shortcut Matrix

| Candidate | Docs basis | Current behavior | Review decision |
| --- | --- | --- | --- |
| Skip `add_global_item` | `add_global_item` creates the Shopee Global Product and returns `global_item_id` | Required before `create_publish_task` | Do not skip |
| Skip `create_publish_task` | It creates the Shopee Shop Item publication task | Required for each target shop/region | Do not skip |
| Replace result polling with only `get_published_list` | `get_published_list` returns `published_item[].item_id`; `get_publish_task_result` returns success/failure reason | Current path polls task and early-checks published list | Probe whether task polling can stop earlier after repeated published-list misses; do not remove task polling entirely yet |
| Scope `get_publishable_shop` | Docs added optional `shop_id_list` on 2024-03-27 | Current register path calls by `global_item_id` only | High-value probe: pass target shop IDs to reduce response size and latency |
| Always call `get_shop_publishable_status` | Docs require `global_item_id`, `offset`, `page_size`; no `shop_id_list` option | Current register path calls it every registration for diagnostic reasons | Decision: remove from default fast path; call only for strict diagnostics or failure investigation |
| Cache `get_attribute_tree` | Docs: read API, required `category_id_list`, optional `language` | Current path calls per registration and per region set | High-value probe: cache by `account_key:region:category_id:language` with TTL |
| Cache `get_channel_list` | Docs: read API, no request params, returns logistics channel list | Current path calls per target region per registration | High-value probe: cache by `account_key:region:is_pre_order` with TTL and delivery-only filtering |
| Use shop-level `product.batch_add_item` | Docs: shop-level Product API, not Global Product API | Current V2 uses CBSC Global Product path | Not a default replacement; evaluate only as a separate single-shop direct-upload mode |

## Task 1: Build a Timing Evidence Pack

**Files:**

- Read: `C:\dev\shopee-dashboard\supabase\functions\shopee-bridge\index.ts`
- Read: `C:\dev\shopee-dashboard\scripts\platform-test-cycle.mjs`
- Output draft: `C:\dev\shopee-dashboard\tmp\shopee-registration-latency-review.jsonl`

- [ ] **Step 1: Capture current timing fields from live disposable cycles**

Run three SG-only cycles with the same disposable Master Product used in the previous smoke:

```powershell
$env:SUPABASE_URL = 'https://bpdafetvjyvvwbksvowu.supabase.co'
$productId = '049d92ae-747d-4960-9a58-1bb4d3a26616'
1..3 | ForEach-Object {
  node scripts/platform-test-cycle.mjs shopee-cycle --live --region SG --productId $productId
}
```

Expected evidence fields:

- `register.timing_ms.category_attributes`
- `register.timing_ms.add_global_item`
- `register.timing_ms.publish_regions`
- `register.timing_ms.mapping`
- `register.results[0].timing_ms.create_publish_task`
- `register.results[0].timing_ms.publish_task_polling`
- `register.results[0].timing_ms.publish_task_poll_wait`

- [ ] **Step 2: Classify each timing component**

Use this classification:

- `mandatory_write`: `add_global_item`, `add_global_model`, `create_publish_task`
- `required_verification`: `get_publish_task_result`, `get_published_list`
- `preflight_read`: `get_attribute_tree`, `get_publishable_shop`, `get_shop_publishable_status`, `get_channel_list`
- `local_persistence`: mapping save and cleanup state

Expected result:

- A table ranking components by median and p95 latency.
- Only `preflight_read` and `required_verification` components are considered for removal/caching in the next tasks.

## Task 2: Probe Scoped Publishability Reads

**Files:**

- Modify later if approved: `C:\dev\shopee-dashboard\supabase\functions\shopee-bridge\index.ts`
- Test later if approved: `C:\dev\shopee-dashboard\scripts\test-v2-shopee-registration-reliability.mjs`

- [ ] **Step 1: Confirm current unscoped call**

Find current calls:

```powershell
rg -n "get_publishable_shop|get_shop_publishable_status" supabase/functions/shopee-bridge/index.ts
```

Expected:

- `get_publishable_shop` currently uses `{ global_item_id }`.
- `get_shop_publishable_status` currently uses `{ global_item_id, offset: 0, page_size: 100 }`.

- [ ] **Step 2: Design scoped `get_publishable_shop` call**

Docs-backed change candidate:

```ts
const targetShopIds = targetInputs
  .map((target: any) => Number(target.shop_id))
  .filter((shopId: number) => Number.isFinite(shopId) && shopId > 0);

const query: Record<string, string> = { global_item_id: String(global_item_id) };
if (targetShopIds.length) query.shop_id_list = targetShopIds.join(',');
```

Expected:

- Same success/failure classification.
- Less response payload.
- Less time before region publish starts.

- [x] **Step 3: Decide whether `get_shop_publishable_status` belongs in fast path**

Decision rule:

- Move to `strict_diagnostics` mode because it mostly improves error messages but adds measurable latency.
- Call after a failed `create_publish_task` or unresolved publish verification to preserve debuggability.
- Never remove the existing blocked-shop local guard for banned BR shop `1002269093`.

## Task 3: Probe Read-API Caching

**Files:**

- Modify later if approved: `C:\dev\shopee-dashboard\supabase\functions\shopee-bridge\index.ts`
- Create later: `C:\dev\shopee-dashboard\supabase\migrations\YYYYMMDDHHMM_shopee_registration_read_cache.sql`
- Test later if approved: `C:\dev\shopee-dashboard\scripts\test-v2-shopee-registration-reliability.mjs`

Cache store decision:

- Use Supabase DB for read-cache state.
- Do not use Edge Function in-memory cache as the primary store because it disappears across restarts and scaled instances.
- Do not use `shopee_mutation_log`; read-cache state is operational cache data, not a mutation audit record.
- The cache table should support `cache_key`, `payload`, `expires_at`, `created_at`, `updated_at`, and lightweight hit/miss timing evidence.

- [ ] **Step 1: Cache `get_attribute_tree` results**

Candidate cache key:

```text
shopee_global_attribute_tree:v1:{account_key}:{region}:{category_id}:en
```

TTL recommendation:

- Use `24h`.
- Allow operator `force_refresh=true` to bypass cache when category rules or mandatory attributes look stale.

Acceptance criteria:

- Missing mandatory attributes are still surfaced before `add_global_item`.
- Cache hit path must include a `timing_ms.category_attributes_cached=true` or equivalent evidence field.

- [ ] **Step 2: Cache `get_channel_list` results**

Candidate cache key:

```text
shopee_logistics_channels:v1:{account_key}:{region}
```

TTL recommendation:

- Use `6h`.
- Emergency bypass flag: `force_logistics_refresh=true`.

Acceptance criteria:

- Delivery-only filtering remains in code, not in cached data.
- Pre-order filtering still uses `support_pre_order === true`.
- If cached channels produce a `create_publish_task` channel failure, retry once after forced refresh.
- Record cache hit/miss and refresh timing in the registration timing evidence.

## Task 4: Probe Minimal Publish Payload

**Files:**

- Modify later if approved: `C:\dev\shopee-dashboard\supabase\functions\shopee-bridge\index.ts`
- Test later if approved: `C:\dev\shopee-dashboard\scripts\test-v2-shopee-registration-reliability.mjs`

- [ ] **Step 1: Define the minimum legal payload**

Docs-backed required fields for `create_publish_task` include:

- `global_item_id`
- `shop_id`
- `shop_region`
- `item.image.image_id_list`
- `item.logistic[].logistic_id`
- `item.logistic[].enabled`
- `item.pre_order.is_pre_order`
- model fields when publishing variations

Optional fields that may be omitted in a probe:

- `item.item_name`
- `item.description`
- `item.item_status`
- `item.attribute_list`

Default fast-path constraint:

- Do not omit `item.item_name`, `item.description`, or `item.standardise_tier_variation` for TW/TH/BR when the desired Shop Item output is the exact English Global Product name and option names.
- For TW, if the exact Global English Name exceeds 60 characters, use the generated `TW English Short Name` as the explicit `item.item_name`; do not rely on auto-translation or silent truncation.

- [ ] **Step 2: Run A/B disposable live probes**

Probe modes:

- `full_publish_item`: current payload
- `minimal_publish_item`: omit optional local overrides where safe

Acceptance criteria:

- `item_id` is returned or confirmed via `get_published_list`.
- Shopee Shop Item name/description outcome is acceptable for starphotocard operations.
- No increase in `create_publish_task` failure rate.

Risk:

- This may change regional Shop Item content because docs say omitted name/description can be auto-translated from the Global Product. Treat this as a content-policy decision, not only a latency decision.

## Task 5: Probe Multi-Region Concurrency

**Files:**

- Modify later if approved: `C:\dev\shopee-dashboard\supabase\functions\shopee-bridge\index.ts`
- Modify later if approved: `C:\dev\shopee-dashboard\supabase\functions\platform-publish\adapters\shopee.ts`
- Test later if approved: `C:\dev\shopee-dashboard\scripts\test-v2-shopee-registration-reliability.mjs`

- [ ] **Step 1: Compare current concurrency**

Current known settings:

- Bridge region publish concurrency: `mapWithConcurrency(targetInputs, 2, ...)`
- Platform publish batch size: `SHOPEE_REGISTER_REGION_BATCH_SIZE = 3`

- [ ] **Step 2: Probe concurrency 3**

Acceptance criteria:

- No Supabase Edge Function timeout.
- No Shopee rate-limit or transient failure increase.
- Median multi-region registration decreases by at least `15%`.

Rollback criteria:

- Any increase in partial publish failures.
- Any increase in `crossupload_permission` or `error_system_busy` responses.

## Task 6: Evaluate Shop-Level Batch API as a Separate Mode

**Files:**

- Read: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_add_item.json`
- Read: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_batch_task_result.json`

- [ ] **Step 1: Confirm domain mismatch**

Use glossary terms from `C:\dev\shopee-dashboard\CONTEXT.md`:

- Current default publishes a **Shopee Global Product** and one or more **Shopee Shop Items**.
- `product.batch_add_item` creates shop-level products and does not establish the same Shopee Global Product parent.

- [ ] **Step 2: Decide whether to create a separate operator mode**

Recommended default:

- Do not replace CBSC Global Product registration.
- Only consider `batch_add_item` for a separately named `single-shop direct upload` mode when the operator explicitly does not need Global Product coverage.

## Review Gate

Do not implement latency changes until these questions are answered:

1. [Answered] Is the default registration path optimized for **Shopee Global Product coverage** or for **single-shop fastest upload**?
   - Decision: **Shopee Global Product coverage** remains the default target.
2. [Answered] Can fast path skip `get_shop_publishable_status` and accept lower diagnostic detail when `create_publish_task` fails?
   - Decision: **Yes**. The default fast path should skip it and call it only for strict diagnostics or failure investigation.
3. [Answered] Is it acceptable for a minimal publish payload to let Shopee auto-translate or inherit Shop Item name/description?
   - Decision: **No for the default fast path**. Exact English TW/TH/BR Shop Item names and option names require explicit payload fields or sync fields.
4. [Answered] How should TW's 60-character title limit be handled during registration?
   - Decision: Auto-generate `TW English Short Name` and continue registration. Remove `READY STOCK` / `PRE ORDER` first, then remove version terms if still over 60 characters. Preserve idol and album terms.
5. [Answered] What if the generated TW English Short Name is still over 60 characters?
   - Decision: Stop automatic registration before Shopee API calls and require manual title review.
6. [Answered] Where should removable TW version terms be identified from?
   - Decision: Use V2 structured option/version data first, especially `products.variation_option_names` and `products.option_name`. Free-text title patterns are fallback only.
7. [Answered] How should TW names work for multi-version products?
   - Decision: TW `item.item_name` is the common product title only. Version names remain in Shopee option names, not concatenated into the product title.
8. [Answered] Should option names be auto-shortened if they exceed Shopee's option-name limit?
   - Decision: **No**. Option-name length failures have not appeared in 3+ years of operation, so only add defensive preflight validation and stop if it ever happens.
9. [Answered] Should read-cache state live in Supabase DB, Edge in-memory cache, or existing `shopee_mutation_log`-style records?
   - Decision: Use **Supabase DB cache**. Do not use Edge in-memory cache as the primary store, and do not mix read-cache state into `shopee_mutation_log`.
10. [Answered] What TTL and refresh policy should Shopee read-cache use?
   - Decision: `get_attribute_tree` uses `24h`, `get_channel_list` uses `6h`, both support operator force-refresh, and logistics/channel publish failures trigger one forced-refresh retry.

Recommended first implementation slice after review:

1. Add scoped `get_publishable_shop(shop_id_list)` and timing evidence.
2. Add logistics + attribute-tree read cache with forced refresh fallback.
3. Run live disposable SG-only and 3-region probes.
4. Decide whether to attempt minimal publish payload or concurrency 3.

Verification order note:

- Use `SG-only -> TW-included -> 3-region` as the rollout verification order.
- Do not serialize production registration by region for this validation strategy.
- Production registration must keep the current bounded batch/concurrency fast path; TW short-name generation is local preflight work and must not force SG-first publication.
