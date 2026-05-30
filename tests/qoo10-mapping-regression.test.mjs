import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bridge = readFileSync(join(process.cwd(), 'supabase/functions/qoo10-bridge/index.ts'), 'utf8');
const adapter = readFileSync(join(process.cwd(), 'supabase/functions/platform-publish/adapters/qoo10.ts'), 'utf8');

test('Qoo10 option lookup only trusts seller option code fields, not internal OptionCode', () => {
  assert.doesNotMatch(
    bridge,
    /itemTypeCode:\s*firstNonEmpty\([^\n]*(row\?\.OptionCode|row\?\.optionCode)/s,
    'internal Qoo10 OptionCode must not be treated as a seller SKU match source'
  );
  assert.doesNotMatch(
    bridge,
    /sameSku\(row\.optionCode,\s*sku\)/,
    'known item lookup must not map a product by internal optionCode'
  );
});

test('Qoo10 platform-publish adapter rejects bridge hits that do not echo the requested SKU', () => {
  assert.match(
    adapter,
    /function\s+validateQoo10SkuHit\s*\(/,
    'adapter should validate the bridge response before absorb_platform_sku_lookup can run'
  );
  assert.match(
    adapter,
    /PLATFORM_SKU_MISMATCH/,
    'SKU mismatch responses should be blocked with an explicit error code'
  );
  assert.match(
    adapter,
    /json\?\.verified_sku\s*\|\|\s*json\?\.seller_code\s*\|\|\s*json\?\.option_code/,
    'validation should require the bridge to echo the requested seller SKU'
  );
});

test('Qoo10 adapter sends an existing item code as a verification hint when present', () => {
  assert.match(
    adapter,
    /lookupQoo10BySku\(sku,\s*userAuthToken,\s*existingItemCode\)/,
    'existing qoo10 platform_item_id should be verified against inventory before remapping'
  );
  assert.match(
    adapter,
    /item_code=\$\{encodeURIComponent\(itemCode\)\}/,
    'lookup URL should include item_code when available'
  );
});
