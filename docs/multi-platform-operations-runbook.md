# Multi Platform Dashboard Operations Runbook

This repo document is the developer/automation companion for the operator-facing Obsidian runbook.

## Obsidian Canonical Note

Operator-facing canonical draft:
`C:\Users\STEVE\Documents\MVPICK\30_Runbooks\Multi Platform Dashboard 운영 패턴 Runbook.md`

## Scope

- Shopee Dashboard V2
- Joom bridge / registration
- eBay / Qoo10 expansion flows
- B2B Catalog Google Sheet sync
- Vercel deployment smoke checks

## Intake Template

Use `templates/sd-incident-intake.md` before changing code or calling marketplace write APIs.

Minimum fields:

- 상품 / 주문
- 플랫폼
- 지역
- 작업 유형
- 관련 화면 / 버튼
- 오류 메시지 / 증상
- 기대 결과
- 현재 결과
- 실마켓 write 영향 여부

## Verification Matrix

| Change type | Minimum verification |
| --- | --- |
| V2 UI change | Run the narrow static/regression test, `npm run verify:v2-deploy-source`, and local HTML/HTTP check when practical. |
| API route change | Run `node --check` for the route and the relevant static/regression tests. Verify auth failure and intended success path when credentials are available. |
| Supabase Edge Function change | Run related regression tests and dry-run; deploy only when explicitly requested. |
| Live marketplace write | Use a small or disposable test cycle and verify remote readback after registration/update/delete. |
| Price / stock sync | Do not trust UI toast only. Verify live marketplace readback when write was intended. |
| Vercel deployment | After explicit deploy request, verify production alias and live `/v2/` HTTP 200 plus changed tokens. |
| Wiki / docs change | Verify Obsidian vault path and keep source Review links. |

## Platform Diagnosis Packs

### Shopee

Common flows:

- Product registration failure
- Publish region failure
- SKU / variant / model mapping drift
- Price sync partially missing selected options
- Representative / option / detail image mismatch

Check order:

1. Confirm SKU, option, and region.
2. Inspect local mapping row.
3. Read back Shopee `model_id`, `model_sku`, and `model_name`.
4. Compare price, stock, image, brand, category, and publish payload.
5. Compare a passing region/product with the failing one.
6. Add or update the narrow regression test.

### Joom

Common flows:

- Brand/category/detail image constraints
- Registration latency
- Detail image transform or missing image
- Remote status check after registration

Check order:

1. Confirm SKU, Joom category, and brand.
2. Verify detail image and square transform path.
3. Inspect `joom-bridge` timing fields.
4. Separate dry-run and live cycle verification.
5. For disposable tests, register, delete, and read back archived/not_listed state.

### eBay / Qoo10 / New platform expansion

Common flows:

- Policy/category/aspect/fulfillment mapping
- Shipping template connection
- Missing preflight fields

Check order:

1. Read the local API docs first.
2. Keep marketplace policy ID separate from human-readable policy name.
3. Define product-type default policy mapping.
4. Surface missing or risky fields in preflight.
5. Ensure manual and automated registration use the same policy criteria.

### B2B Catalog Google Sheet sync

Common flows:

- `catalog_items` DB source-of-truth
- Google Sheet mirror
- Public vs internal columns
- Service Account / Sheet sharing / Vercel env

Check order:

1. Verify Vercel env presence.
2. Confirm Supabase session token is required for API route.
3. Check API response fields: `visible_tabs`, `hidden_tabs`, `spreadsheet_url`.
4. Confirm the Sheet uses public `Catalog` and hidden `Internal Coverage`.
5. Ensure StarOneMall URL/PNO are not exposed in public tabs.

### Vercel deployment smoke checks

Check order:

1. Run `npm run verify:v2-deploy-source` before deployment.
2. Deploy only after Steve explicitly asks.
3. Capture production deployment URL and alias URL.
4. Verify `https://starphotocard-multi-dashboard.vercel.app/v2/` returns HTTP 200.
5. Verify live HTML contains the changed tokens.

## Required Validation Commands

Run these after changing this runbook/template set:

```bash
node scripts/test-sd-operating-efficiency-docs.mjs
npm run verify:v2-deploy-source
```

Related focused checks that may be relevant depending on the touched area:

```bash
node scripts/test-v2-b2b-catalog.mjs
node scripts/test-v2-joom-registration-platform-mapping.mjs
node scripts/test-v2-platform-test-cycle.mjs
```

## Recurrence Memo Format

Use this format in Obsidian when an incident is fixed:

```markdown
## 증상 signature

## 원인

## 수정 위치

## 검증 명령

## 실제 검증 결과

## 재발 방지 규칙

## 관련 API 문서 / 코드 경로

## 후속 확인 시점
```
