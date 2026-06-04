import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the product-list eBay register button.
//
// Bug history: openRegisterEbayGroupModal lives in the outer script scope while
// mrOpenEbayModal is defined inside the master-register IIFE. The outer opener
// called the modal with a bare `mrOpenEbayModal(...)` reference, which raised a
// ReferenceError before the confirmation modal could open — so the product-list
// eBay button silently did nothing. Joom had already been fixed the same way
// (window bridge + window call) and is guarded by test-v2-joom-register-images-sku.mjs;
// eBay lacked an equivalent guard, which is how it regressed. This test mirrors
// the Joom guard for eBay.

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

assert(
  html.includes('data-open-ebay-group') && html.includes('data-open-ebay-single'),
  'Product list must render eBay register buttons (group + single)',
);
assert(
  html.includes('window.sdOpenRegisterEbayGroupModal = openRegisterEbayGroupModal'),
  'eBay register opener must be exported on window for the product-list buttons',
);

// The master-register eBay modal opener must be exported on window so the
// outer-scope product-list opener can reach it (the bridge).
assert(
  html.includes('window.mrOpenEbayModal = mrOpenEbayModal'),
  'Master-register eBay modal opener must be exported on window (bridge) for product-list eBay buttons',
);

// Both call sites inside openRegisterEbayGroupModal must go through the window
// bridge, never a bare `mrOpenEbayModal(...)` reference that ReferenceErrors.
assert(
  html.includes('window.mrOpenEbayModal(plBuildJoomPublishGroupFromProducts(rows))'),
  'Product-list eBay button (remote path) must open the modal through window.mrOpenEbayModal',
);
assert(
  html.includes('window.mrOpenEbayModal(plBuildJoomPublishGroupFromProducts(localVariantRows.length ? localVariantRows : localRows))'),
  'Product-list eBay button (local path) must open the modal through window.mrOpenEbayModal',
);

// And it must guard against the bridge being uninitialized, like Joom does.
assert(
  html.includes("if (typeof window.mrOpenEbayModal !== 'function')"),
  'openRegisterEbayGroupModal must guard against the eBay bridge being uninitialized',
);

console.log('v2 eBay register button bridge checks passed');
