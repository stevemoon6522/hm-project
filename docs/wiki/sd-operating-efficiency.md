# SD Operating Efficiency

Purpose: reduce recurring SD marketplace failures by making intake, diagnosis, verification, and recurrence notes repeatable. For the first two weeks, optimize for lower recurrence of the same failure class rather than feature throughput.

## Intake Template

Use this shape before changing code or calling marketplace write APIs.

- 상품 또는 주문:
- 플랫폼:
- 지역:
- 작업 유형:
- 증상:
- 기대 결과:
- 현재 결과:
- 관련 탭/버튼/오류 메시지:
- 실마켓 write 영향 여부:
- 관련 local docs/logs/API 응답:

Required handling:

- If 실마켓 write 영향 여부 is yes or unclear, confirm the target product, platform, region, and write action before executing.
- For API-related work, read the local API doc first and cite the path in the final report.
- Start from the named product, platform, region, tab/button, and exact error message instead of broad code searches.
- Compare a known-success case and failing case when practical.

## Diagnosis Packs

### Shopee 등록 실패

Compare in this order:

- Failed and successful registration payloads.
- Variant SKU to Shopee model mapping.
- Global Product ID, Shop Item ID, and target publish region.
- Product image IDs, region image IDs, and BR two-image requirement.
- Brand, category, mandatory attributes, stock, price, DTS, and publishable shop state.
- Bridge stage log from `shopee-bridge/register_cbsc` or `platform-publish`.

Local API docs:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_model.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publish_task_result.json`

Regression commands:

```powershell
node scripts/test-v2-shopee-registration-hardening.mjs
node scripts/test-v2-shopee-registration-platform-mapping.mjs
node scripts/test-v2-platform-test-cycle.mjs
```

### 가격 동기화

Compare in this order:

- Dry-run diff for each target Variant SKU.
- Target platform listing IDs and target model IDs.
- Last known good local price snapshot.
- Live marketplace result after write, only when a write was explicitly intended.
- Rollback path or previous payload if the write changed live marketplace state.

Regression commands:

```powershell
node scripts/test-v2-price-snapshot-dry-run-ui.mjs
node scripts/test-v2-price-sync-v1-parity.mjs
node scripts/test-v2-shopee-bulk-price-stability.mjs
```

### 이미지 반영 오류

Compare in this order:

- Master representative image.
- Option image and layered marketplace image.
- Detail image list.
- Platform upload response or image ID.
- Final payload image fields.

Regression commands:

```powershell
node scripts/test-v2-marketplace-layered-image.mjs
node scripts/test-v2-joom-title-and-blank-image-regression.mjs
node scripts/test-shopee-bridge-image-hardening.mjs
```

### Joom 등록 오류

Compare in this order:

- Joom Brand value and source.
- Category ID.
- Detail image count and URL reachability.
- Variant SKU, price, stock, and weight.
- Response body from Joom bridge.

Local API docs:

- `C:\dev\api-refs\marketplaces\joom\openapi.yaml`

Regression commands:

```powershell
node scripts/test-v2-joom-register-images-sku.mjs
node scripts/test-v2-joom-registration-platform-mapping.mjs
node scripts/test-joom-detail-resource-limit-regression.mjs
```

### eBay/Qoo10 확장 오류

Compare policy/category/aspect/fulfillment/preflight state before payload changes. Do not infer marketplace behavior from memory when local API docs exist.

## Verification Matrix

| Change type | Minimum verification |
| --- | --- |
| V2 UI 변경 | Local `/v2/` render check, related regression/static test, `npm run verify:v2-deploy-source` |
| API/Bridge 변경 | Local API doc check, dry-run when available, failed/success payload comparison |
| 실마켓 write 변경 | Explicit write intent, small batch or disposable test cycle, live smoke result |
| 배포 변경 | Production deploy, then live `/v2/` smoke |
| Wiki/문서 변경 | Check canonical repo doc path and local Obsidian draft state when relevant |

Completion means verification passed, not just that code changed.

## Recurrence Memo

Write this after a recurring failure is fixed:

- 증상 signature:
- 원인:
- 수정 위치:
- 검증 명령:
- 재발 방지 규칙:
- 관련 API 문서 경로:
- 후속 확인 시점:

Promotion rule:

- Keep short session-specific notes in working docs.
- Promote broadly reusable rules to `docs/wiki/` in this repo.
- Use the local Obsidian vault only when Steve asks to save to Wiki.
