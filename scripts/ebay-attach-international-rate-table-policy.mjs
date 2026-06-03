#!/usr/bin/env node
/** Attach an existing eBay international rate table to a fulfillment policy. */
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
async function accessToken() {
  return dbQuery('select access_token from public.ebay_tokens where id=1;')[0].access_token;
}
async function ebay(path, init = {}) {
  const res = await fetch(`https://api.ebay.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const policyId = process.argv[2] || '252849805025';
const rateTableId = process.argv[3] || '5241175019';
const mode = process.argv[4] || 'dry-run';
const list = await ebay('/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
if (list.status !== 200) throw new Error(`Failed to list policies: ${JSON.stringify(list)}`);
const policy = (list.body.fulfillmentPolicies || []).find((row) => row.fulfillmentPolicyId === policyId);
if (!policy) throw new Error(`Fulfillment policy not found: ${policyId}`);
const domestic = (policy.shippingOptions || []).find((option) => option.optionType === 'DOMESTIC');
if (!domestic) throw new Error('Existing policy has no DOMESTIC shipping option to preserve');
const money = (value) => ({ currency: 'USD', value: String(value) });
const payload = {
  name: policy.name,
  marketplaceId: policy.marketplaceId,
  categoryTypes: policy.categoryTypes,
  handlingTime: policy.handlingTime,
  globalShipping: policy.globalShipping ?? false,
  localPickup: policy.localPickup ?? false,
  pickupDropOff: policy.pickupDropOff ?? false,
  shipToLocations: {
    regionIncluded: [{ regionName: 'Worldwide' }],
    regionExcluded: (policy.shipToLocations?.regionExcluded || []).filter((row) => row.regionName !== 'Worldwide'),
  },
  shippingOptions: [
    domestic,
    {
      optionType: 'INTERNATIONAL',
      costType: 'FLAT_RATE',
      rateTableId,
      shippingServices: [{
        shippingServiceCode: 'StandardInternational',
        shippingCost: money(0),
        additionalShippingCost: money(0),
        freeShipping: false,
        sortOrder: 1,
        shipToLocations: { regionIncluded: [{ regionName: 'Worldwide' }] },
      }],
    },
  ],
};
if (mode === 'apply') {
  const update = await ebay(`/sell/account/v1/fulfillment_policy/${policyId}`, { method: 'PUT', body: JSON.stringify(payload) });
  console.log(JSON.stringify(update, null, 2));
  if (update.status < 200 || update.status >= 300) process.exit(1);
} else {
  console.log(JSON.stringify({ policyId, rateTableId, payload }, null, 2));
}
