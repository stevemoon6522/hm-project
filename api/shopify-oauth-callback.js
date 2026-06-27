const SHOPIFY_BRIDGE_CALLBACK =
  process.env.SHOPIFY_BRIDGE_CALLBACK_URL ||
  'https://mgqlwgnmwegzsjelbrih.supabase.co/functions/v1/shopify-bridge/oauth-callback';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const incoming = new URL(req.url || '', 'https://shopee-dashboard-kohl.vercel.app');
  const target = new URL(SHOPIFY_BRIDGE_CALLBACK);
  target.search = incoming.search;

  const upstream = await fetch(target.toString(), {
    method: req.method,
    headers: { accept: req.headers.accept || 'application/json' },
  });
  const body = await upstream.text();
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  res.send(body);
}
