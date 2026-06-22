# Shopee 등록 preflight 정리

## 결론

Shopee 상품 등록 실패 원인은 옵션 이미지 누락이 아니다.

Shopee `create_publish_task` 문서 기준 `item.standardise_tier_variation[].variation_option_list[].image_id`는 optional이다. 옵션 이미지가 없어도 상품 등록은 가능하며, 옵션 이미지 업로드 실패는 상품 등록을 막지 않아야 한다.

실제로 등록 전에 방어해야 할 항목은 상품 이미지, region별 `image_id_list`, stock, price, tier index, 필수 속성, 카테고리, 브랜드, DTS 쪽이다.

## 참고한 로컬 Shopee API 문서

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_model.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`

## 주요 가설과 처리

### 옵션 이미지 누락

- 원인 아님.
- 옵션 이미지는 optional.
- 옵션 이미지 업로드 실패가 발생해도 상품 등록은 계속 진행한다.

### 상품 이미지 부족

- 실제 오류 가능.
- `add_global_item` / `create_publish_task`는 상품 `image_id_list`가 필요하다.
- KRSC는 target region별 image ID가 필요하고, BR은 최소 2장 필요하다.
- target region image가 없으면 등록 전에 업로드하거나 차단한다.
- cached default image ID만으로 target-region 누락을 통과시키지 않는다.

### 단일 상품 stock 0

- 실제 오류 가능.
- 단일 상품도 stock은 1 이상이어야 한다.
- `platform-publish`와 `shopee-bridge/register_cbsc`에서 API 호출 전에 차단한다.

### 그룹 옵션 stock 0

- 실제 오류 가능.
- Shopee `seller_stock[].stock` 최소값 위반.
- 옵션별 stock은 1 이상이어야 한다.

### 옵션 가격 0 또는 누락

- 실제 오류 가능.
- `global_model[].original_price`는 0보다 커야 한다.
- 옵션별 price는 1 이상이어야 한다.

### tier_index 오류

- 실제 오류 가능.
- 옵션 조합 중복, tier index 길이 불일치, 범위 초과를 등록 전에 검증한다.

### SKU / weight 누락

- 실제 오류 가능.
- 옵션 SKU와 옵션 weight를 등록 전에 검증한다.

### 카테고리, 브랜드, 필수 속성, DTS, publishable shop

- 기존 bridge 경로에서 stage/error로 반환한다.
- mandatory attribute, banned shop, unpublishable shop은 Shopee API 호출 전후로 원인을 노출한다.

## 적용된 수정

### V2 UI 등록 모달

- 그룹 옵션 preflight 추가:
  - option stock
  - option price
  - option SKU
  - option weight
  - tier index / option combination
- 옵션 stock 입력 최소값을 1로 변경.
- Stage 1 저장 payload에 옵션 `inventory` 반영.
- target region별 상품 이미지 preflight 추가.
- 상품 이미지가 부족하고 업로드할 원본 이미지도 없으면 등록 차단.

### `shopee-bridge/register_cbsc`

Shopee API 호출 전에 다음 stage로 실패를 반환한다.

- `image_preflight`
- `stock_preflight`
- `price_preflight`

이 preflight를 통과하지 못하면 `add_global_item`을 호출하지 않는다.

### `platform-publish` Shopee adapter

- 단일 상품 stock 0 차단.
- 옵션 상품 stock 0 차단.
- 옵션 가격 0 차단.
- region image 부족 차단.
- 필요한 경우 target region별 상품 이미지 재업로드.

## 배포 정보

- Commit: `25f6e0b Harden Shopee registration preflights`
- Live: `https://shopee-dashboard-kohl.vercel.app/v2/`
- Vercel deployment: `dpl_AA4E1CxjC3oku3LM4Z93BDFN3jFX`

## 검증

통과한 주요 테스트:

```powershell
node scripts\test-v2-shopee-registration-hardening.mjs
node scripts\test-v2-shopee-group-register-modal.mjs
node scripts\test-v2-shopee-register-price-flow.mjs
node scripts\test-v2-shopee-option-register-separation.mjs
node scripts\test-v2-shopee-tier-index-regression.mjs
node scripts\test-v2-shopee-strict-registration-fixes.mjs
node scripts\test-platform-publish-group-registration.mjs
node scripts\test-v2-platform-test-cycle.mjs
```

Live smoke:

- `/v2/` HTTP 200
- bridge connected
- console/page error 없음
- 새 preflight source 포함 확인

## 운영 메모

Shopee 등록 문제를 볼 때는 옵션 이미지부터 의심하지 않는다. 먼저 아래 순서로 확인한다.

1. 상품 이미지가 target region별로 업로드되어 있는가?
2. BR 대상이면 상품 이미지가 2장 이상인가?
3. 단일 상품 또는 모든 옵션 stock이 1 이상인가?
4. 단일 상품 또는 모든 옵션 가격이 1 이상인가?
5. 옵션 SKU, weight, tier index가 완성되어 있는가?
6. 카테고리, 브랜드, 필수 속성, DTS가 채워져 있는가?
7. publishable shop / banned shop 오류가 bridge result에 표시되는가?
