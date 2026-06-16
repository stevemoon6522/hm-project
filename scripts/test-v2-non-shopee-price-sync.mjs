import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to > from, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

const v2 = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const qoo10Bridge = readFileSync(join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts'), 'utf8');

const ebaySync = sliceBetween(v2, 'async function catExecuteEbaySync()', '  // ── Platform + Shopee market controls');
assert(
  /catPersistProductCost\(product\.id,\s*newCost,\s*now\)[\s\S]*fetch\(EBAY_BRIDGE \+ '\/update-price'/.test(ebaySync),
  'eBay sync must persist the edited settlement price before /update-price so the server-side price guard recomputes from the same cost',
);
assert(
  !/fetch\(EBAY_BRIDGE \+ '\/update-price'[\s\S]*catPersistProductCost\(product\.id,\s*newCost,\s*now\)/.test(ebaySync),
  'eBay sync must not wait until after /update-price to persist cost_krw',
);

const joomSync = sliceBetween(v2, 'async function catExecuteJoomSync()', '  async function catExecuteEbaySync()');
assert(
  /const newCost = productId in pendingCostEdits \? pendingCostEdits\[productId\] : Number\(product\.cost_krw \|\| 0\)/.test(joomSync),
  'Joom sync must compute price from the edited settlement price when one is pending',
);
assert(
  /JOOM_BRIDGE \+ '\/update-price'[\s\S]*price:\s*calc\.joomPrice/.test(joomSync),
  'Joom sync must send the newly computed Joom price to update-price',
);

assert(v2.includes('async function catExecuteQoo10Sync()'), 'V2 must implement a Qoo10 live price sync function');
assert(
  /case 'qoo10':\s*catExecuteQoo10Sync\(\);\s*break;/.test(v2),
  'Qoo10 tab sync button must route to catExecuteQoo10Sync, not a preview-only toast',
);
assert(v2.includes("QOO10_BRIDGE + '/lookup-sku?sku='"), 'Qoo10 sync must resolve the live goods_no by SKU before price update');
assert(v2.includes("QOO10_BRIDGE + '/set-price'"), 'Qoo10 sync must call the Qoo10 set-price bridge route');
assert(v2.includes('qoo10_last_synced_price'), 'V2 must cache Qoo10 last synced price for current/new delta display');

const setPrice = sliceBetween(qoo10Bridge, 'async function handleSetPrice', 'async function handleDeleteListing');
assert(setPrice.includes('10024-SetGoodsPriceQty.md'), 'Qoo10 set-price handler must cite the local SetGoodsPriceQty API doc');
assert(setPrice.includes('ItemsOrder.SetGoodsPriceQty'), 'Qoo10 set-price handler must call ItemsOrder.SetGoodsPriceQty');
assert(/Price:\s*String\(priceJpy\)/.test(setPrice), 'Qoo10 set-price handler must send Price from the computed JPY value');
assert(
  !/qoo10Fetch\("ItemsOrder\.SetGoodsPriceQty"[\s\S]{0,400}\bQty\s*:/.test(setPrice),
  'Qoo10 set-price handler must omit Qty so price sync does not change stock',
);
assert(
  /if \(action === "set-price" && req\.method === "POST"\)/.test(qoo10Bridge),
  'Qoo10 bridge router must expose POST /set-price',
);

console.log('non-Shopee price sync regression checks passed');
