# Shopee SKU Change MVP

## Edge Functions

- `sku-change-prepare`: creates an audited dry-run job, fetches current Shopee listing SKUs, validates mapping input, and writes prepare snapshots.
- `sku-change-commit`: executes prepared jobs through official Shopee product SKU APIs and stores per-row request IDs/results.
- `sku-change-verify`: re-fetches current Shopee SKUs and compares them with target SKUs.

## Dry-run sample

Payload file:

- `scripts/sku-change-dry-run-sample.json`

Example:

```bash
curl -X POST "$SUPABASE_FUNCTION_URL/sku-change-prepare" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data @scripts/sku-change-dry-run-sample.json
```

## Commit and verify

```bash
curl -X POST "$SUPABASE_FUNCTION_URL/sku-change-commit" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"job_id":"<prepared-job-id>"}'

curl -X POST "$SUPABASE_FUNCTION_URL/sku-change-verify" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"job_id":"<committed-job-id>"}'
```

## API strategy

- Prepare fetches shop catalog with `v2.product.get_item_list`, `v2.product.get_item_base_info`, and `v2.product.get_model_list`.
- Commit uses `v2.product.update_item` for no-model item SKUs.
- Commit uses `v2.product.update_model` grouped by `item_id`, max 50 `model[]` rows per call.
- Token refresh uses Shopee `v2.public.refresh_access_token` at `/api/v2/auth/access_token/get`; shop-token refresh is used for product APIs, and the helper keeps merchant principal support for future merchant-scope calls.

## Safety rules

- Shop `1002269093` is blocked before prepare/commit/verify API calls.
- `new_sku` must be non-empty and <= 100 characters.
- Duplicate target SKUs are rejected per shop before commit.
- Job status transitions prevent committing invalid or already-running jobs.
- Partial failures stay retryable through `partial_failed` jobs; successful rows are not called again.
