const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '3600',
};

const ALLOWED_TARGET_HOSTS = new Set([
  'mgqlwgnmwegzsjelbrih.supabase.co',
]);

const ALLOWED_TARGET_PATH = '/functions/v1/shopee-bridge/oauth_callback';
const FORWARDED_QUERY_KEYS = [
  'code',
  'shop_id',
  'main_account_id',
  'region',
  'error',
  'message',
  'request_id',
];

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function parseAllowedTarget(raw: string | null) {
  if (!raw) return { ok: false as const, error: 'target_required' };
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false as const, error: 'target_invalid' };
  }
  if (target.protocol !== 'https:') return { ok: false as const, error: 'target_protocol_not_allowed' };
  if (!ALLOWED_TARGET_HOSTS.has(target.host)) return { ok: false as const, error: 'target_host_not_allowed' };
  if (target.pathname !== ALLOWED_TARGET_PATH) return { ok: false as const, error: 'target_path_not_allowed' };
  return { ok: true as const, target };
}

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return jsonResp({ ok: false, error: 'method_not_allowed' }, 405);

  const url = new URL(req.url);
  const parsed = parseAllowedTarget(url.searchParams.get('target'));
  if (!parsed.ok) return jsonResp({ ok: false, error: parsed.error }, 400);

  const { target } = parsed;
  for (const key of FORWARDED_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  if (!target.searchParams.get('code') && !target.searchParams.get('error')) {
    return jsonResp({ ok: false, error: 'oauth_code_or_error_required' }, 400);
  }

  return new Response(null, {
    status: 302,
    headers: {
      ...CORS,
      Location: target.toString(),
      'Cache-Control': 'no-store',
    },
  });
});
