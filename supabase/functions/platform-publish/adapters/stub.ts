// @ts-nocheck
// D0 stub adapter — used by all 5 platforms in the D0 phase.
//
// Plan ref: platform-publish-dispatcher-plan.md v2 §D0.
// D0 exit criterion: every platform returns DOCS_NOT_READY or
// CAPABILITY_UNSUPPORTED via this stub. Real adapters land in D2-D6.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

// The stub has an empty supports set — the dispatcher will hit
// CAPABILITY_UNSUPPORTED for every capability before ever calling execute().
// The execute() body exists as a defensive fallback only.
export const stubAdapter: PlatformAdapter = {
  supports: new Set(),

  async execute(_ctx: AdapterContext): Promise<AdapterResult> {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'CAPABILITY_UNSUPPORTED',
      errorMsg: 'D0: adapter not wired yet',
    };
  },
};
