// @ts-nocheck
// platform-publish dispatcher — shared TypeScript contracts.
//
// Plan ref: platform-publish-dispatcher-plan.md v2 §B (adapter interface),
// §B.1 (frozen error_code enum), §B.2 (capability matrix).
//
// These types are the single source of truth for both the dispatcher
// (index.ts) and every per-platform adapter (adapters/*.ts).
// DO NOT add values to AdapterErrorCode without updating the plan §B.1.

// ---------------------------------------------------------------------------
// Capability union — 7 names per §B.2. The 'sync' capability is included in
// the union via the capability type definition itself.
// ---------------------------------------------------------------------------
export type AdapterCapability =
  | 'create_listing'
  | 'activate_listing'
  | 'update_metadata'
  | 'update_price_qty'
  | 'update_images'
  | 'update_variant_inventory'
  | 'sync';

// ---------------------------------------------------------------------------
// Frozen error_code enum (plan §B.1).
// Split into dispatcher-emitted and adapter-emitted sections.
// Adapters MUST map platform-native errors onto adapter-emitted codes only.
// ---------------------------------------------------------------------------
export type AdapterErrorCode =
  // --- Dispatcher-emitted (never from adapters) ---
  | 'AUTH_REQUIRED'
  | 'INPUT_INVALID'
  | 'DOCS_NOT_READY'
  | 'AUTH_NOT_VERIFIED'
  | 'BANNED_SHOP'
  | 'CAPABILITY_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'SKU_ASCII_ONLY'
  | 'QOO10_CATEGORY_UNMAPPED'
  | 'EBAY_CATEGORY_ID_MISSING'
  | 'EBAY_ASPECT_SCHEMA_INVALID'
  | 'EBAY_ASPECT_VALUE_TOO_LONG'
  | 'ALIBABA_REQUIRED_ATTRS_MISSING'
  | 'ALIBABA_SHIPPING_TEMPLATE_MISSING'
  | 'OFFER_PUBLISH_OUT_OF_SCOPE'
  | 'IDEMPOTENT_REPLAY'
  // --- Adapter-emitted (mapped from platform error responses) ---
  | 'PLATFORM_AUTH_FAILED'
  | 'PLATFORM_THROTTLED'
  | 'PLATFORM_VALIDATION_ERROR'
  | 'PLATFORM_NOT_FOUND'
  | 'PLATFORM_NOCAPACITY'
  | 'PLATFORM_UNKNOWN';

// ---------------------------------------------------------------------------
// AdapterContext — passed to every adapter's execute() call.
// ---------------------------------------------------------------------------
export type AdapterContext = {
  // The master product row (subset of columns the adapter needs).
  masterProduct: {
    id: string;
    sku: string;
    product_name: string | null;
    description: string | null;
    main_image: string | null;
    extra_images: string[] | null;
    cost_krw: number;
    weight_g: number;
    joom_variant_grouping: { size: string | null; color: string | null };
    ebay_category_id: string | null;
    qoo10_category_id: string | null;
    [key: string]: unknown;
  };
  shopId?: string;
  country?: string;
  capability: AdapterCapability;
  dryRun: boolean;
  publishRequestId: string;
  // Set for non-create capabilities (update / sync / activate).
  platformItemId?: string;
};

// ---------------------------------------------------------------------------
// AdapterResult — returned by every adapter's execute() call.
// ---------------------------------------------------------------------------
export type AdapterResult = {
  ok: boolean;
  platformItemId?: string;
  listingStatus:
    | 'not_listed'
    | 'draft'
    | 'pending'
    | 'listed'
    | 'error'
    | 'rejected'
    | 'paused'
    | 'banned';
  errorCode?: AdapterErrorCode;
  errorMsg?: string;
  rawResponse?: unknown;
};

// ---------------------------------------------------------------------------
// PlatformAdapter interface — every per-platform adapter must implement this.
// ---------------------------------------------------------------------------
export interface PlatformAdapter {
  // Capabilities this adapter supports. Dispatcher checks this set before
  // calling execute(); unsupported → CAPABILITY_UNSUPPORTED without invoking.
  supports: Set<AdapterCapability>;
  // Single dispatch entry-point; adapter routes internally by ctx.capability.
  execute(ctx: AdapterContext): Promise<AdapterResult>;
}
