const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgqlwgnmwegzsjelbrih.supabase.co';
const SUPABASE_ANON =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ncWx3Z25td2VnenNqZWxicmloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDkzNDMsImV4cCI6MjA5NDg4NTM0M30.mJtqXO7WJMBUYBYVOS1FrD5qmFX6yZxGwfiGw3HUyJE';
const WMS_SUPABASE_URL = process.env.WMS_SUPABASE_URL || 'https://bpdafetvjyvvwbksvowu.supabase.co';
const WMS_SUPABASE_ANON =
  process.env.WMS_SUPABASE_ANON ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwZGFmZXR2anl2dndia3N2b3d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODM4MjYsImV4cCI6MjA5Mjc1OTgyNn0.p9hYSOhVyLUUO8UyRJ7Av56pLgkPUAi1XCMtc6r-AZA';

const PUBLIC_HEADERS = ['Image', 'Artist', 'Release Title', 'Edition', 'Category', 'Availability', 'Retail Price', 'Supply Note'];
const INTERNAL_HEADERS = [
  'Image',
  'Artist',
  'Release Title',
  'Edition',
  'Category',
  'Availability',
  'Retail Price',
  'Supply Note',
  'Master Status',
  'WMS Status',
  'Staronemall PNO',
  'Staronemall URL',
  'Raw Title',
  'Updated At',
];
const PUBLIC_TABS = ['Catalog', 'Restock Watch', 'Inquiry Only'];
const INTERNAL_TAB = 'Internal Coverage';
const MANAGED_TABS = new Set([...PUBLIC_TABS, INTERNAL_TAB]);

function json(res, body, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw.trim()) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set.');
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key.');
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
  };
}

async function getGoogleAccessToken() {
  const account = parseServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: account.clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(account.privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const tokenBody = await tokenResp.json().catch(() => null);
  if (!tokenResp.ok || !tokenBody?.access_token) {
    throw new Error(`Google token failed: ${tokenResp.status} ${JSON.stringify(tokenBody || {})}`);
  }
  return tokenBody.access_token;
}

async function googleRequest(accessToken, path, options = {}) {
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) throw new Error(`Google Sheets ${resp.status}: ${text || resp.statusText}`);
  return body;
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  return String(header).match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

async function requireUser(req) {
  const token = bearerToken(req);
  if (!token) throw new Error('missing_bearer_token');
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) throw new Error('invalid_supabase_session');
  return { token, user: await resp.json() };
}

function supabaseHeaders(userToken) {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${userToken}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseFetch(table, query, userToken, maxRows = 10000, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (offset < maxRows) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      headers: {
        ...supabaseHeaders(userToken),
        'Range-Unit': 'items',
        Range: `${offset}-${offset + pageSize - 1}`,
        Prefer: 'count=none',
      },
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${table} ${resp.status}: ${text || resp.statusText}`);
    const page = JSON.parse(text || '[]');
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows.slice(0, maxRows);
}

async function fetchWmsInventory(artists) {
  const out = [];
  for (const artist of artists) {
    const token = String(artist || '').trim().replace(/[%*(),]/g, ' ');
    if (token.length < 2) continue;
    const params = new URLSearchParams();
    params.set('select', 'id,sku,idol,album,version,member');
    params.set('idol', `ilike.*${token}*`);
    params.set('limit', '1000');
    const resp = await fetch(`${WMS_SUPABASE_URL}/rest/v1/inventory?${params.toString()}`, {
      headers: { apikey: WMS_SUPABASE_ANON, Authorization: `Bearer ${WMS_SUPABASE_ANON}` },
    });
    if (!resp.ok) continue;
    const rows = await resp.json().catch(() => []);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
}

function pnoFromUrl(url) {
  try { return new URL(String(url || '')).searchParams.get('pno') || ''; }
  catch { return ''; }
}

function masterStatus(item, productPnos) {
  return productPnos.has(String(item.staronemall_pno || '').trim()) ? 'Linked' : 'Missing';
}

function wmsStatus(item, inventoryRows) {
  const artist = normalizeText(item.artist);
  const release = normalizeText(item.release_title);
  const edition = normalizeText(item.edition);
  const hits = (inventoryRows || []).filter((row) => {
    const idol = normalizeText(row.idol);
    const album = normalizeText(row.album);
    if (artist && idol && !idol.includes(artist) && !artist.includes(idol)) return false;
    if (release && album && !album.includes(release) && !release.includes(album)) return false;
    return true;
  });
  if (!hits.length) return 'Missing';
  if (!edition || edition === 'standard') return 'Found';
  return hits.some((row) => {
    const version = normalizeText(row.version);
    const member = normalizeText(row.member);
    return (version && (version.includes(edition) || edition.includes(version)))
      || (member && (member.includes(edition) || edition.includes(member)));
  }) ? 'Found' : 'Review';
}

function imageFormula(url) {
  const clean = String(url || '').replace(/"/g, '%22').trim();
  return clean ? `=IMAGE("${clean}")` : '';
}

function publicRow(item) {
  return [
    imageFormula(item.main_image_url),
    item.artist || '',
    item.release_title || '',
    item.edition || '',
    item.category || '',
    item.availability_status || '',
    Number(item.retail_price_krw || 0),
    item.supply_note || '',
  ];
}

function sortCatalogRows(a, b) {
  return String(a.artist || '').localeCompare(String(b.artist || ''))
    || String(a.release_title || '').localeCompare(String(b.release_title || ''))
    || String(a.edition || '').localeCompare(String(b.edition || ''));
}

function quoteRange(sheetName, cell = 'A1') {
  const safe = String(sheetName).replace(/'/g, "''");
  return `'${safe}'!${cell}`;
}

async function ensureSheets(accessToken, spreadsheetId) {
  const meta = await googleRequest(accessToken, `${spreadsheetId}?fields=sheets.properties`);
  const existing = new Map((meta.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties]));
  const requests = [];
  for (const title of [...PUBLIC_TABS, INTERNAL_TAB]) {
    if (!existing.has(title)) {
      requests.push({ addSheet: { properties: { title, hidden: title === INTERNAL_TAB } } });
    } else if (title === INTERNAL_TAB && existing.get(title).hidden !== true) {
      requests.push({ updateSheetProperties: { properties: { sheetId: existing.get(title).sheetId, hidden: true }, fields: 'hidden' } });
    } else if (title !== INTERNAL_TAB && existing.get(title).hidden === true) {
      requests.push({ updateSheetProperties: { properties: { sheetId: existing.get(title).sheetId, hidden: false }, fields: 'hidden' } });
    }
  }
  for (const [title, properties] of existing.entries()) {
    if (!MANAGED_TABS.has(title) && properties.hidden !== true) {
      requests.push({ updateSheetProperties: { properties: { sheetId: properties.sheetId, hidden: true }, fields: 'hidden' } });
    }
  }
  if (requests.length) {
    await googleRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }
}

async function replaceSheetValues(accessToken, spreadsheetId, sheetName, values) {
  const range = quoteRange(sheetName, 'A1');
  await googleRequest(accessToken, `${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await googleRequest(accessToken, `${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, { ok: false, error: 'method_not_allowed' }, 405);
  try {
    const auth = await requireUser(req);
    const spreadsheetId = process.env.CATALOG_GOOGLE_SHEET_ID || process.env.SHEETS_SPREADSHEET_ID || '';
    if (!spreadsheetId) throw new Error('CATALOG_GOOGLE_SHEET_ID or SHEETS_SPREADSHEET_ID env var is not set.');

    const [catalogRows, productRows] = await Promise.all([
      supabaseFetch(
        'catalog_items',
        '?select=id,artist,release_title,edition,category,availability_status,retail_price_krw,supply_note,main_image_url,staronemall_url,staronemall_pno,raw_title,updated_at&order=artist.asc,release_title.asc,edition.asc',
        auth.token,
        20000,
      ),
      supabaseFetch('products', '?select=id,staronemall_url&order=created_at.desc', auth.token, 50000),
    ]);

    const sorted = catalogRows.slice().sort(sortCatalogRows);
    const productPnos = new Set(productRows.map((row) => pnoFromUrl(row.staronemall_url)).filter(Boolean));
    const artists = Array.from(new Set(sorted.map((row) => row.artist).filter(Boolean)));
    const wmsRows = await fetchWmsInventory(artists);
    const coverageRows = sorted.map((item) => ({
      ...item,
      master_status: masterStatus(item, productPnos),
      wms_status: wmsStatus(item, wmsRows),
    }));

    const tabValues = {
      Catalog: [
        PUBLIC_HEADERS,
        ...coverageRows.filter((row) => row.availability_status === 'Available').map(publicRow),
      ],
      'Restock Watch': [
        PUBLIC_HEADERS,
        ...coverageRows.filter((row) => row.availability_status === 'Restock Watch').map(publicRow),
      ],
      'Inquiry Only': [
        PUBLIC_HEADERS,
        ...coverageRows.filter((row) => row.availability_status === 'Inquiry Only').map(publicRow),
      ],
      [INTERNAL_TAB]: [
        INTERNAL_HEADERS,
        ...coverageRows.map((row) => [
          imageFormula(row.main_image_url),
          row.artist || '',
          row.release_title || '',
          row.edition || '',
          row.category || '',
          row.availability_status || '',
          Number(row.retail_price_krw || 0),
          row.supply_note || '',
          row.master_status,
          row.wms_status,
          row.staronemall_pno || '',
          row.staronemall_url || '',
          row.raw_title || '',
          row.updated_at || '',
        ]),
      ],
    };

    const accessToken = await getGoogleAccessToken();
    await ensureSheets(accessToken, spreadsheetId);
    for (const sheetName of [...PUBLIC_TABS, INTERNAL_TAB]) {
      await replaceSheetValues(accessToken, spreadsheetId, sheetName, tabValues[sheetName]);
    }

    return json(res, {
      ok: true,
      spreadsheet_id: spreadsheetId,
      rows: coverageRows.length,
      visible_tabs: PUBLIC_TABS,
      hidden_tabs: [INTERNAL_TAB],
      summary: {
        available: tabValues.Catalog.length - 1,
        restock_watch: tabValues['Restock Watch'].length - 1,
        inquiry_only: tabValues['Inquiry Only'].length - 1,
        master_missing: coverageRows.filter((row) => row.master_status === 'Missing').length,
        wms_missing: coverageRows.filter((row) => row.wms_status === 'Missing').length,
        wms_review: coverageRows.filter((row) => row.wms_status === 'Review').length,
      },
    });
  } catch (error) {
    return json(res, { ok: false, error: error?.message || String(error) }, 500);
  }
};
