# shopee-dashboard

**Live:** https://shopee-dashboard-kohl.vercel.app
**Repo:** https://github.com/stevemoon6522/shopee-dashboard
**Local:** `C:\dev\shopee-dashboard\index.html` (~2700 lines, ~200KB)

## Stack
Single `index.html` HTML+CSS+JS SPA, Supabase JS SDK for DB, fetch for `shopee-bridge` Edge Function. No build step.

## Shared Goal
Project objective is documented at `plans/project-goal.md` and should be treated as the primary product direction for Codex/Claude collaboration.

## Vercel deploy
**NOT auto-deployed from GitHub.** After `git push origin main`, run `vercel deploy --prod --yes` from the repo dir to push live.

## Backend
`shopee-bridge` Edge Function v19 (in shared `bpdafetvjyvvwbksvowu`):
- /list_items — paginated get_item_list + base_info + per-item get_model_list (multi-model expansion)
- /update_price — accepts model_id for variant-level pricing
- /tokens, /shop_info, /item_info, /global_*

Tables (this app's domain): `products`, `country_settings`, `product_shopee_listings` (incl. `shop_model_id` column for variants).

## Operating regions
6 only: SG / TW / TH / MY / PH / BR. VN and MX intentionally excluded.

## Key flows
- "🔗 Shopee 매핑 동기화" — fetches /list_items for all 6 regions in parallel, auto-matches dashboard SKUs by SKU exact then name exact (unique-only), preview table, bulk apply
- Per-product 📤 modal — paste shop_item_id per region, "💰 가격 일괄 갱신" → parallel /update_price calls (model_id-aware)

## Backlog
See `TODO.md` at repo root. Highest priority pending: §1.1 SET bundle data model — awaiting user answers to Q1-Q5 (region-specific components, cost override, nested bundles, auto stock push, label format).
