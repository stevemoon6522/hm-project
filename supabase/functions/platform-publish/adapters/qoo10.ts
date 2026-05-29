// @ts-nocheck
// Qoo10 adapter placeholder.
// Qoo10 is represented in coverage, but qoo10-bridge/auth smoke is not implemented yet.
// Keep the failure explicit so callers never treat bridge/auth absence as safe-to-publish.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

export const qoo10Adapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'AUTH_NOT_VERIFIED',
      errorMsg: `qoo10-bridge is not implemented and Qoo10 auth smoke has not passed; capability='${ctx.capability}' is intentionally blocked`,
      rawResponse: {
        qoo10_bridge: 'missing',
        auth_verified: false,
        next_step: 'implement supabase/functions/qoo10-bridge lookup/auth smoke before enabling publish',
      },
    };
  },
};
