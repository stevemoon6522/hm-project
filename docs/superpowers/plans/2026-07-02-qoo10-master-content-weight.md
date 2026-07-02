# Qoo10 Master Content And Weight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Qoo10 registration and existing-item repair use the curated Master Product representative image, curated Master Product detail images, and a positive Qoo10 `Weight` value converted from `products.weight_g`.

**Architecture:** Keep the V2 Qoo10 modal as the operator entrypoint, but introduce a small Qoo10 content projection layer in `v2/index.html` so representative image, detail images, and weight are derived from the Master Product once and reused by create and repair flows. Defensively keep `platform-publish` and `qoo10-bridge` aligned so non-modal create calls and existing repair calls do not send `Weight=0` and do send positive kg weights when master grams exist.

**Tech Stack:** Plain HTML/JS in `v2/index.html`, Node regression scripts, Supabase Edge Functions (`qoo10-bridge`, `platform-publish`), Qoo10 local API docs.

---

## Evidence And Local Docs

Local API docs checked before planning:

- `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-등록\10009-SetNewGoods.md`
- `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10010-UpdateGoods.md`
- `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10027-EditGoodsContents.md`
- `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10028-EditGoodsImage.md`
- `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10029-EditGoodsMultiImage.md`

Current code evidence:

- `v2/index.html` `mrQoo10ImageCandidates()` adds `row.main_image`, `row._main_image`, every `_mrQoo10.mainImages[]`, and Shopee image-id URLs, so the operator can see several thumbnails and accidentally pick a source that should not become Qoo10 `StandardImage`.
- `v2/index.html` `mrQoo10DetailImageUrls()` merges live StarOneMall crawl detail images before `products.extra_images`, so a banner removed from the Master Product can return from the crawler path.
- `v2/index.html` `mrQoo10ReadPayload()` does not include `weight_kg`, so `mrQoo10RepairExistingListing()` calls `/update-goods` without a positive converted master weight.
- `supabase/functions/platform-publish/adapters/qoo10.ts` has `weightKg(ctx)`, but it only reads `ctx.masterProduct.weight_g`; grouped Qoo10 creates should use the maximum positive grouped master/option weight.
- `supabase/functions/qoo10-bridge/index.ts` already omits `Weight` when the normalized kg value is not positive. Keep that behavior and add regression coverage so callers cannot send `Weight=0`.

## FABLE5 Debugging Hypotheses

1. Representative image failure class: Qoo10 source candidates are too broad, and the selected candidate is later passed through the layer builder. Cheapest measurement: run a unit harness against `mrQoo10ImageCandidates()` with a master row plus option rows and confirm only one candidate remains after the fix.
2. Detail image failure class: Qoo10 registration uses live crawler detail images as a source of truth instead of curated `products.extra_images`. Cheapest measurement: run a unit harness where `_mrQoo10.detailImages` contains a banner but the row `extra_images` does not; the result must exclude the banner.
3. Weight edit failure class: Qoo10 `UpdateGoods` cannot repair an existing listing that has or receives weight 0. Cheapest measurement: inspect dry-run/update payloads and verify positive master grams become `weight_kg` and bridge `Weight`, while zero grams omit `Weight`.

## File Structure

- Modify: `v2/index.html`
  - Qoo10 modal image helpers around `mrQoo10ImageCandidates()`, `mrQoo10DetailImageUrls()`, `mrQoo10BuildDescription()`, and `mrQoo10ReadPayload()`.
  - Existing Qoo10 repair path around `mrQoo10RepairExistingListing()`.
- Modify: `supabase/functions/platform-publish/adapters/qoo10.ts`
  - Group-aware kg conversion fallback for create-listing calls.
- Modify: `supabase/functions/qoo10-bridge/index.ts`
  - Add an explicit `normalizeQoo10WeightKg()` helper and use it in create/update paths.
- Modify: `tests/qoo10-mapping-regression.test.mjs`
  - Add static guards for Qoo10 content and weight semantics.
- Create: `scripts/test-v2-qoo10-master-content-weight.mjs`
  - Executable unit harness for representative image, detail image, and kg conversion behavior.

---

### Task 1: Add Failing Qoo10 Regression Tests

**Files:**
- Create: `scripts/test-v2-qoo10-master-content-weight.mjs`
- Modify: `tests/qoo10-mapping-regression.test.mjs`

- [ ] **Step 1: Create the executable V2 helper test**

Create `scripts/test-v2-qoo10-master-content-weight.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert(start >= 0, `${functionName} must exist`);
  const paramsEnd = source.indexOf(')', start);
  const open = source.indexOf('{', paramsEnd);
  assert(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

const factory = new Function(`
  const window = { location: { href: 'https://dashboard.local/v2/' } };
  function text(value) { return String(value || ''); }
  function rshNormalizeImageUrl(raw) { return String(raw || '').trim(); }
  function plIsGroupedVariant(row) {
    return !!(row && row.product_group_id && String(row.id || '') !== String(row.product_group_id || ''));
  }
  function plMasterEditNormalizeImageList(values, baseUrl, options = {}) {
    const exclude = new Set((options.exclude || []).map((value) => String(value || '').trim()).filter(Boolean));
    const seen = new Set();
    return (values || [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((value) => !exclude.has(value))
      .filter((value) => !(options.filterBanners && /(?:starone|staronemall|notice|banner)/i.test(value)))
      .filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  }
  let _mrQoo10 = {
    allRows: [],
    rows: [],
    mainImages: [],
    detailImages: [],
    selectedMainImageUrl: '',
  };
  ${extractFunctionBlock(html, 'mrQoo10ImageRows')}
  ${extractFunctionBlock(html, 'mrQoo10NormalizeImageUrl')}
  ${extractFunctionBlock(html, 'mrQoo10ImageRefKey')}
  ${extractFunctionBlock(html, 'mrQoo10AddImageRef')}
  ${extractFunctionBlock(html, 'mrQoo10RepresentativeImageRef')}
  ${extractFunctionBlock(html, 'mrQoo10ImageCandidates')}
  ${extractFunctionBlock(html, 'mrQoo10MainImageSource')}
  ${extractFunctionBlock(html, 'mrQoo10SelectedMainImageUrl')}
  ${extractFunctionBlock(html, 'mrQoo10DetailImageUrls')}
  ${extractFunctionBlock(html, 'mrQoo10WeightKgFromRows')}
  return {
    state: _mrQoo10,
    mrQoo10ImageCandidates,
    mrQoo10SelectedMainImageUrl,
    mrQoo10DetailImageUrls,
    mrQoo10WeightKgFromRows,
  };
`);

const {
  state,
  mrQoo10ImageCandidates,
  mrQoo10SelectedMainImageUrl,
  mrQoo10DetailImageUrls,
  mrQoo10WeightKgFromRows,
} = factory();

state.allRows = [
  {
    id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS',
    main_image: 'https://cdn.example.com/master-representative.jpg',
    extra_images: ['https://cdn.example.com/detail-clean.jpg'],
    staronemall_url: 'https://staronemall.example/item',
  },
  {
    id: 'option-a',
    product_group_id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS-A',
    main_image: 'https://cdn.example.com/option-a-layered.jpg',
    _main_image: 'https://cdn.example.com/source-option-a.jpg',
    extra_images: [],
  },
  {
    id: 'option-b',
    product_group_id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS-B',
    main_image: 'https://cdn.example.com/option-b-layered.jpg',
    _main_image: 'https://cdn.example.com/source-option-b.jpg',
    extra_images: [],
  },
];
state.rows = state.allRows.slice(1);
state.mainImages = [
  'https://cdn.staronemall.example/live-main-1.jpg',
  'https://cdn.staronemall.example/live-main-2.jpg',
];
state.detailImages = [
  'https://cdn.staronemall.example/starone-banner.jpg',
  'https://cdn.staronemall.example/live-detail.jpg',
];

const candidates = mrQoo10ImageCandidates(state.rows);
assert.equal(candidates.length, 1, 'Qoo10 modal must expose exactly one automatic representative candidate');
assert.equal(candidates[0].src, 'https://cdn.example.com/master-representative.jpg');
assert.equal(mrQoo10SelectedMainImageUrl(state.rows), 'https://cdn.example.com/master-representative.jpg');

assert.deepEqual(
  mrQoo10DetailImageUrls(state.rows),
  ['https://cdn.example.com/detail-clean.jpg'],
  'Qoo10 detail images must follow curated Master Product extra_images and ignore stale crawler banners',
);

assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 365 }, { weight_g: 120 }]), 0.4);
assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 0 }, { weight_g: 80 }]), 0.1);
assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 0 }]), 0);

console.log('v2 Qoo10 master content and weight checks passed');
```

- [ ] **Step 2: Add static regression checks**

Append these assertions inside `tests/qoo10-mapping-regression.test.mjs` near the existing Qoo10 V2 modal test:

```js
  assert.match(html, /function\s+mrQoo10RepresentativeImageRef\s*\(/, 'Qoo10 modal should centralize one automatic master representative image');
  assert.doesNotMatch(html, /mrQoo10AddImageRef\(refs,\s*seen,\s*row\._main_image/, 'Qoo10 representative candidates must not include per-option source images');
  assert.match(html, /function\s+mrQoo10WeightKgFromRows\s*\(/, 'Qoo10 modal should convert master weight_g to Qoo10 kg');
  assert.match(html, /weight_kg:\s*mrQoo10WeightKgFromRows\(rows\)/, 'Qoo10 create and repair payload should include converted master weight_kg');
```

Append this bridge/adapter guard to the same test file:

```js
test('Qoo10 create and update payloads use positive kg weight only', () => {
  assert.match(adapter, /function qoo10WeightKgFromGrams\s*\(/, 'Qoo10 adapter should centralize gram-to-kg conversion');
  assert.match(adapter, /Math\.ceil\(\(grams \/ 1000\) \* 10\) \/ 10/, 'Qoo10 adapter should round weight up to one decimal kg');
  assert.match(adapter, /weight_kg:\s*resolvedWeightKg/, 'Qoo10 adapter create payload should pass resolved positive weight_kg');
  assert.match(bridge, /function normalizeQoo10WeightKg\s*\(/, 'Qoo10 bridge should normalize Weight in one helper');
  assert.match(bridge, /if \(weightKg > 0\) params\.Weight = weightKg\.toFixed\(1\);/, 'Qoo10 bridge must omit Weight when the value is zero');
});
```

- [ ] **Step 3: Run tests and confirm red**

Run:

```bash
node scripts/test-v2-qoo10-master-content-weight.mjs
node tests/qoo10-mapping-regression.test.mjs
```

Expected: FAIL because `mrQoo10RepresentativeImageRef()`, `mrQoo10WeightKgFromRows()`, and explicit kg helpers do not exist yet.

---

### Task 2: Make Qoo10 Representative Image One Automatic Master Image

**Files:**
- Modify: `v2/index.html`

- [ ] **Step 1: Add the single representative helper**

Add this before `mrQoo10ImageCandidates(rows)`:

```js
  function mrQoo10RepresentativeImageRef(rows) {
    const imageRows = mrQoo10ImageRows(rows);
    const masterRows = imageRows.filter((row) => !plIsGroupedVariant(row));
    const sourceRows = masterRows.length ? masterRows : imageRows;
    const masterRow = sourceRows.find((row) => String(row?.main_image || '').trim()) || sourceRows[0] || {};
    const masterImage = mrQoo10NormalizeImageUrl(masterRow.main_image, masterRow.staronemall_url || window.location.href);
    if (masterImage) {
      return {
        src: masterImage,
        sourceUrl: masterImage,
        staronemallUrl: masterRow.staronemall_url || '',
        sku: masterRow.sku || '',
        kind: 'master-representative',
        label: 'Master representative',
      };
    }
    const fallbackRow = sourceRows.find((row) => String(row?.staronemall_url || '').trim()) || sourceRows[0] || {};
    const fallback = (Array.isArray(_mrQoo10.mainImages) ? _mrQoo10.mainImages : [])
      .map((url) => mrQoo10NormalizeImageUrl(url, fallbackRow.staronemall_url || window.location.href))
      .find(Boolean);
    return fallback ? {
      src: fallback,
      sourceUrl: fallback,
      staronemallUrl: fallbackRow.staronemall_url || '',
      sku: fallbackRow.sku || '',
      kind: 'staronemall-main',
      label: 'StarOne main 1',
    } : null;
  }
```

- [ ] **Step 2: Replace broad image candidates**

Replace `mrQoo10ImageCandidates(rows)` with:

```js
  function mrQoo10ImageCandidates(rows) {
    const ref = mrQoo10RepresentativeImageRef(rows);
    return ref ? [{ ...ref, idx: 0 }] : [];
  }
```

This intentionally removes `row._main_image`, every additional StarOne main image, and Shopee image-id fallbacks from the Qoo10 representative chooser. Manual URL fallback still works because `mrQoo10BindImageControls()` can append a manual candidate after the operator explicitly pastes one.

- [ ] **Step 3: Adjust image panel copy and layout for one candidate**

In `mrQoo10RenderImagePanel(rows)`, keep the source grid but change the label text to avoid implying a required choice:

```js
          Source representative image applied from Master Product.
```

Keep the one source cell visible for confirmation, and keep `mr-qoo10-manual-image-url` for emergency override.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node scripts/test-v2-qoo10-master-content-weight.mjs
node tests/qoo10-mapping-regression.test.mjs
node scripts/test-v2-marketplace-layered-image.mjs
node scripts/test-v2-shopee-layer-idempotency.mjs
```

Expected: the new representative test passes, and existing layered-image/idempotency tests still pass.

---

### Task 3: Make Qoo10 Detail Images Follow Master Product Extra Images

**Files:**
- Modify: `v2/index.html`

- [ ] **Step 1: Add curated detail image detection**

Add before `mrQoo10DetailImageUrls(rows)`:

```js
  function mrQoo10HasCuratedDetailImageField(rows) {
    return mrQoo10ImageRows(rows).some((row) => Array.isArray(row?.extra_images));
  }
```

- [ ] **Step 2: Replace `mrQoo10DetailImageUrls(rows)`**

Replace the body with:

```js
  function mrQoo10DetailImageUrls(rows) {
    const imageRows = mrQoo10ImageRows(rows);
    const first = imageRows[0] || {};
    const curatedSource = imageRows.flatMap((row) => Array.isArray(row.extra_images) ? row.extra_images : []);
    const crawlerSource = Array.isArray(_mrQoo10.detailImages) ? _mrQoo10.detailImages : [];
    const source = mrQoo10HasCuratedDetailImageField(imageRows) ? curatedSource : crawlerSource;
    return plMasterEditNormalizeImageList(
      source,
      first.staronemall_url || window.location.href,
      { exclude: [mrQoo10SelectedMainImageUrl(imageRows)], filterBanners: true },
    ).slice(0, 50);
  }
```

This makes `products.extra_images` authoritative when the Master Product has a curated detail-image field, including the valid case where the curated list is empty after banner removal. The StarOneMall crawler becomes only a legacy fallback for rows without curated detail-image data.

- [ ] **Step 3: Keep description and preview on the same source**

No separate implementation should be added. `mrQoo10DetailImageRefs()`, `mrQoo10RenderImagePreview()`, and `mrQoo10BuildDescription()` already call `mrQoo10DetailImageUrls()`, so replacing the helper synchronizes preview and publish payload together.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node scripts/test-v2-qoo10-master-content-weight.mjs
node tests/qoo10-mapping-regression.test.mjs
node scripts/test-v2-platform-master-sync.mjs
```

Expected: PASS. The new helper test must prove the stale StarOne banner is excluded when the Master Product `extra_images` excludes it.

---

### Task 4: Send Qoo10 Weight In KG For Create And Existing Repair

**Files:**
- Modify: `v2/index.html`
- Modify: `supabase/functions/platform-publish/adapters/qoo10.ts`
- Modify: `supabase/functions/qoo10-bridge/index.ts`

- [ ] **Step 1: Add V2 modal kg conversion**

Add near `mrQoo10ReadNumber()`:

```js
  function mrQoo10WeightKgFromRows(rows) {
    const grams = (rows || [])
      .map((row) => Number(row?.weight_g || row?._weight_g || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!grams.length) return 0;
    const maxGrams = Math.max(...grams);
    return Math.min(30, Math.max(0.1, Math.ceil((maxGrams / 1000) * 10) / 10));
  }
```

- [ ] **Step 2: Show the applied Qoo10 weight in the modal**

In `mrQoo10RenderModal(rows)`, compute:

```js
    const weightKg = mrQoo10WeightKgFromRows(rows);
```

Add this field near `Origin`:

```html
        <label class="field">Weight (kg)
          <input type="number" min="0.1" max="30" step="0.1" id="mr-qoo10-weight-kg" value="${text(weightKg ? weightKg.toFixed(1) : '')}" readonly>
        </label>
```

- [ ] **Step 3: Add `weight_kg` to the Qoo10 publish payload**

In `mrQoo10ReadPayload()`, compute:

```js
    const weightKg = mrQoo10WeightKgFromRows(rows);
```

Add this to `publish`:

```js
        weight_kg: weightKg,
```

Keep the value positive-or-zero in UI code. The bridge will omit `Weight` when `weight_kg` is 0, and the main fix is that products with positive `weight_g` now send a positive kg value.

- [ ] **Step 4: Make platform-publish group-aware**

In `supabase/functions/platform-publish/adapters/qoo10.ts`, replace `weightKg(ctx)` with:

```ts
function qoo10WeightKgFromGrams(value: unknown): number {
  const grams = Number(value || 0);
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Math.min(30, Math.max(0.1, Math.ceil((grams / 1000) * 10) / 10));
}

function weightKg(ctx: AdapterContext): number {
  const groupRows = publishableGroupRows(ctx.masterProduct || {}, (ctx as any).groupProducts || []);
  const grams = [ctx.masterProduct, ...groupRows]
    .map((row: any) => Number(row?.weight_g || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return qoo10WeightKgFromGrams(grams.length ? Math.max(...grams) : 0);
}
```

In `executeCreate(ctx)`, compute before `payload`:

```ts
  const resolvedWeightKg = Number(qoo10.weight_kg || weightKg(ctx) || 0);
```

Then keep the payload field explicit:

```ts
    weight_kg: resolvedWeightKg,
```

- [ ] **Step 5: Make qoo10-bridge normalization explicit**

In `supabase/functions/qoo10-bridge/index.ts`, add near `normalizeQoo10PriceEnding90()`:

```ts
function normalizeQoo10WeightKg(value: unknown): number {
  const kg = Number(value || 0);
  if (!Number.isFinite(kg) || kg <= 0) return 0;
  return Math.min(30, Math.max(0.1, Math.ceil(kg * 10) / 10));
}
```

In both `updateGoodsBasic(body)` and `handleCreateListing(req)`, replace:

```ts
  const weightKg = Math.max(0, Number(body.weight_kg || body.Weight || 0) || 0);
```

with:

```ts
  const weightKg = normalizeQoo10WeightKg(body.weight_kg || body.Weight);
```

Keep this existing send guard in both paths:

```ts
  if (weightKg > 0) params.Weight = weightKg.toFixed(1);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node scripts/test-v2-qoo10-master-content-weight.mjs
node tests/qoo10-mapping-regression.test.mjs
node scripts/test-v2-qoo10-option-price-guard.mjs
node scripts/test-v2-qoo10-registration-platform-mapping.mjs
```

Expected: PASS.

---

### Task 5: Verify The Target Product Flow Locally

**Files:**
- No additional source files.

- [ ] **Step 1: Start local static app**

Run:

```bash
npx http-server . -p 4173
```

Open:

```text
http://127.0.0.1:4173/v2/
```

- [ ] **Step 2: Check the CORTIS product modal**

Find:

```text
[READY STOCK] CORTIS The 2nd EP [GREENGREEN] ('Blue Lips' Lip Balm ver.)
```

Open Qoo10 registration/repair modal and verify:

- `Source representative image applied from Master Product.` shows one source cell only.
- The one source cell is the Master Product representative image, not an option image and not another StarOne main image.
- `1. Representative image` preview uses that one image automatically.
- `2. Detail images` matches the Master Product detail images and does not show the removed StarOne banner.
- `Weight (kg)` shows a positive value when the Master Product has `weight_g > 0`; for example `365g` shows `0.4`.

- [ ] **Step 3: Dry-run payload check**

Use browser devtools or temporary local logging during verification only. Confirm that `mrQoo10ReadPayload().publish` contains:

```js
{
  main_image: '<one selected master representative URL>',
  description: '<template plus curated detail image HTML>',
  weight_kg: 0.4
}
```

Expected: no stale StarOne banner URL and no `weight_kg: 0` for a product with positive master weight.

---

### Task 6: Full Verification, Commit, Push, Deploy

**Files:**
- No additional source files.

- [ ] **Step 1: Run all focused Qoo10 and image tests**

```bash
node scripts/test-v2-qoo10-master-content-weight.mjs
node tests/qoo10-mapping-regression.test.mjs
node scripts/test-v2-qoo10-option-price-guard.mjs
node scripts/test-v2-qoo10-registration-platform-mapping.mjs
node scripts/test-v2-marketplace-layered-image.mjs
node scripts/test-v2-shopee-layer-idempotency.mjs
node scripts/test-v2-platform-master-sync.mjs
```

Expected: PASS.

- [ ] **Step 2: Review rendered local app**

Keep `http://127.0.0.1:4173/v2/` open and repeat the CORTIS modal checks from Task 5.

- [ ] **Step 3: Commit**

```bash
git add v2/index.html supabase/functions/platform-publish/adapters/qoo10.ts supabase/functions/qoo10-bridge/index.ts tests/qoo10-mapping-regression.test.mjs scripts/test-v2-qoo10-master-content-weight.mjs
git commit -m "fix: sync Qoo10 master content and weight"
```

Include:

```text
Co-Authored-By: Codex <codex@openai.com>
```

- [ ] **Step 4: Push and deploy**

```bash
git push origin main
vercel deploy --prod --yes
```

Deploy Edge Functions if changed:

```bash
supabase functions deploy qoo10-bridge
supabase functions deploy platform-publish
```

- [ ] **Step 5: Live smoke check**

Open:

```text
https://shopee-dashboard-kohl.vercel.app/v2/
```

Verify the same CORTIS Qoo10 modal checks in production. For existing Qoo10 items, run repair on a safe target only after confirming the payload has a positive `weight_kg` and curated detail images.

## Self-Review

- Spec coverage: all three reported issues map to Tasks 2, 3, and 4, with local UI and bridge/adapter checks.
- Placeholder scan: no placeholder markers remain; every code-changing task includes exact snippets and commands.
- Type consistency: UI uses `weight_kg`, adapter forwards `weight_kg`, bridge maps it to Qoo10 `Weight`.
- Residual risk: the target product row was not visible through anon REST search during planning, so Task 5 requires an authenticated local UI check before deployment.
