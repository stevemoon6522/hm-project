const DEFAULT_SUPABASE_URL = 'https://mgqlwgnmwegzsjelbrih.supabase.co';

function usage() {
  return `Usage:
  node scripts/shopify-repair-existing-products.mjs [--dry-run] [--apply] [--limit N]

Repairs existing V2 Shopify products through shopify-bridge/repair-existing-products.

Options:
  --dry-run             Preview only. This is the default.
  --apply               Apply Shopify mutations.
  --limit N             Maximum Shopify products to inspect.
  --sku SKU             Restrict to one SKU.
  --product-id ID       Restrict to one Shopify Product GID/numeric ID.
  --master-product-id ID Restrict to one V2 master product UUID.
  --description-only    Update descriptions only.
  --images-only         Repair option images only.
  --help                Show this help.

Environment:
  SUPABASE_URL                    Optional. Defaults to ${DEFAULT_SUPABASE_URL}
  PLATFORM_BRIDGE_INTERNAL_TOKEN  Required unless --help.`;
}

function norm(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    limit: 25,
    sku: '',
    productId: '',
    masterProductId: '',
    includeDescription: true,
    includeImages: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
    } else if (arg === '--limit') args.limit = Math.max(1, Math.floor(Number(argv[++i]) || 25));
    else if (arg === '--sku') args.sku = norm(argv[++i]);
    else if (arg === '--product-id') args.productId = norm(argv[++i]);
    else if (arg === '--master-product-id') args.masterProductId = norm(argv[++i]);
    else if (arg === '--description-only') args.includeImages = false;
    else if (arg === '--images-only') args.includeDescription = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.includeDescription && !args.includeImages) {
    throw new Error('--description-only and --images-only cannot be used together');
  }
  return args;
}

function compact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const token = norm(process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN);
  if (!token) throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN is required unless --help is used');
  const supabaseUrl = norm(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const body = {
    dry_run: args.dryRun,
    apply: args.apply,
    limit: args.limit,
    sku: args.sku || undefined,
    product_id: args.productId || undefined,
    master_product_id: args.masterProductId || undefined,
    include_description: args.includeDescription,
    include_option_images: args.includeImages,
  };
  const response = await fetch(`${supabaseUrl}/functions/v1/shopify-bridge/repair-existing-products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-platform-bridge-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw_text: text };
  }
  console.log(JSON.stringify(json));
  if (!response.ok || json?.ok === false) {
    throw new Error(`repair-existing-products failed HTTP ${response.status}: ${compact(json)}`);
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exitCode = 1;
});
