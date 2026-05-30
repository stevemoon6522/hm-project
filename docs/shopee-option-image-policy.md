# Shopee 옵션 이미지 정책 (단일 이미지)

작성: 2026-05-30

## 정책

마스터 상품의 **옵션 이미지는 옵션당 1장만** 사용한다. 별도의 "추가 이미지(extra image)" 탭/입력은 두지 않는다.

- 옵션(예: BRIDGE / RANDOM / SET …)마다 그 옵션 고유의 대표 이미지 **1장**.
- 옵션 고유 이미지를 못 구하면 상품 메인 이미지로 fallback (단, 아래 버그 주의).

## 배경 — cortis 옵션 이미지 버그 (2026-05-30 수정)

Shopee `get_global_model_list` 응답의 `tier_variation[].option_list[].image`(옵션별 이미지)를
기존 코드가 추출하지 않아, **모든 옵션이 동일한 메인 이미지로 fallback** 되는 버그가 있었다.
(예: CORTIS GREENGREEN 앨범의 BRIDGE/RANDOM/SET/STREET/STUDIO 5개 옵션이 전부 같은 이미지.)

수정 (commit f972ba2, V2 `v2/index.html`):
- `sgFetchModels` — `global_model_list` 응답에서 `tier_variation`(옵션별 이미지) 추출하여 반환.
- `sgEnsureModelsForRows` — `tier_variation`을 `row.item.tier_variation`에 적용해 옵션 이미지 정상 동작.
- `sgImageUrlFromImageObject` — `image_url`이 없으면 `image_id`로 Shopee CDN URL 구성.
- 추가 이미지 탭 제거 (마스터 편집 옵션 테이블 / 저장 / 페이로드에서 일괄 제거).

## 저장 위치

- `products.shopee_option_image_url` (text) — 옵션 1장 URL. **Shopee global import 시점**에
  `v2/index.html`의 `sgOptionImageUrl(item, model)`로 채워진다 (`v2/index.html:4311`).
- 즉 이 값은 import(재수집) 때 결정된다. 코드 수정 전 import된 상품은 옛 fallback 값이 남아 있을 수 있으며,
  **해당 상품을 V2에서 다시 import 하면 수정된 로직으로 옵션별 이미지가 올바르게 갱신**된다.

## 운영 규칙

- 마스터 상품 옵션 이미지는 1장 정책을 유지한다. 추가 이미지 UI를 다시 도입하지 않는다.
- [sd] UI 변경은 **V2(`v2/index.html`)만** 수정한다. V1(`index.html`)은 마이그레이션 완료된 legacy.
