#!/usr/bin/env node
/**
 * Batch re-fetch Shopee per-option images and update products.shopee_option_image_url.
 *
 * Background: the old import populated shopee_option_image_url incorrectly — every
 * option of a product fell back to the same (main) image — because the per-option
 * images in Shopee's `get_global_model_list` response (tier_variation[].option_list[].image)
 * were not extracted. The V2 import logic was fixed (commit f972ba2). This script
 * back-fills existing rows that were imported before the fix, by calling the same
 * shopee-bridge endpoint and applying the same extraction logic.
 *
 * Usage:
 *   # dry-run (prints what would change, no writes):
 *   node scripts/refetch-shopee-option-images.mjs "cortis"
 *   # apply:
 *   SUPABASE_SERVICE_KEY=... node scripts/refetch-shopee-option-images.mjs "cortis" --apply
 *   # all products with a shopee_item_id:
 *   SUPABASE_SERVICE_KEY=... node scripts/refetch-shopee-option-images.mjs "" --apply
 *
 * Options:
 *   --apply            actually write updates (default: dry-run)
 *   --region=TW        Shopee region passed to global_model_list (default: TW)
 *
 * Env:
 *   SUPABASE_SERVICE_KEY   required for --apply (writes bypass RLS). Read-only runs use anon.
 */

const SUPABASE_URL = 'https://mgqlwgnmwegzsjelbrih.supabase.co';
// Public anon key (safe to embed; same as the V2 frontend uses for the bridge).
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ncWx3Z25td2VnenNqZWxicmloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDkzNDMsImV4cCI6MjA5NDg4NTM0M30.mJtqXO7WJMBUYBYVOS1FrD5qmFX6yZxGwfiGw3HUyJE';
const SHOPEE_BRIDGE = `${SUPABASE_URL}/functions/v1/shopee-bridge`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const regionArg = (args.find((a) => a.startsWith('--region=')) || '').split('=')[1];
const REGION = regionArg || 'TW';
const nameFilter = args.find((a) => !a.startsWith('--')) ?? '';

// The products table is RLS-protected, so both reads and writes need the
// service-role key (anon SELECT returns 0 rows). Required for any run.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SERVICE_KEY) {
  console.error('ERROR: set SUPABASE_SERVICE_KEY env (products table is RLS-protected; anon reads return nothing).');
  process.exit(1);
}

// anon is fine for the shopee-bridge edge function (public); service key for DB.
const anonHeaders = { Authorization: `Bearer ${SUPABASE_ANON}`, apikey: SUPABASE_ANON };
const dbReadHeaders = { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY };
const writeHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
};

// --- extraction logic, ported from V2 v2/index.html (sgImageUrlFromImageObject / sgOptionImageUrl) ---
function firstArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}
function imageUrlFromImageObject(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  const url = image.image_url || image.url || image.image || firstArray(image.image_url_list)[0] || '';
  if (url) return url;
  const id = image.image_id || firstArray(image.image_id_list)[0] || '';
  return id ? `https://cf.shopee.sg/file/${id}` : '';
}
function optionImageUrl(tierVariation, tierIndex, mainImageUrl) {
  const tiers = Array.isArray(tierVariation) ? tierVariation : [];
  const idx = Array.isArray(tierIndex) ? tierIndex.map(Number) : [];
  for (let tierNo = 0; tierNo < idx.length; tierNo += 1) {
    const optList = firstArray(tiers[tierNo]?.option_list, tiers[tierNo]?.options);
    const option = optList[idx[tierNo]] || {};
    const url = imageUrlFromImageObject(option.image) || option.image_url || option.option_image_url || '';
    if (url) return url;
  }
  return mainImageUrl || '';
}

async function fetchProducts() {
  const params = new URLSearchParams({
    select: 'id,sku,option_name,shopee_item_id,shopee_option_image_url,shopee_global_model_raw_payload,shopee_global_raw_payload,main_image',
    shopee_item_id: 'not.is.null',
    order: 'shopee_item_id,option_name',
  });
  if (nameFilter) params.set('product_name', `ilike.*${nameFilter}*`);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/products?${params}`, { headers: dbReadHeaders });
  if (!r.ok) throw new Error(`product fetch failed ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchTierVariation(globalItemId) {
  const url = `${SHOPEE_BRIDGE}/global_model_list?region=${encodeURIComponent(REGION)}&global_item_id=${encodeURIComponent(globalItemId)}`;
  const json = await fetch(url, { headers: anonHeaders }).then((r) => r.json());
  if (json?.error || json?.result?.error) throw new Error(json?.message || json?.error || json?.result?.error || 'global_model_list failed');
  const resp = json.response || json.result?.response || json.result || json;
  return firstArray(resp.tier_variation, resp.tier_variation_list);
}

async function updateRow(id, url) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ shopee_option_image_url: url, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`update ${id} failed ${r.status}: ${await r.text()}`);
}

async function main() {
  console.log(`region=${REGION} filter=${nameFilter || '(all)'} mode=${apply ? 'APPLY' : 'dry-run'}`);
  const rows = await fetchProducts();
  const byItem = new Map();
  for (const row of rows) {
    const key = String(row.shopee_item_id);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(row);
  }
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const [itemId, group] of byItem) {
    let tierVariation;
    try {
      tierVariation = await fetchTierVariation(itemId);
    } catch (e) {
      console.warn(`! item ${itemId}: ${e.message} (skipped ${group.length} rows)`);
      failed += group.length;
      continue;
    }
    for (const row of group) {
      const tierIndex = row.shopee_global_model_raw_payload?.tier_index || [];
      const mainImg = imageUrlFromImageObject(row.shopee_global_raw_payload?.image) || row.main_image || '';
      const newUrl = optionImageUrl(tierVariation, tierIndex, mainImg);
      if (!newUrl) {
        console.warn(`  ? ${row.sku} (${row.option_name}): no option image resolved`);
        continue;
      }
      if (newUrl === row.shopee_option_image_url) {
        unchanged += 1;
        continue;
      }
      console.log(`  ${apply ? '~' : 'DRY'} ${row.sku} (${row.option_name}): ${String(row.shopee_option_image_url).slice(-22)} -> ${newUrl.slice(-22)}`);
      if (apply) {
        try {
          await updateRow(row.id, newUrl);
          changed += 1;
        } catch (e) {
          console.warn(`    ! update failed: ${e.message}`);
          failed += 1;
        }
      } else {
        changed += 1;
      }
    }
  }
  console.log(`\nDone. ${apply ? 'updated' : 'would update'}=${changed} unchanged=${unchanged} failed=${failed} items=${byItem.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
