const DEFAULT_SUPABASE_URL = 'https://mgqlwgnmwegzsjelbrih.supabase.co';

function usage() {
  return `Usage:
  node scripts/shopify-clean-product-media.mjs [--dry-run] [--apply] [--limit N]

Audits and removes detached duplicate Shopify product gallery media through
shopify-bridge/cleanup-product-media.

Options:
  --dry-run              Preview only. This is the default.
  --apply                Apply Shopify media deletions.
  --limit N              Maximum Shopify products to inspect.
  --sku SKU              Restrict to one SKU.
  --product-id ID        Restrict to one Shopify Product GID/numeric ID.
  --master-product-id ID Restrict to one V2 master product UUID.
  --max-delete N         Maximum media IDs to delete per product. Defaults to 50.
  --help                 Show this help.

Environment:
  SUPABASE_URL                    Optional. Defaults to ${DEFAULT_SUPABASE_URL}
  PLATFORM_BRIDGE_INTERNAL_TOKEN  Required unless --help.`;
}

function norm(value) {
  return String(value ?? '').trim();
}

function readNext(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    limit: 25,
    maxDelete: 50,
    sku: '',
    productId: '',
    masterProductId: '',
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
    } else if (arg === '--limit') {
      args.limit = Math.max(1, Math.floor(Number(readNext(argv, i, arg)) || 25));
      i += 1;
    } else if (arg === '--max-delete') {
      args.maxDelete = Math.max(0, Math.floor(Number(readNext(argv, i, arg)) || 50));
      i += 1;
    } else if (arg === '--sku') {
      args.sku = norm(readNext(argv, i, arg));
      i += 1;
    } else if (arg === '--product-id') {
      args.productId = norm(readNext(argv, i, arg));
      i += 1;
    } else if (arg === '--master-product-id') {
      args.masterProductId = norm(readNext(argv, i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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
    max_delete_per_product: args.maxDelete,
    sku: args.sku || undefined,
    product_id: args.productId || undefined,
    master_product_id: args.masterProductId || undefined,
  };
  const response = await fetch(`${supabaseUrl}/functions/v1/shopify-bridge/cleanup-product-media`, {
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
    throw new Error(`cleanup-product-media failed HTTP ${response.status}: ${compact(json)}`);
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exitCode = 1;
});
