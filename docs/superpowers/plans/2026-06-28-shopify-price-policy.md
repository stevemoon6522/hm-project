# Shopify Price Policy

Date: 2026-06-28

## Operator Inputs

- Selling currency: USD
- KRW/USD exchange rate: 1460
- Target margin: 30%
- Shopify payment fee: 1%
- Shopify transaction fee: 10%
- Fixed packing/operation fee: 0%
- Shipping included in product price: no
- Initial product status: active
- Shopify inventory push: no

## Current Implementation

Shopify variant price is calculated from `cost_krw` as:

```text
price_usd = cost_krw / 1460 / (1 - (30 + 1 + 10 + 0) / 100)
```

The result is rounded up to the next cent to avoid underpricing.

Products are created with `status: ACTIVE`. Inventory push remains disabled even if a caller sends `set_inventory=true`.

## Shipping Note

Shipping is intentionally excluded from the Shopify product price. Weight-based shipping should be handled by a Shopify shipping-rate flow, not by inflating product price.
