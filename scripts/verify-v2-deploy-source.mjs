import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outputFlagIndex = args.indexOf('--output');
const rootFlagIndex = args.indexOf('--root');
const outputRoot = outputFlagIndex >= 0 && args[outputFlagIndex + 1]
  ? args[outputFlagIndex + 1]
  : null;
const root = outputRoot || (rootFlagIndex >= 0 && args[rootFlagIndex + 1]
  ? args[rootFlagIndex + 1]
  : '.');

const requiredStaticFiles = [
  {
    path: 'v2/index.html',
    minBytes: 100_000,
    contains: 'shopee-dashboard v2',
  },
  {
    path: 'v2/price-engine.js',
    minBytes: 10_000,
    contains: 'V1 pricing engine extracted for V2',
  },
  {
    path: 'v2/shop-overlay-layer.png',
    minBytes: 10_000,
  },
];

const requiredApiFiles = [
  {
    path: 'api/v2-daily-close-summary.js',
    minBytes: 10_000,
  },
  {
    path: 'api/b2b-catalog-sheet-sync.js',
    minBytes: 5_000,
  },
];

const missing = [];

function checkFile(file, fullPath) {
  if (!fs.existsSync(fullPath)) {
    missing.push(`${file.path} is missing`);
    return;
  }

  const stat = fs.statSync(fullPath);
  if (stat.size < file.minBytes) {
    missing.push(`${file.path} is unexpectedly small (${stat.size} bytes)`);
    return;
  }

  if (file.contains) {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes(file.contains)) {
      missing.push(`${file.path} does not contain expected marker: ${file.contains}`);
    }
  }
}

if (outputRoot) {
  const staticRoot = path.resolve(root, 'static');
  for (const file of requiredStaticFiles) {
    checkFile(file, path.resolve(staticRoot, file.path));
  }

  const functionsRoot = path.resolve(root, 'functions');
  for (const file of requiredApiFiles) {
    const apiName = path.basename(file.path, '.js');
    checkFile(file, path.resolve(functionsRoot, 'api', `${apiName}.func`, 'api', `${apiName}.js`));
  }
} else {
  for (const file of [...requiredStaticFiles, ...requiredApiFiles]) {
    checkFile(file, path.resolve(root, file.path));
  }
}

if (missing.length) {
  console.error('V2 deployment guard failed:');
  for (const issue of missing) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`V2 deployment guard passed for ${path.resolve(root)}`);
