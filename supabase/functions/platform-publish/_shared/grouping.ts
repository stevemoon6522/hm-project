// @ts-nocheck
// Shared helpers for grouped master products in platform-publish adapters.

export type ProductRow = Record<string, any>;

export function text(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanOption(value: unknown): string {
  return text(value).replace(/^\[[^\]]+\]\s*/g, '').slice(0, 50).trim();
}

function normalizeKpopTitleToken(value: unknown): string {
  return text(value)
    .replace(/[^\x00-\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '');
}

function isKpopListingStatusTag(value: unknown): boolean {
  return /^(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)$/i.test(text(value));
}

function stripKpopListingStatusPrefix(value: unknown): string {
  let out = text(value);
  for (let i = 0; i < 5; i += 1) {
    const next = out
      .replace(/^\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/i, '')
      .replace(/^\s*(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\s*[-:]\s*/i, '')
      .trim();
    if (next === out) break;
    out = next;
  }
  return normalizeKpopTitleToken(out);
}

function looksLikeKpopVersionBracket(value: unknown): boolean {
  const normalized = normalizeKpopTitleToken(value);
  return /\bVER(?:SION)?\.?\b/i.test(normalized) || /\s\/\s/.test(normalized);
}

function firstMeaningfulKpopAlbumBracketValue(title: string): string {
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) {
    const value = normalizeKpopTitleToken(m[1]);
    if (!value || isKpopListingStatusTag(value) || looksLikeKpopVersionBracket(value)) continue;
    return value;
  }
  return '';
}

function fallbackKpopAlbumFromDashRemainder(value: string): string {
  return normalizeKpopTitleToken(
    text(value).replace(/\[[^\]]*(?:\bVER(?:SION)?\.?\b|\/)[^\]]*\]/gi, ' '),
  )
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:\d+(?:st|nd|rd|th)?\s+)?(?:EP|ALBUM|MINI|FULL|SINGLE)\b.*$/i, ' ')
    .replace(/\b(?:WEVERSE|PLATFORM|PHOTOBOOK|DIGIPACK|JEWEL|STANDARD)\s+VER\.?.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leadingUppercaseTokenBlock(value: string): string {
  const tokens = text(value).split(/\s+/);
  const artistTokens: string[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&]+$/g, '');
    if (!cleaned) continue;
    if (!/^[A-Z0-9&]+$/.test(cleaned) || !/[A-Z]/.test(cleaned)) break;
    artistTokens.push(cleaned);
  }
  return artistTokens.join(' ');
}

export function deriveKpopFromTitle(value: unknown): { artist: string; album: string; version: string } {
  const out = { artist: '', album: '', version: '' };
  const eng = stripKpopListingStatusPrefix(value);
  if (!eng) return out;

  // Handles parenthesized dash-prefix artists, e.g. "(ILLIT) - NOT CUTE ANYMORE".
  const dashM = eng.match(/^(.+?)\s+-\s+(.+)$/);
  let remainder = eng;
  if (dashM) {
    const artistRaw = dashM[1].trim();
    const parenthesizedArtist = artistRaw.match(/^\(([^()]+)\)$/);
    const artistSource = parenthesizedArtist ? parenthesizedArtist[1] : artistRaw.replace(/\([^)]*\)\s*$/, '');
    const artist = normalizeKpopTitleToken(artistSource);
    if (artist) out.artist = artist;
    remainder = stripKpopListingStatusPrefix(dashM[2]);
  } else {
    out.artist = leadingUppercaseTokenBlock(eng);
  }

  out.album = firstMeaningfulKpopAlbumBracketValue(remainder)
    || firstMeaningfulKpopAlbumBracketValue(eng)
    || (dashM ? fallbackKpopAlbumFromDashRemainder(remainder) : '');

  const verM = eng.match(/\(([^)]+?)\s+[Vv][Ee][Rr]\.?\s*\)/);
  if (verM) out.version = normalizeKpopTitleToken(verM[1]);
  if (!out.version) {
    const parenRe = /\(([^)]+)\)/g;
    const candidates: string[] = [];
    let parenM: RegExpExecArray | null;
    while ((parenM = parenRe.exec(eng))) {
      const candidate = normalizeKpopTitleToken(parenM[1]);
      if (!candidate || isKpopListingStatusTag(candidate)) continue;
      if (out.artist && candidate.toUpperCase() === out.artist.toUpperCase()) continue;
      candidates.push(candidate.replace(/\s+[Vv][Ee][Rr]\.?$/i, '').trim());
    }
    out.version = candidates.filter(Boolean).pop() || '';
  }
  return out;
}

function lifecycleOf(row: ProductRow = {}, fallback: ProductRow = {}): string {
  const raw = text(row.lifecycle_state || fallback.lifecycle_state).toLowerCase();
  return raw === 'pre_order' ? 'pre_order' : 'ready_stock';
}

export function isGroupedVariant(row: ProductRow = {}): boolean {
  if (!row.product_group_id) return false;
  const optionNames = Array.isArray(row.variation_option_names)
    ? row.variation_option_names.map((v: unknown) => text(v)).filter(Boolean)
    : [];
  const tierNames = Array.isArray(row.variation_tier_names)
    ? row.variation_tier_names.map((v: unknown) => text(v)).filter(Boolean)
    : [];
  return tierNames.length > 0
    || optionNames.length > 0
    || !!text(row.global_model_id)
    || !!text(row.option_name)
    || !!text(row.shopee_global_model_sku);
}

function axisValue(row: ProductRow, axisIndex: number): string {
  const names = Array.isArray(row.variation_option_names) ? row.variation_option_names : [];
  const raw = axisIndex < names.length ? names[axisIndex] : (axisIndex === 0 ? row.option_name : '');
  return cleanOption(raw);
}

function tierSortKey(row: ProductRow): string {
  if (Array.isArray(row.variation_tier_index) && row.variation_tier_index.length) {
    return row.variation_tier_index
      .map((n: unknown) => String(Number.isFinite(Number(n)) ? Number(n) : 999).padStart(4, '0'))
      .join('.');
  }
  const options = Array.isArray(row.variation_option_names) ? row.variation_option_names : [];
  return [options.join(' / '), row.option_name, row.sku].map(text).join('|').toLowerCase();
}

export function sortGroupRows(rows: ProductRow[] = []): ProductRow[] {
  return rows.slice().sort((a, b) => (
    Number(rowIsSetOption(a)) - Number(rowIsSetOption(b))
    || tierSortKey(a).localeCompare(tierSortKey(b))
  ));
}

export function parentSku(rows: ProductRow[] = []): string {
  const skus = rows.map((row) => text(row.sku)).filter(Boolean);
  if (!skus.length) return '';
  let prefix = skus[0];
  for (let i = 1; i < skus.length; i += 1) {
    while (prefix && !skus[i].startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return (prefix || skus[0]).replace(/[-_]+$/, '');
}

function rowHasPublishableStock(row: ProductRow, master: ProductRow): boolean {
  if (lifecycleOf(row, master) === 'pre_order') return true;
  const inventory = Number(row.inventory ?? 0);
  return Number.isFinite(inventory) && inventory > 0;
}

function optionValueIsSet(value: unknown): boolean {
  return /(^|[^A-Z0-9])(?:FULL\s*)?SET(?:\s*VER(?:SION)?\.?)?([^A-Z0-9]|$)/.test(text(value).toUpperCase());
}

function sortOptionValuesSetLast(values: string[]): string[] {
  return values.slice().sort((a, b) => Number(optionValueIsSet(a)) - Number(optionValueIsSet(b)));
}

function rowIsSetOption(row: ProductRow): boolean {
  const optionNames = Array.isArray(row.variation_option_names) ? row.variation_option_names : [];
  const haystack = [row.option_name, row.sku, ...optionNames].map(text).join(' ').toUpperCase();
  return optionValueIsSet(haystack);
}

export function publishableGroupRows(master: ProductRow = {}, groupProducts: ProductRow[] = []): ProductRow[] {
  const groupId = text(master.product_group_id);
  if (!groupId || !Array.isArray(groupProducts) || groupProducts.length < 2) return [];
  const candidates = sortGroupRows(groupProducts.filter((row) => (
    text(row?.product_group_id) === groupId && isGroupedVariant(row)
  )));
  if (candidates.length < 2) return [];
  const publishable = candidates.filter((row) => rowHasPublishableStock(row, master) || rowIsSetOption(row));
  return publishable.length >= 2 ? publishable : candidates;
}

function masterEditAxisSignature(row: ProductRow, axes: any[]): string {
  return axes.map((axis) => axisValue(row, axis.sourceAxis).toLowerCase()).join('\u001f');
}

function axisIsRedundant(rows: ProductRow[], keptAxes: any[], axis: any): boolean {
  if (!keptAxes.length || axis.values.length <= 1) return false;
  const valueBySignature = new Map();
  const signatureByValue = new Map();
  for (const row of rows) {
    const signature = masterEditAxisSignature(row, keptAxes);
    const value = axisValue(row, axis.sourceAxis).toLowerCase();
    if (!signature || !value) return false;
    const existingValue = valueBySignature.get(signature);
    if (existingValue && existingValue !== value) return false;
    valueBySignature.set(signature, value);
    const existingSignature = signatureByValue.get(value);
    if (existingSignature && existingSignature !== signature) return false;
    signatureByValue.set(value, signature);
  }
  return signatureByValue.size === axis.values.length;
}

export function effectiveVariationSpec(rows: ProductRow[] = [], defaultTierName = 'Version') {
  const sourceRows = rows.filter(Boolean);
  const emptySpec = {
    axes: [],
    tierNames: [],
    twoAxis: false,
    optionNamesForRow: () => [],
  };
  if (!sourceRows.length) return emptySpec;

  const storedTierNames = (sourceRows.find((row) => Array.isArray(row?.variation_tier_names) && row.variation_tier_names.length)?.variation_tier_names || [])
    .map((v: unknown) => cleanOption(v))
    .filter(Boolean);
  const maxOptionAxes = sourceRows.reduce((max, row) => {
    const optionLen = Array.isArray(row?.variation_option_names) ? row.variation_option_names.filter((v: unknown) => text(v)).length : 0;
    const indexLen = Array.isArray(row?.variation_tier_index) ? row.variation_tier_index.length : 0;
    return Math.max(max, optionLen, indexLen);
  }, 0);
  const rawAxisCount = Math.max(1, storedTierNames.length, maxOptionAxes);
  const rawAxes = Array.from({ length: rawAxisCount }, (_, axisIndex) => {
    const values: string[] = [];
    const keys = new Set<string>();
    sourceRows.forEach((row) => {
      const value = axisValue(row, axisIndex);
      const key = value.toLowerCase();
      if (!value || keys.has(key)) return;
      keys.add(key);
      values.push(value);
    });
    return {
      sourceAxis: axisIndex,
      name: (storedTierNames[axisIndex] || (axisIndex === 0 ? defaultTierName : `Option ${axisIndex + 1}`)).slice(0, 14),
      values: sortOptionValuesSetLast(values),
    };
  }).filter((axis) => axis.values.length > 0);
  if (!rawAxes.length) return emptySpec;

  const multiAxes = rawAxes.filter((axis) => axis.values.length > 1);
  const candidateAxes = multiAxes.length ? multiAxes : rawAxes.slice(0, 1);
  const effectiveAxes: any[] = [];
  for (const axis of candidateAxes) {
    if (axisIsRedundant(sourceRows, effectiveAxes, axis)) continue;
    effectiveAxes.push(axis);
    if (effectiveAxes.length >= 2) break;
  }
  if (!effectiveAxes.length) effectiveAxes.push(rawAxes[0]);

  const optionNamesForRow = (row: ProductRow, rowIndex = 0) => effectiveAxes.map((axis) => {
    const value = axisValue(row, axis.sourceAxis).toLowerCase();
    const idx = axis.values.findIndex((candidate: string) => candidate.toLowerCase() === value);
    if (idx >= 0) return axis.values[idx];
    const stored = Array.isArray(row?.variation_tier_index) ? Number(row.variation_tier_index[axis.sourceAxis]) : NaN;
    if (Number.isInteger(stored) && stored >= 0 && stored < axis.values.length) return axis.values[stored];
    return axis.values[Math.min(Math.max(Number(rowIndex) || 0, 0), axis.values.length - 1)] || '';
  }).filter(Boolean);

  return {
    axes: effectiveAxes,
    tierNames: effectiveAxes.map((axis) => axis.name || defaultTierName),
    twoAxis: effectiveAxes.length > 1,
    optionNamesForRow,
  };
}

export function buildVariationItems(rows: ProductRow[] = [], defaultTierName = 'Version') {
  const sortedRows = sortGroupRows(rows);
  const spec = effectiveVariationSpec(sortedRows, defaultTierName);
  const items = sortedRows.map((row, rowIndex) => {
    const optionNames = spec.optionNamesForRow(row, rowIndex);
    const optionValue = optionNames.join(' / ') || cleanOption(row.option_name) || text(row.sku) || `Option ${rowIndex + 1}`;
    const tierIndex = spec.axes.map((axis: any) => {
      const value = optionNames[spec.axes.indexOf(axis)] || '';
      const idx = axis.values.findIndex((candidate: string) => candidate.toLowerCase() === value.toLowerCase());
      return Math.max(0, idx);
    });
    return { row, rowIndex, optionNames, optionValue, tierIndex };
  });
  return { rows: sortedRows, spec, items, parentSku: parentSku(sortedRows) };
}

export function inferKpopArtistName(master: ProductRow = {}): string {
  const existing = text(master.artist || master.ebay_artist || master.record_label);
  if (existing && !/^no brand$/i.test(existing)) return existing;
  const haystack = `${master.product_name || ''} ${master.sku || ''}`.toUpperCase();
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

export function inferKpopBrandName(master: ProductRow = {}): string {
  const existing = text(master.brand || master.joom_brand_name || master.qoo10_brand_name || master.shopee_brand_name);
  if (existing && !/^no brand$/i.test(existing)) return existing;
  const haystack = `${master.product_name || ''} ${master.sku || ''}`.toUpperCase();
  if (/\b(BOYNEXTDOOR|BTS|TXT|TOMORROW X TOGETHER|ENHYPEN|LE SSERAFIM|NEWJEANS|SEVENTEEN|ILLIT)\b/.test(haystack)) {
    return 'Hybe Labels';
  }
  return existing && !/^no brand$/i.test(existing) ? existing : '';
}
