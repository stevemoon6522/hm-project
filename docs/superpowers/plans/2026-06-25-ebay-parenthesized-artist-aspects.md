# Master Title Artist Normalization and eBay Aspects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize parenthesized artist text at the shared master-title parsing layer first, then allow eBay K-pop album registration to derive required category `176984` item specifics from the corrected parser output.

**Architecture:** Treat `mrDeriveFromTitle()` as the browser-side common parser for master creation, product-list marketplace adapters, and the eBay modal. Fix artist normalization there first, keep the raw `product_name` intact, and mirror the same parsing rule in the server headless eBay bridge so non-modal publish paths remain defensive.

**Tech Stack:** Static V2 HTML/JavaScript, Supabase Edge Functions TypeScript, Node static/regression tests, local eBay API reference `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`.

---

## Investigation Summary

Root cause:

- `v2/index.html` `mrDeriveFromTitle()` is used when master rows are created from crawled titles and later reused by product-list Joom/eBay registration helpers.
- That parser treats a dash title prefix as the artist source, then removes a trailing parenthesized segment with `dashM[1].replace(/\([^)]*\)\s*$/, '')`.
- For `[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]`, the dash prefix is exactly `(ILLIT)`, so the replacement leaves an empty artist.
- The same parser shape exists in `supabase/functions/ebay-bridge/index.ts` `deriveEbayKpopFromTitle()`, so the headless eBay register path has the same latent defect.
- The current parser then incorrectly treats `(ILLIT)` as the version candidate because no artist was derived.

Confirmed local reproduction:

```json
{
  "title": "[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]",
  "derived": {
    "artist": "",
    "album": "NOT CUTE Ver. / NOT MY NAME Ver.",
    "version": "ILLIT",
    "member": ""
  }
}
```

Working comparison:

```json
{
  "title": "[READY STOCK] CORTIS The 1st EP [COLOR OUTSIDE THE LINES] (Weverse Albums ver.)",
  "derived": {
    "artist": "CORTIS",
    "album": "COLOR OUTSIDE THE LINES",
    "version": "Weverse Albums",
    "member": ""
  }
}
```

API/doc basis:

- `plans/ebay-kpop-listing-process-plan.md` defines `Music > CDs`, category ID `176984`, and required item specifics `Artist`, `Release Title`.
- `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml` documents `product.aspects` and `inventory_item_group.aspects` as required before publish.
- `docs/wiki/ebay-master-content-sync.md` documents that eBay variation group updates replace the Inventory API group/item product data.

## Recommended Approach

Normalize the common master-title parser first, then keep eBay-specific guards.

- Recognize a dash prefix that is exactly parenthesized, e.g. `(ILLIT) - ...`, as the artist instead of deleting it.
- Do not remove all parentheses globally. Only unwrap a complete wrapper around the artist candidate; official names such as `(G)I-DLE` must not be corrupted.
- Preserve `product_name` as the operator/source title. Normalize only derived fields such as `artist`, `album`, `version`, and eBay aspects.
- Treat bracket values that look like option/version lists, e.g. `[NOT CUTE Ver. / NOT MY NAME Ver.]`, as variation metadata, not `Release Title`.
- Add regression expectations for the common V2 parser and the headless bridge parser.
- Keep schema unchanged. `products.artist` and `products.brand` are not real V2 columns, so adding schema for this narrow failure would be unnecessary blast radius.

Rejected alternatives:

- Add an `artist` column to `products`: too broad for a parser bug, and would require data migration/operator backfill.
- Special-case only `ILLIT`: too narrow; the same title shape can occur for other K-pop artists.
- Remove the frontend validation: unsafe, because eBay category `176984` really does require item specifics before publish.

## File Structure

- Modify `scripts/test-v2-ebay-kpop-listing-flow.mjs`: shared V2 `mrDeriveFromTitle()` regression for `(ILLIT) - ...`.
- Modify `scripts/test-v2-ebay-headless-register-product.mjs`: bridge/headless parser regression for the same title shape.
- Modify `v2/index.html`: common master-title parser and eBay aspect derivation fallback.
- Modify `supabase/functions/ebay-bridge/index.ts`: server title parser mirror.
- Modify `edge-functions/ebay-bridge/index.ts`: keep the deployed mirror identical to the Supabase function source.

### Task 1: Add Common V2 Parser Regression

**Files:**
- Modify: `scripts/test-v2-ebay-kpop-listing-flow.mjs`

- [ ] **Step 1: Write the failing test**

Add this assertion after the existing CORTIS/JENNIE parser assertions. This test covers the shared master-title parser, not only eBay, because the test extracts `mrDeriveFromTitle()` from the master-register module.

```js
assert.deepEqual(
  deriveFromTitle('[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]'),
  { artist: 'ILLIT', album: 'NOT CUTE ANYMORE', version: '', member: '' },
  'parenthesized artist before a dash must become the derived master artist, and bracketed version options must not become the album title',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node scripts/test-v2-ebay-kpop-listing-flow.mjs
```

Expected: FAIL because current output has `artist: ''`, `album: 'NOT CUTE Ver. / NOT MY NAME Ver.'`, and `version: 'ILLIT'`.

### Task 2: Fix Shared V2 Master-Title Parser and eBay Aspect Fallback

**Files:**
- Modify: `v2/index.html`

- [ ] **Step 1: Update bracket filtering helpers**

Near `mrFirstMeaningfulBracketValue()`, add an album-specific filter. This prevents option/version bracket text from becoming the derived album title:

```js
function mrLooksLikeVersionBracket(value) {
  const normalized = mrNormalizeDerivedTitleToken(value);
  return /\bVER(?:SION)?\.?\b/i.test(normalized) || /\s\/\s/.test(normalized);
}

function mrFirstMeaningfulAlbumBracketValue(title) {
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(String(title || '')))) {
    const value = mrNormalizeDerivedTitleToken(m[1]);
    if (!value || mrIsListingStatusTag(value) || mrLooksLikeVersionBracket(value)) continue;
    return value;
  }
  return '';
}
```

- [ ] **Step 2: Make dash-prefix artist extraction unwrap only full artist wrappers**

In `mrDeriveFromTitle()`, replace the dash branch artist extraction with logic that unwraps `(ILLIT)` but does not strip arbitrary parentheses from the full title:

```js
if (dashM) {
  const parenthesizedArtist = dashM[1].match(/^\s*\(([^)]+)\)\s*$/);
  const artistSource = parenthesizedArtist ? parenthesizedArtist[1] : dashM[1].replace(/\([^)]*\)\s*$/, '');
  const artist = mrNormalizeDerivedTitleToken(artistSource);
  if (artist) out.artist = artist;
  remainder = mrStripListingStatusPrefix(dashM[2]);
} else {
  out.artist = mrLeadingUppercaseTokenBlock(eng);
}
```

- [ ] **Step 3: Keep version brackets out of derived album and eBay `Release Title`**

Change the album selection in `mrDeriveFromTitle()` to use the new album bracket helper:

```js
const album = mrFirstMeaningfulAlbumBracketValue(remainder) || mrFirstMeaningfulAlbumBracketValue(eng);
```

Then update `mrFallbackAlbumFromDashRemainder()` so it removes bracketed option/version text before returning fallback title text:

```js
function mrFallbackAlbumFromDashRemainder(value) {
  return mrNormalizeDerivedTitleToken(value)
    .replace(/\[[^\]]*(?:\bVER(?:SION)?\.?\b|\/)[^\]]*\]/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:\d+(?:st|nd|rd|th)?\s+)?(?:EP|ALBUM|MINI|FULL|SINGLE)\b.*$/i, ' ')
    .replace(/\b(?:WEVERSE|PLATFORM|PHOTOBOOK|DIGIPACK|JEWEL|STANDARD)\s+VER\.?.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Add known-artist fallback only after parser output**

Near the parser helpers, add:

```js
function mrKnownKpopArtistFromText() {
  const haystack = Array.from(arguments).map(v => String(v || '')).join(' ').toUpperCase();
  if (/\b(TOMORROW X TOGETHER|TXT)\b/.test(haystack)) return 'TOMORROW X TOGETHER';
  if (/\bBTS\b/.test(haystack)) return 'BTS';
  if (/\bENHYPEN\b/.test(haystack)) return 'ENHYPEN';
  if (/\bSEVENTEEN\b/.test(haystack)) return 'SEVENTEEN';
  if (/\bLE SSERAFIM\b/.test(haystack)) return 'LE SSERAFIM';
  if (/\bNEWJEANS\b/.test(haystack)) return 'NEWJEANS';
  if (/\bILLIT\b/.test(haystack)) return 'ILLIT';
  if (/\bBOYNEXTDOOR\b/.test(haystack)) return 'BOYNEXTDOOR';
  return '';
}
```

Then update `mrEbayBuildAspects()`. This is eBay-specific defense in depth; the first fix remains the shared parser:

```js
const artist = String(
  (mrIsListingStatusTag(storedArtist) ? '' : storedArtist)
  || derived.artist
  || mrKnownKpopArtistFromText(titleForDerivation, firstRow?.sku, sourceRow?.sku)
  || ''
).trim().slice(0, 50);
```

- [ ] **Step 5: Run V2 parser regression**

Run:

```powershell
node scripts/test-v2-ebay-kpop-listing-flow.mjs
```

Expected: PASS.

### Task 3: Add Headless Bridge Parser Regression

**Files:**
- Modify: `scripts/test-v2-ebay-headless-register-product.mjs`

- [ ] **Step 1: Write the failing test**

Add this assertion after the existing parser assertions:

```js
assert.deepEqual(
  deriveEbayKpopFromTitle('[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]'),
  { artist: 'ILLIT', album: 'NOT CUTE ANYMORE', version: '', member: '' },
  'headless builder must mirror shared master-title parsing for parenthesized dash-prefix artists and bracketed option versions',
);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node scripts/test-v2-ebay-headless-register-product.mjs
```

Expected: FAIL for the same parser mismatch.

### Task 4: Fix Bridge Parser Mirror

**Files:**
- Modify: `supabase/functions/ebay-bridge/index.ts`
- Modify: `edge-functions/ebay-bridge/index.ts`

- [ ] **Step 1: Apply the same parser changes to the Supabase bridge**

Mirror the corrected shared V2 parser behavior in `deriveEbayKpopFromTitle()`:

```ts
if (dashM) {
  const parenthesizedArtist = dashM[1].match(/^\s*\(([^)]+)\)\s*$/);
  const artistSource = parenthesizedArtist ? parenthesizedArtist[1] : dashM[1].replace(/\([^)]*\)\s*$/, "");
  const artist = normalizeDerivedTitleToken(artistSource);
  if (artist) out.artist = artist;
  remainder = stripListingStatusPrefix(dashM[2]);
} else {
  out.artist = leadingUppercaseTokenBlock(eng);
}
```

Add TypeScript equivalents of `looksLikeVersionBracket()` and `firstMeaningfulAlbumBracketValue()`, then use them for `album` selection.

- [ ] **Step 2: Copy Supabase bridge to the edge mirror**

After updating the Supabase function source, copy the exact file to the mirror:

```powershell
Copy-Item -LiteralPath .\supabase\functions\ebay-bridge\index.ts -Destination .\edge-functions\ebay-bridge\index.ts
```

- [ ] **Step 3: Run bridge regression**

Run:

```powershell
node scripts/test-v2-ebay-headless-register-product.mjs
```

Expected: PASS.

### Task 5: Cross-Path Validation

**Files:**
- No additional production changes.

- [ ] **Step 1: Run focused eBay checks**

Run:

```powershell
node scripts/test-v2-ebay-kpop-listing-flow.mjs
node scripts/test-v2-ebay-headless-register-product.mjs
node scripts/test-v2-ebay-master-sync.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run platform coverage and mirror checks**

Run:

```powershell
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-platform-test-cycle.mjs
```

Expected: all PASS, including the hash equality between `supabase/functions/ebay-bridge/index.ts` and `edge-functions/ebay-bridge/index.ts`.

- [ ] **Step 3: Review rendered local `/v2/` app**

Start a local static server and open `/v2/`:

```powershell
npx http-server . -p 4173
```

Use the browser to verify:

- eBay registration modal opens.
- A fixture/group with title `[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]` no longer shows `eBay item specific Artist is required for category 176984`.
- The derived master artist is `ILLIT`; the raw master/product title is not globally stripped.
- Payload preview includes:

```json
{
  "aspects": {
    "Artist": ["ILLIT"],
    "Release Title": ["NOT CUTE ANYMORE"]
  }
}
```

### Task 6: Commit, Push, Deploy After Approval Only

**Files:**
- Commit the scoped implementation and tests only after Steve approves this plan.

- [ ] **Step 1: Commit**

Run:

```powershell
git add v2/index.html supabase/functions/ebay-bridge/index.ts edge-functions/ebay-bridge/index.ts scripts/test-v2-ebay-kpop-listing-flow.mjs scripts/test-v2-ebay-headless-register-product.mjs docs/superpowers/plans/2026-06-25-ebay-parenthesized-artist-aspects.md
git commit -m "Fix master artist parsing for eBay aspects" -m "Co-Authored-By: Codex <codex@openai.com>"
```

- [ ] **Step 2: Push main**

Run:

```powershell
git push origin main
```

- [ ] **Step 3: Deploy production**

Run:

```powershell
vercel deploy --prod --yes
```

- [ ] **Step 4: Live smoke check**

Open:

```text
https://shopee-dashboard-kohl.vercel.app/v2/
```

Verify the eBay registration modal still loads and the live app source contains the updated parser behavior.

## Self-Review

- Spec coverage: Covers the reported ILLIT failure, the shared master parser, the known CORTIS working case, browser modal registration, headless register-product path, bridge mirror, local render gate, and post-approval deploy gate.
- Placeholder scan: No `TBD`, `TODO`, or unresolved implementation placeholders.
- Type consistency: Browser helper names use `mr...`; bridge helpers use TypeScript-style camelCase names. Test assertions match the expected parser return shape `{ artist, album, version, member }`.
