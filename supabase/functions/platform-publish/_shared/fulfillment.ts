// @ts-nocheck
// Lifecycle-driven fulfillment defaults for marketplace publish payloads.

export const READY_STOCK_SHOPEE_DTS = Object.freeze({
  SG: 2,
  TW: 1,
  TH: 2,
  MY: 2,
  PH: 2,
  BR: 3,
});

export const PRE_ORDER_SHOPEE_DTS = 60;

export const EBAY_READY_STOCK_FULFILLMENT_POLICY_ID = '233825118025';
export const EBAY_READY_STOCK_FULFILLMENT_POLICY_NAME = 'READY STOCK';
export const EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID = '253030471025';
export const EBAY_PRE_ORDER_FULFILLMENT_POLICY_NAME = 'ALBUM PRE-ORDER';

export const QOO10_READY_STOCK_AVAILABLE_DATE_TYPE = '0';
export const QOO10_READY_STOCK_AVAILABLE_DATE_VALUE = '3';
export const QOO10_PRE_ORDER_AVAILABLE_DATE_TYPE = '2';

export function normalizeLifecycleState(value: unknown, fallback = 'ready_stock'): 'ready_stock' | 'pre_order' {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'pre_order' || normalized === 'preorder') return 'pre_order';
  if (normalized === 'ready_stock' || normalized === 'ready' || normalized === 'in_stock' || normalized === 'on_hand') return 'ready_stock';
  return fallback === 'pre_order' ? 'pre_order' : 'ready_stock';
}

export function resolveShopeeDaysToShip(lifecycleState: unknown, region: unknown): number {
  const lifecycle = normalizeLifecycleState(lifecycleState);
  if (lifecycle === 'pre_order') return PRE_ORDER_SHOPEE_DTS;
  const regionCode = String(region || '').trim().toUpperCase();
  return READY_STOCK_SHOPEE_DTS[regionCode] || 2;
}

export function resolveQoo10AvailableDate(lifecycleState: unknown, releaseDate: unknown = ''): {
  type: string;
  value: string;
  requires_release_date: boolean;
} {
  const lifecycle = normalizeLifecycleState(lifecycleState);
  if (lifecycle !== 'pre_order') {
    return {
      type: QOO10_READY_STOCK_AVAILABLE_DATE_TYPE,
      value: QOO10_READY_STOCK_AVAILABLE_DATE_VALUE,
      requires_release_date: false,
    };
  }

  return {
    type: QOO10_PRE_ORDER_AVAILABLE_DATE_TYPE,
    value: String(releaseDate || '').trim().replace(/\//g, '-'),
    requires_release_date: true,
  };
}

export function resolveEbayFulfillmentPolicy(lifecycleState: unknown): {
  lifecycleState: 'ready_stock' | 'pre_order';
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
} {
  const lifecycle = normalizeLifecycleState(lifecycleState);
  if (lifecycle === 'ready_stock') {
    return {
      lifecycleState: 'ready_stock',
      fulfillmentPolicyId: EBAY_READY_STOCK_FULFILLMENT_POLICY_ID,
      fulfillmentPolicyName: EBAY_READY_STOCK_FULFILLMENT_POLICY_NAME,
    };
  }
  return {
    lifecycleState: 'pre_order',
    fulfillmentPolicyId: EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID,
    fulfillmentPolicyName: EBAY_PRE_ORDER_FULFILLMENT_POLICY_NAME,
  };
}
