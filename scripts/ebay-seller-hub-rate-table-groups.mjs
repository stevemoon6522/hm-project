export const EBAY_SELLER_HUB_RATE_TABLE_GROUPS = Object.freeze([
  {
    costUsd: 0,
    entries: [
      { region: 'Asia', countryCodes: ['JP'] },
      { region: 'Middle East', countryCodes: ['AE'] },
      { region: 'Oceania', countryCodes: ['AU', 'NZ'] },
      { region: 'Southeast Asia', countryCodes: ['HK', 'MO', 'SG'] },
    ],
  },
  {
    costUsd: 3.99,
    entries: [
      { region: 'Europe (including UK)', countryCodes: ['BG', 'FR', 'DE', 'IT', 'NL', 'ES', 'GB'] },
    ],
  },
  {
    costUsd: 4.99,
    entries: [
      { region: 'North America', countryCodes: ['CA'] },
    ],
  },
  {
    costUsd: 7.99,
    entries: [
      { region: 'Middle East', countryCodes: ['IL'] },
    ],
  },
  {
    costUsd: 8.99,
    entries: [
      { region: 'Europe (including UK)', countryCodes: ['HR', 'DK', 'GR', 'LT', 'PL', 'RO', 'SI', 'SE'] },
    ],
  },
  {
    costUsd: 9.99,
    entries: [
      { region: 'Middle East', countryCodes: ['SA'] },
      { region: 'South America', countryCodes: ['CL'] },
    ],
  },
  {
    costUsd: 11.99,
    entries: [
      { region: 'Europe (including UK)', countryCodes: ['AT', 'BE', 'CZ', 'EE', 'FI', 'HU', 'IE', 'LV', 'LU', 'NO', 'PT'] },
    ],
  },
  {
    costUsd: 13.99,
    entries: [
      { region: 'Europe (including UK)', countryCodes: ['SK', 'CH'] },
    ],
  },
  {
    costUsd: 14.99,
    entries: [
      { region: 'South America', countryCodes: ['BR', 'CO'] },
    ],
  },
  {
    costUsd: 17.99,
    entries: [
      { region: 'North America', countryCodes: ['MX'] },
    ],
  },
  {
    costUsd: 18.99,
    entries: [
      { region: 'Europe (including UK)', countryCodes: ['CY', 'MT'] },
    ],
  },
]);

export const EBAY_SELLER_HUB_COUNTRY_NAMES = Object.freeze({
  AE: 'United Arab Emirates',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BG: 'Bulgaria',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CO: 'Colombia',
  CY: 'Cyprus',
  CZ: 'Czech Republic',
  DE: 'Germany',
  DK: 'Denmark',
  EE: 'Estonia',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GR: 'Greece',
  HK: 'Hong Kong',
  HR: 'Croatia',
  HU: 'Hungary',
  IE: 'Ireland',
  IL: 'Israel',
  IT: 'Italy',
  JP: 'Japan',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  LV: 'Latvia',
  MO: 'Macau',
  MT: 'Malta',
  MX: 'Mexico',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SA: 'Saudi Arabia',
  SE: 'Sweden',
  SG: 'Singapore',
  SI: 'Slovenia',
  SK: 'Slovakia',
});

function namesForCodes(countryCodes) {
  return countryCodes.map((code) => {
    const name = EBAY_SELLER_HUB_COUNTRY_NAMES[code];
    if (!name) throw new Error(`Missing eBay Seller Hub country name for ${code}`);
    return name;
  });
}

export function formatUsd(value) {
  return `$${Number(value).toFixed(2)}`;
}

export function buildSellerHubRateTableRows() {
  return EBAY_SELLER_HUB_RATE_TABLE_GROUPS.map((group) => {
    const entries = group.entries.map((entry) => ({
      region: entry.region,
      countryCodes: [...entry.countryCodes],
      countryNames: namesForCodes(entry.countryCodes),
      sellerHubText: `${entry.region} - ${namesForCodes(entry.countryCodes).join(', ')}`,
    }));
    return {
      costUsd: group.costUsd,
      costDisplay: formatUsd(group.costUsd),
      countryCodes: entries.flatMap((entry) => entry.countryCodes),
      entries,
      sellerHubText: entries.map((entry) => entry.sellerHubText).join('\n'),
    };
  });
}

export function formatSellerHubMarkdownTable(rows = buildSellerHubRateTableRows()) {
  const lines = [
    '# eBay Seller Hub Shipping Rate Table',
    '',
    'Approved on 2026-07-01. Europe rows were lifted by at least USD 3.40 from the previous Seller Hub table; non-Europe rows remain unchanged.',
    '',
    '| Cost | Seller Hub regions |',
    '|---:|---|',
  ];
  for (const row of rows) {
    lines.push(`| ${row.costDisplay} | ${row.sellerHubText.replaceAll('\n', '<br>')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}
