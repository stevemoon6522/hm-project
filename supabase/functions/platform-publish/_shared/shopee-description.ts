// Shared Shopee Seller Center description template.

export function shopeePlainText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/🟣/gu, '[Product]')
    .replace(/💿/gu, '[Official Album]')
    .replace(/📊/gu, '[Chart Certified]')
    .replace(/📦/gu, '[Shipping]')
    .replace(/📌/gu, '[Contents]')
    .replace(/⚠️?/gu, '[Important Notice]')
    .replace(/💳/gu, '[COD Policy]')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/\uFE0F/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shopeeComponentsBlock(components: unknown): string {
  const lines = shopeePlainText(components)
    .split('\n')
    .map((line) => line.replace(/^[\s\-*•◈◆]+/, '').trim())
    .filter(Boolean);
  return lines.map((line) => `- ${line}`).join('\n');
}

export function shopeeSellerCenterDescription(productName: string, lifecycleState: string, components: unknown): string {
  const title = String(productName || '').trim();
  const componentBlock = shopeeComponentsBlock(components) || '- Album package contents vary by version.';
  const preOrderNotice = lifecycleState === 'pre_order'
    ? `\n[Pre-Order Notice]\n\n- This is a pre-order item. Estimated shipping window: per artist's announcement.\n\n- Items will be shipped sequentially after the official release date.\n\n- Pre-order may take 2-8 weeks depending on supply.\n`
    : '';
  return `[Product] ${title}

[Official & Authentic K-POP Album]

- Brand new, sealed, and sourced directly from the official distributor

[Chart Certified]

- This album counts toward Hanteo and Circle (Gaon) charts

- Your purchase directly supports the artist's chart performance
${preOrderNotice}
[Fast & Secure Shipping]

- Ships from Korea with tracking

- Safely packed with bubble wrap and a sturdy box

- Items labeled [READY STOCK], [ON HAND], or [FAST DELIVERY] are dispatched within 1 business day

[Contents]

${componentBlock}

[Important Notice]

- The outer box is for protection and may have minor dents, scratches, or creases.

- The outer vinyl wrap may have slight tears or marks due to shipping.

- These are not considered defects and are not grounds for return or refund.

- Please purchase only if you agree to the above conditions.

[COD Policy]

Cash on Delivery (COD) is available only for buyers with: 10 or more completed ratings or Perfect 5.0 rating score`.trim();
}
