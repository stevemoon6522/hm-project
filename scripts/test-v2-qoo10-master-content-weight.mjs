#!/usr/bin/env node

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

function extractOptionalFunctionBlock(source, functionName, fallbackBody) {
  if (source.indexOf(`function ${functionName}(`) >= 0) return extractFunctionBlock(source, functionName);
  return `function ${functionName}() { ${fallbackBody} }`;
}

const factory = new Function(`
  const window = { location: { href: 'https://dashboard.local/v2/' } };
  function text(value) { return String(value || ''); }
  function rshNormalizeImageUrl(raw, baseUrl) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^https?:\\/\\//i.test(value)) return value;
    try {
      return new URL(value, baseUrl || window.location.href).href;
    } catch (_) {
      return '';
    }
  }
  function plIsGroupedVariant(row) {
    if (!row?.product_group_id) return false;
    const optionNames = Array.isArray(row.variation_option_names)
      ? row.variation_option_names.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const tierNames = Array.isArray(row.variation_tier_names)
      ? row.variation_tier_names.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    return tierNames.length > 0
      || optionNames.length > 0
      || !!row.global_model_id
      || !!String(row.option_name || '').trim()
      || !!String(row.shopee_global_model_sku || '').trim();
  }
  function mrQoo10OptionValue(row) {
    return row?.option_name || row?.sku || 'Default';
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
  ${extractFunctionBlock(html, 'mrQoo10LooksLikeOptionRow')}
  ${extractFunctionBlock(html, 'mrQoo10RootImageRows')}
  ${extractFunctionBlock(html, 'mrQoo10NormalizeImageUrl')}
  ${extractFunctionBlock(html, 'mrQoo10ImageRefKey')}
  ${extractFunctionBlock(html, 'mrQoo10AddImageRef')}
  ${extractFunctionBlock(html, 'mrQoo10RepresentativeImageRef')}
  ${extractFunctionBlock(html, 'mrQoo10ImageCandidates')}
  ${extractFunctionBlock(html, 'mrQoo10MainImageSource')}
  ${extractFunctionBlock(html, 'mrQoo10SelectedMainImageUrl')}
  ${extractFunctionBlock(html, 'mrQoo10DetailImageUrls')}
  ${extractOptionalFunctionBlock(html, 'mrQoo10WeightKgFromRows', "throw new Error('mrQoo10WeightKgFromRows must exist');")}
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

const cortisRows = [
  {
    id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS',
    weight_g: 365,
    main_image: 'https://cdn.example.com/master-representative.jpg',
    extra_images: [
      'https://cdn.example.com/master-representative.jpg',
      'https://cdn.example.com/detail-clean.jpg',
      'https://cdn.example.com/starone-banner.jpg',
    ],
    staronemall_url: 'https://staronemall.example/item',
  },
  {
    id: 'option-a',
    product_group_id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS-A',
    main_image: 'https://cdn.example.com/option-a-layered.jpg',
    _main_image: 'https://cdn.example.com/source-option-a.jpg',
    extra_images: ['https://cdn.example.com/option-stale-detail.jpg'],
  },
  {
    id: 'option-b',
    product_group_id: 'master',
    sku: 'RS-CORTIS-GREENGREEN-BLUELIPS-B',
    weight_g: 0,
    main_image: 'https://cdn.example.com/option-b-layered.jpg',
    _main_image: 'https://cdn.example.com/source-option-b.jpg',
    extra_images: [],
  },
];
state.allRows = cortisRows;
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

state.selectedMainImageUrl = '';
state.allRows = [
  {
    id: 'root',
    main_image: 'https://cdn.example.com/root-master.jpg',
    extra_images: [],
  },
  {
    id: 'variant-not-recognized-by-pl',
    product_group_id: 'root',
    variation_tier_index: 0,
    main_image: 'https://cdn.example.com/variant-layered.jpg',
    extra_images: [],
  },
];
state.rows = state.allRows.slice(1);
assert.equal(
  mrQoo10ImageCandidates(state.rows)[0].src,
  'https://cdn.example.com/root-master.jpg',
  'Qoo10 representative image must prefer explicit root rows even when plIsGroupedVariant misses an option row',
);

state.selectedMainImageUrl = '';
state.allRows = [
  { id: 'master-no-image', extra_images: [] },
  {
    id: 'variant-with-source-url',
    product_group_id: 'master-no-image',
    variation_tier_index: 0,
    staronemall_url: 'https://staronemall.example/product/page',
    extra_images: [],
  },
];
state.rows = state.allRows.slice(1);
state.mainImages = ['/relative-main.jpg'];
assert.equal(
  mrQoo10ImageCandidates(state.rows)[0].src,
  'https://staronemall.example/relative-main.jpg',
  'Qoo10 fallback source images must use a row with staronemall_url when available',
);

state.selectedMainImageUrl = '';
state.allRows = [];
state.rows = [];
state.mainImages = [];
assert.deepEqual(mrQoo10ImageCandidates([]), [], 'Qoo10 representative candidates should be empty without source rows or crawler main images');

state.selectedMainImageUrl = '';
state.allRows = [
  {
    id: 'option-only',
    product_group_id: 'missing-root',
    variation_tier_index: 0,
    staronemall_url: 'https://staronemall.example/option-only-page',
    main_image: 'https://cdn.example.com/option-only-main.jpg',
    extra_images: ['https://cdn.example.com/option-only-detail.jpg'],
  },
];
state.rows = state.allRows;
state.mainImages = ['/option-only-crawler-main.jpg'];
assert.deepEqual(
  mrQoo10ImageCandidates(state.rows),
  [],
  'Qoo10 representative image must not auto-select an option row or crawler main image when the master/root row is missing',
);
assert.deepEqual(
  mrQoo10DetailImageUrls(state.rows),
  [],
  'Qoo10 detail images must not use option-row extra_images when the master/root row is missing',
);

state.selectedMainImageUrl = 'https://cdn.example.com/manual-cover.jpg';
assert.equal(
  mrQoo10SelectedMainImageUrl([]),
  'https://cdn.example.com/manual-cover.jpg',
  'Qoo10 selected representative image should preserve manual URL selection',
);

state.allRows = [];
state.rows = [];
assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 365 }, { weight_g: 120 }]), 0.4);
assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 0 }, { weight_g: 80 }]), 0.1);
assert.equal(mrQoo10WeightKgFromRows([{ weight_g: 0 }]), 0);
state.allRows = cortisRows;
state.rows = state.allRows.slice(1);
assert.equal(
  mrQoo10WeightKgFromRows(state.rows),
  0.4,
  'Qoo10 modal weight must resolve from the master row in _mrQoo10.allRows when option rows have no positive weight',
);

console.log('v2 Qoo10 master content and weight checks passed');
