#!/usr/bin/env node
/** Verify buyer-facing shipping costs for a variation listing via Browse API. */
import { execSync } from 'node:child_process';

function q(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }
function dbQuery(sql) {
  const out = execSync(`supabase db query --linked --output json ${q(sql)}`, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: 'C:/Program Files/Git/bin/bash.exe',
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

const itemGroupId = process.argv[2];
const countries = (process.argv[3] || 'US,GB,JP,FR,AU,DE,CA,BR,MX,ES').split(',').map((s) => s.trim()).filter(Boolean);
if (!itemGroupId) {
  console.error('Usage: node scripts/ebay-verify-browse-shipping.mjs <legacy_item_group_id> [US,GB,DE,...]');
  process.exit(2);
}

const creds = dbQuery('select client_id, client_secret from public.ebay_tokens where id=1;')[0];
const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
});
const token = await tokenRes.json();
if (!token.access_token) throw new Error(`Failed to get app token: ${JSON.stringify(token)}`);

for (const country of countries) {
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${encodeURIComponent(itemGroupId)}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'X-EBAY-C-ENDUSERCTX': `contextualLocation=country%3D${country}`,
      'Accept-Language': 'en-US',
    },
  });
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  const first = json.items?.[0];
  const option = first?.shippingOptions?.[0];
  console.log(JSON.stringify({
    country,
    httpStatus: res.status,
    itemId: first?.itemId,
    price: first?.price,
    shippingCost: option?.shippingCost,
    shippingServiceCode: option?.shippingServiceCode,
    errors: json.errors,
  }));
}
