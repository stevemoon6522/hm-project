# 마스터 우선 플랫폼 등록 계획

작성일: 2026-06-14
범위: Shopee Dashboard V2 (`v2/index.html`)

## 결정

가격 동기화를 더 확장하기 전에, 먼저 "상품 소스 수집 → 마스터 상품 생성 → 플랫폼 등록/매핑" 파이프라인을 안정화한다.

목표 운영 순서는 다음과 같다.

1. WMS 또는 외부 소스에서 상품을 검색/크롤링한다.
2. 수집한 데이터를 V2 마스터 상품으로 정리한다.
3. 마스터 상품을 운영 대상 플랫폼에 등록하거나 기존 상품과 매핑한다.
4. 플랫폼 listing 식별자가 저장된 뒤에 가격 동기화를 실행한다.

가격 동기화는 안정적인 플랫폼 매핑에 의존한다. Shopee는 실가격 push에 `shop_item_id`가 필요하고, 옵션 상품은 정확한 `shop_model_id`도 필요하다. Joom과 eBay도 안전한 가격 수정 전에 product/variant/offer ID가 필요하다.

## 이 작업이 우선인 이유

현재 V2 가격 동기화 경로는 이미 마스터 상품과 플랫폼 매핑이 존재한다고 가정한다.

- `products`: SKU, 상품명, 옵션명, 원가, 도매가, 무게를 제공한다.
- `product_shopee_listings`: Shopee region별 매핑과 현재 캐시 가격을 제공한다.
- Joom/eBay 등은 각 플랫폼 ID와 상태 컬럼을 사용해 가격 수정 대상을 찾는다.
- `country_settings`: V1 기준 가격 계산식의 fee/exchange 설정을 제공한다.

따라서 가격 동기화만 먼저 고도화하면 핵심 병목이 남는다. 많은 상품이 여전히 플랫폼 ID를 갖고 있지 않으면 live 가격 update를 실행할 수 없다.

## 목표 흐름

### 1. 소스 검색 및 크롤링

입력 소스:

- WMS inventory/search 데이터.
- 가능한 경우 Staronemall 상품 페이지.
- 기존 source record 또는 이미 가져온 플랫폼 catalog row.

수집 필드:

- 상품명과 옵션명.
- SKU 후보.
- 대표 이미지와 추가 이미지.
- 원본 URL.
- 도매가 또는 sourcing price.
- 무게 또는 무게 후보.
- release/lifecycle 정보.

### 2. 마스터 상품 생성

수집한 데이터를 `products` 기준의 V2 마스터 상품으로 저장한다.

필수 동작:

- 판매 가능한 SKU 또는 옵션 단위로 마스터 row를 만든다.
- 옵션 상품은 `product_group_id`로 묶는다.
- 옵션 순서와 옵션명을 보존한다.
- `sourcing_price`를 저장한다.
- 필요한 경우 기존 규칙대로 `도매가 x 1.30`으로 운영 원가/정산가를 계산한다.
- `cost_krw`, `weight_g`, 이미지, lifecycle, source URL을 저장한다.
- 중복 SKU와 애매한 옵션 매핑은 저장 전에 차단하거나 명확히 표시한다.

### 3. 플랫폼 등록 및 매핑

마스터 row가 안정화된 뒤 플랫폼별 등록/매핑을 진행한다.

플랫폼 우선순위:

1. Shopee 운영 region: SG, TW, TH, MY, PH, BR.
2. Joom Logistics 대상 상품.
3. eBay 등록 요건이 충족된 상품: category, policy, weight, image.
4. Qoo10은 API 승인과 live 가격 update 경로가 준비될 때까지 queue 또는 draft 상태로 둔다.
5. Alibaba group-order는 B2B bulk 판매 대상일 때만 별도 흐름으로 다룬다.

Shopee 매핑 요구사항:

- 상품 및 운영 region별로 `product_shopee_listings` row를 저장한다.
- 가능한 경우 `global_item_id`를 저장한다.
- 발행된 region마다 `shop_item_id`를 저장한다.
- 옵션 row는 `shop_model_id`를 저장한다.
- 모델 ID를 배열 순서만으로 추측하지 않는다.
- SKU, global SKU, 옵션명, stable tier index 등으로 매칭한다.
- 매칭 실패 row는 가격 push 대상에서 제외하고 mapping-needed 상태로 남긴다.

Joom/eBay 매핑 요구사항:

- Joom은 product ID, variant ID, currency, mapping status, last synced price를 저장한다.
- eBay는 SKU, offer ID, item ID, marketplace ID, publish status, last synced price를 저장한다.

### 4. 등록 후 검증

등록 후에는 local mapping이 remote platform 상태와 맞는지 검증한다.

체크 항목:

- remote 상품이 생성되었거나 기존 상품이 발견되었는가.
- 기대한 SKU와 옵션 row가 존재하는가.
- 필수 platform identifier가 local DB에 저장되었는가.
- remote listing 상태가 publish 가능 또는 published 상태인가.
- 이미지와 옵션명이 누락되지 않았는가.
- 현재 `cost_krw`, `weight_g`, `country_settings`로 가격 미리보기가 계산되는가.

### 5. 가격 동기화

매핑 검증을 통과한 뒤 가격 동기화를 실행한다.

Shopee 현재 경로:

- 선택 상품과 활성 region별로 shop-level `/update_price` payload를 만든다.
- 단일 상품은 `price_list: [{ original_price }]`를 사용한다.
- 옵션 상품은 `price_list: [{ model_id, original_price }]`를 사용한다.
- bridge 호출 전에 model mapping preflight를 실행한다.
- 성공 후 `last_synced_price`, `last_synced_at`을 저장한다.

Joom 현재 경로:

- SKU lookup을 먼저 실행한다.
- `joom-bridge/update-price`를 호출한다.
- remote variant currency를 유지한다.
- Joom mapping과 last synced price 필드를 저장한다.

eBay 현재 경로:

- `ebay_sku`, `PUBLISHED` 상태, `ebay_offer_id`가 필요하다.
- `bulk_update_price_quantity` 기반 price-only bridge 경로를 호출한다.
- `ebay_last_synced_price`와 sync timestamp를 저장한다.

Qoo10 현재 경로:

- 정확한 live 가격 endpoint가 구현 및 검증될 때까지 preview-only로 유지한다.

## 구현 단계

### Phase 0: 현재 상태 점검

- platform coverage가 없는 master row를 목록화한다.
- 누락 상태를 platform/region별로 나눈다.
- 중복 SKU, 무게 누락, 도매가 누락, 이미지 누락 row를 식별한다.
- Qoo10에서 API 승인 대기 때문에 막힌 흐름을 확인한다.

### Phase 1: WMS/Search → Master 안정화

- WMS/source 검색 흐름이 깨끗한 `products` row를 만들게 한다.
- 옵션 그룹 저장을 일관되게 만든다.
- 중복 SKU와 애매한 옵션 매핑 guard를 강화한다.
- 추후 검증을 위해 source evidence를 저장한다.

### Phase 2: 등록 Queue

- 각 master 상품의 플랫폼 상태를 보여주는 coverage queue를 추가하거나 정리한다.
- 운영자가 platform/region을 선택해 등록할 수 있게 한다.
- 필수 필드가 누락된 상품은 등록을 막는다.
- 실패한 등록은 retry 가능하게 남긴다.

### Phase 3: 플랫폼 등록

- Shopee active region 등록을 먼저 완료한다.
- Shopee publish/import 성공 직후 `product_shopee_listings` mapping을 저장한다.
- Joom/eBay는 각 플랫폼 필수값이 충족된 상품만 등록한다.
- Qoo10은 live 지원 준비 전까지 draft/queued 상태로 둔다.

### Phase 4: Mapping Hydration 및 검증

- 등록 후 remote listing을 다시 조회한다.
- 누락된 `shop_item_id`, `shop_model_id`를 backfill한다.
- unresolved row를 명확히 표시한다.
- unresolved mapping은 가격 동기화 대상에서 제외한다.

### Phase 5: 가격 동기화 Hardening

- Shopee shop-level `update_price`를 primary live path로 유지한다.
- 필요하면 dry-run과 live 실행의 의미를 더 명확히 분리한다.
- 가격 snapshot을 dry-run 증거뿐 아니라 normal live apply 흐름에도 연결하는 방안을 검토한다.
- rollback/retry 도구는 registration pipeline이 안정화된 뒤 추가한다.

## 완료 기준

- 상품을 검색/크롤링해서 하나 이상의 V2 master row로 저장할 수 있다.
- 옵션 상품이 option grouping과 SKU identity를 보존한다.
- 선택한 master row가 Shopee active region에 등록되거나 매핑된다.
- Shopee 옵션 row는 정확한 `shop_model_id`를 갖거나 명확한 blocker reason으로 차단된다.
- Joom/eBay row는 remote identifier가 저장된 뒤에만 mapped 상태가 된다.
- 필수 platform identifier가 없는 row는 가격 동기화에서 차단된다.
- 가격 동기화 성공 후 local last-synced 필드가 실제 push 가격과 timestamp를 반영한다.

## 위험 및 Guard

- 잘못된 옵션 매핑은 다른 옵션 가격을 바꿀 수 있다. SKU/옵션/tier data 기준으로 매칭하고, 배열 index만으로 추측하지 않는다.
- 무게 누락 또는 stale 도매가는 잘못된 가격을 만들 수 있다. 등록/동기화 전에 누락 및 stale 입력을 강조한다.
- Qoo10 live 가격 update는 아직 준비되지 않았다. endpoint 동작 검증 전까지 preview-only로 유지한다.
- 플랫폼 등록은 부분 실패할 수 있다. 성공한 mapping은 보존하고 실패한 region/platform만 retry한다.
- 현재 dry-run은 marketplace API를 호출하지 않지만 local cost는 저장할 수 있다. dry-run 사용을 확장하기 전에 이 동작을 UI에서 명확히 설명한다.

## 로컬 참고 파일

- `v2/index.html`: 가격 동기화 화면과 handler.
- `v2/price-engine.js`: 공통 가격 계산 로직.
- `edge-functions/shopee-bridge/index.ts`: Shopee `update_price` bridge 경로.
- `edge-functions/joom-bridge/index.ts`: Joom `update-price` bridge 경로.
- `edge-functions/ebay-bridge/index.ts`: eBay price-only update bridge 경로.
- `plans/master-keyword-price-sync-roadmap.md`
- `plans/gkp-auto-shop-mapping-plan.md`
- `plans/shopee-price-sync-perf-plan.md`
- `plans/qoo10-ebay-price-sync-plan.md`
