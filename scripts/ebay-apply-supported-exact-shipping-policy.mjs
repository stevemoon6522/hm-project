#!/usr/bin/env node
/**
 * Apply the tested EBAY_US international shipping matrix that eBay actually accepts.
 *
 * eBay US Account/Trading APIs only accept a small direct ShipToLocation set for
 * international service rows (confirmed via GeteBayDetails ShippingLocationDetails):
 * GB, FR, AU, JP, DE, CA, BR, MX are usable for our current target lanes.
 * Other baseline-safe countries such as ES/SE/BG/SG/NZ/HK/MO are not accepted as
 * direct service destinations and require Seller Hub rate-table support if they
 * must remain enabled with exact country pricing.
 */
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

const policyId = process.argv[2];
const mode = process.argv[3] || 'dry-run';
if (!policyId) {
  console.error('Usage: node scripts/ebay-apply-supported-exact-shipping-policy.mjs <fulfillment_policy_id> [dry-run|apply]');
  process.exit(2);
}

const baselineFree = ['GB', 'FR', 'AU', 'JP'];
const extraFeeRows = [
  { code: 'DE', cost: '0.18' },
  { code: 'CA', cost: '0.58' },
  { code: 'BR', cost: '4.93' },
  { code: 'MX', cost: '7.25' },
];
const allowed = new Set([...baselineFree, ...extraFeeRows.map((row) => row.code)]);
const money = (value) => ({ currency: 'USD', value: String(value) });

const list = await ebay('/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
if (list.status !== 200) throw new Error(`Failed to list policies: ${JSON.stringify(list)}`);
const policy = (list.body.fulfillmentPolicies || []).find((row) => row.fulfillmentPolicyId === policyId);
if (!policy) throw new Error(`Fulfillment policy not found: ${policyId}`);

const existingExcluded = (policy.shipToLocations?.regionExcluded || []).map((row) => row.regionName);
const topLevelExcluded = [...new Set(existingExcluded.filter((regionName) => (
  !allowed.has(regionName)
  // BR is a direct service row; don't also exclude the parent region.
  && !(regionName === 'South America' && allowed.has('BR'))
)))].sort();
const domestic = (policy.shippingOptions || []).find((option) => option.optionType === 'DOMESTIC');
if (!domestic) throw new Error('Existing policy has no DOMESTIC shipping option to preserve');

const internationalServices = [
  {
    shippingServiceCode: 'StandardInternational',
    shippingCost: money(0),
    additionalShippingCost: money(0),
    freeShipping: false,
    sortOrder: 1,
    shipToLocations: { regionIncluded: baselineFree.map((regionName) => ({ regionName })) },
  },
  ...extraFeeRows.map((row, index) => ({
    shippingServiceCode: 'StandardInternational',
    shippingCost: money(row.cost),
    additionalShippingCost: money(row.cost),
    freeShipping: false,
    sortOrder: index + 2,
    shipToLocations: { regionIncluded: [{ regionName: row.code }] },
  })),
];

const payload = {
  name: 'KR Economy Supported Exact Extra Fees',
  marketplaceId: policy.marketplaceId,
  categoryTypes: policy.categoryTypes,
  handlingTime: policy.handlingTime,
  globalShipping: policy.globalShipping ?? false,
  localPickup: policy.localPickup ?? false,
  pickupDropOff: policy.pickupDropOff ?? false,
  shipToLocations: {
    regionIncluded: [{ regionName: 'Worldwide' }],
    regionExcluded: topLevelExcluded.map((regionName) => ({ regionName })),
  },
  shippingOptions: [
    domestic,
    { optionType: 'INTERNATIONAL', costType: 'FLAT_RATE', shippingServices: internationalServices },
  ],
};

if (mode === 'apply') {
  const update = await ebay(`/sell/account/v1/fulfillment_policy/${policyId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  console.log(JSON.stringify(update, null, 2));
  if (update.status < 200 || update.status >= 300) process.exit(1);
} else {
  console.log(JSON.stringify({ policyId, topLevelExcludedCount: topLevelExcluded.length, internationalServices, payload }, null, 2));
}
