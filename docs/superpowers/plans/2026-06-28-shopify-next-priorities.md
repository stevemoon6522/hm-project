# Shopify Next Priorities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Shopify product registration rollout in priority order, verifying each priority before starting the next.

**Architecture:** Priority 1 validates the existing browser-authenticated V2 `platform-publish` path end to end before changing more code. Later priorities add shipping-rate, DB-configured pricing, and active-registration safety only after the previous priority has verified evidence.

**Tech Stack:** Shopee Dashboard V2 static app, Supabase Edge Functions, Supabase Postgres, Shopify Admin GraphQL 2026-04, local Shopify API refs under `C:\dev\api-refs\marketplaces\shopify`.

---

### Task 1: Verify Platform-Publish Live Shopify Create

**Files:**
- Read: `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\v2\index.html`
- Read: `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\supabase\functions\platform-publish\index.ts`
- Read: `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\supabase\functions\platform-publish\adapters\shopify.ts`
- Update results: `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\docs\superpowers\plans\2026-06-28-shopify-platform-publish-live-results.md`

- [x] Confirm the V2 browser is authenticated and app shell is visible.
- [x] Select one Shopify-unmapped master product with SKU, title, `cost_krw`, and public HTTPS image.
- [x] Run one dry-run through `platform-publish` or the V2 UI and verify `status: ACTIVE`, USD price policy, and no inventory push.
- [x] Run exactly one live create through the V2/platform-publish path.
- [x] Verify Shopify lookup by SKU returns the Product GID, Variant GID, status/listing status, and expected price.
- [x] Verify `platform_listings` has a mapped Shopify row for the master product without manual absorb.
- [x] Write the evidence and any issues to the results file.
- [x] Run static regression tests:

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-v2-qa-stabilization.mjs
```

### Task 2: Add Shopify Weight-Based Shipping Flow

**Files:**
- Read local docs first:
  - `C:\dev\api-refs\marketplaces\shopify\carrier-service-create.graphql.html`
  - `C:\dev\api-refs\marketplaces\shopify\carrier-service.rest.html`
  - `C:\dev\api-refs\marketplaces\shopify\carrier-service-query.graphql.html`
- Modify/create Edge and API files after Task 1 passes.

- [x] Check shop eligibility for CarrierService / carrier-calculated shipping before coding.
- [x] Write failing tests for callback request parsing and rate response shape.
- [x] Implement a Shopify rate callback that calculates shipping from item grams.
- [x] Register or document the CarrierService setup path.
- [x] Verify with dry-run callback payloads and Shopify health checks.

Result: see `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\docs\superpowers\plans\2026-06-28-shopify-shipping-rates-results.md`. Actual `carrierServiceCreate` is intentionally blocked until the shop reauthorizes with `write_shipping`; the deployed endpoint returns `shopify_write_shipping_scope_missing` for the current `write_products`-only token.

### Task 3: Move Shopify Price Policy to DB/UI

**Files:**
- Modify likely DB migration/settings model.
- Modify `v2/index.html`.
- Modify `supabase/functions/platform-publish/adapters/shopify.ts`.
- Test: `scripts/test-shopify-product-registration.mjs`.

- [ ] Write failing tests that adapter no longer hardcodes 1460/30/1/10 when DB settings exist.
- [ ] Add DB-backed Shopify policy settings.
- [ ] Add V2 UI controls for exchange rate and fee/margin fields.
- [ ] Verify dry-run reflects updated settings.

### Task 4: Add Active Registration Safety

**Files:**
- Modify `supabase/functions/platform-publish/adapters/shopify.ts`.
- Modify `supabase/functions/shopify-bridge/index.ts`.
- Modify `v2/index.html`.
- Test: `scripts/test-shopify-product-registration.mjs`.

- [ ] Write failing tests for duplicate SKU preflight and partial-create cleanup behavior.
- [ ] Add duplicate SKU lookup before live create.
- [ ] Add cleanup/archive path for product-created-but-variants-failed cases.
- [ ] Add final confirmation for Active Shopify registration.
- [ ] Verify live/dry-run behavior with safe generated SKUs.
