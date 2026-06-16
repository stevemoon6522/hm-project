export function isStaronemallBannerImageUrl(url: string): boolean {
  const raw = String(url || "").trim();
  if (!raw) return false;

  let haystack = raw.toLowerCase();
  try {
    const parsed = new URL(raw, "https://www.staronemall.com");
    haystack = decodeURIComponent(`${parsed.hostname}${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    try {
      haystack = decodeURIComponent(raw).toLowerCase();
    } catch {
      haystack = raw.toLowerCase();
    }
  }

  return [
    /(?:^|[\/_.-])banner(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])bnr(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])event(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])notice(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])guide(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])common(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])footer(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])top(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])bottom(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])delivery(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])shipping(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])exchange(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])refund(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])return(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])cs(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])blank(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])spacer(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])transparent(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])pixel(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])empty(?:[\/_.-]|$)/,
  ].some((re) => re.test(haystack));
}

export function filterStaronemallDetailImageUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls || []) {
    const value = String(url || "").trim();
    if (!value || seen.has(value) || isStaronemallBannerImageUrl(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
