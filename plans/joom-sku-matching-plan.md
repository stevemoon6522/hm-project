# Joom SKU 매칭 + 가격 변경 전략 계획

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-16 |
| Target | shopee-dashboard — 신규 Joom 통합 계층 (Shopee 베이스 위에 추가) |
| Trigger | User: "Joom API를 활용해서 SKU를 어떻게 매칭해서 가격 변경을 완료할지 계획" |
| API docs | `C:\dev\api-refs\marketplaces\joom\openapi.yaml` (Joom Merchant API v3, 73 ops) + `api-catalog.md` |
| Related plan | [[shopee-price-sync-perf-plan]] (Shopee 가격 sync 의 동일 패턴 — Joom 도 동일 적용) |
| Status | 보고만 (구현은 별도 승인 후) |

---

## 0. TL;DR

Joom 은 **merchant SKU 기반 직접 조회/수정 지원** (Shopee 와 다름):
- `GET /products?sku={our_sku}` → 단일 제품 + variants 반환
- `POST /products/update?sku={our_sku}` → 제품/variant 가격 수정

→ Shopee 처럼 **별도 매핑 ID 테이블 (`product_shopee_listings.shop_item_id`) 같은 것 불필요**. 우리 `products.sku` 가 Joom variant SKU 와 1:1 매칭되도록만 유지하면 됨.

다만 가격 sync **성능** 을 위해선:
- 한 번 lookup 한 Joom `productId/variantId` 를 캐시 (재호출 비용 절감)
- 캐시 위치 후보: 기존 `products` 테이블에 `joom_product_id` (이미 존재), 신규 컬럼 `joom_variant_ids` (JSON) 또는 신규 테이블 `product_joom_listings`

---

## 1. Joom data model 요약 (OpenAPI v3 검증)

`Product`:
- `id` — Joom 고유 product ID
- `sku` — merchant SKU (parent product 단위)
- `variants[]` — Variant list

`Product.VariantCore` (required: `id, currency, price, productId, sku`):
- `id` — Joom 고유 variant ID
- `sku` — merchant SKU (variant 단위, 우리 `products.sku` 와 동일하게 매핑)
- `price` — 판매가
- `currency` — ISO 4217
- `productId` — parent 의 Joom product ID

`Product.Variant.WarehouseAvailability`:
- `(variantId, warehouseId)` 조합 — `inventory` + `shippingPrice`

**핵심:** Joom 은 single product 안에 variants[] 를 nested. 각 variant 는 자체 `sku`, `price`, `currency` 보유. 우리 dashboard 의 1 row = Joom 의 1 variant 와 매칭됨 (Shopee 의 model 과 동일).

---

## 2. SKU 매칭 전략 비교

### Option 1: Direct SKU lookup (lazy, no cache)
```
가격 수정 시:
  POST /products/update?sku={parent_sku}
    body: { variants: [{ sku: "{variant_sku}", price: 12.5, currency: "USD" }] }
```
- 장점: 매핑 테이블 불필요, 항상 최신
- 단점: parent_sku 가 필요 — variant SKU 만으로 동작 안 함. 우리는 variant 단위 row 가 다수 (parent 정보 없음).
- 추가 lookup 필요: `GET /products?sku={variant_sku}` → 응답에서 parent productId + variant 정보 추출
- **2회 API 호출 per 가격 수정** (lookup + update)

### Option 2: Pre-cached Joom IDs in DB (recommended)
products 테이블에 다음 필드 추가:
- `joom_product_id` (이미 존재 — but check if it's used)
- `joom_variant_id` (신규)
- `joom_last_synced_price` (신규)
- `joom_last_synced_at` (신규)

```
가격 수정 시 (cache hit):
  POST /products/update?id={joom_product_id}
    body: { variants: [{ id: joom_variant_id, price: 12.5, currency: "USD" }] }
```
- 장점: 1 API 호출
- 단점: 신규 product 등록 시 한 번 lookup + persist 필요 (Shopee 자동 매핑과 동일 사상)

### Option 3: 별도 매핑 테이블 (Shopee 와 같은 패턴)
- `product_joom_listings (product_id uuid, joom_product_id text, joom_variant_id text, status, last_synced_*)`
- 장점: products 테이블 안 건드림, 향후 다중 store 확장 시 유연
- 단점: 1 row per row (Joom 은 region 개념 없음 — multi-store 도 같은 country/currency 면 동일)

**추천: Option 2** — Joom 은 region 개념 없고 1 product = 1 listing 이라 굳이 별도 테이블 안 만들어도 됨. `products` 컬럼 추가가 자연스러움.

---

## 3. 자동 매핑 flow (Shopee `_gkpApply` mapping 와 유사)

### 신규 상품 추가 시점
1. 사용자가 상품을 추가 (현재는 Shopee GKP 검색 기반, Joom 은 별도 등록 흐름 필요)
2. **Joom 검색 후 매핑** 또는 **Joom 신규 등록**
3. Joom API 호출 결과의 `productId`, `variantId` 를 우리 `products.joom_product_id/joom_variant_id` 에 저장
4. 이후 가격 수정 시 캐시 ID 활용

### 기존 상품 backfill
- 기존 row 의 `joom_product_id` 가 NULL 인 경우: `GET /products?sku={products.sku}` 로 일괄 lookup
- 매칭 실패 시 status='joom_unmapped' 로 표시 (수동 보완 유도, 인덱스 추측 금지 — Shopee plan §11 R1 과 동일 원칙)

---

## 4. 가격 수정 batch 흐름

Shopee `_shopeeBulkSync` 와 같은 패턴:

```js
async function _joomBulkPriceSync(rows) {
  // 1. 우리 DB 에서 (joom_product_id, joom_variant_id) 갖춘 row 만 선택
  const targets = rows.filter(r => r.joom_product_id && r.joom_variant_id);
  
  // 2. Parent product 별로 그룹 (1 API 호출 = 1 product, 여러 variant 동시 update)
  const byParent = new Map();
  for (const t of targets) {
    if (!byParent.has(t.joom_product_id)) byParent.set(t.joom_product_id, []);
    byParent.get(t.joom_product_id).push({
      id: t.joom_variant_id,
      price: t.targetPrice,
      currency: t.currency,
    });
  }
  
  // 3. 병렬 호출 (concurrency 5, Shopee Option A 와 동일 패턴)
  const entries = [...byParent.entries()];
  const results = [];
  for (let i = 0; i < entries.length; i += 5) {
    const chunk = entries.slice(i, i + 5);
    const chunkResults = await Promise.allSettled(chunk.map(async ([productId, variants]) => {
      const r = await fetch(`${JOOM_BRIDGE}/products/update?id=${productId}`, {
        method: 'POST',
        headers: joomAuthHeaders,
        body: JSON.stringify({ variants }),
      });
      return { productId, ok: r.ok, status: r.status };
    }));
    results.push(...chunkResults);
  }
  
  // 4. 성공한 것 last_synced 갱신
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      // update DB joom_last_synced_price, joom_last_synced_at
    }
  }
}
```

**API 호출 비용**:
- Shopee: 6 region × N variant = 6N 호출 (model_id validation 포함)
- Joom: 1 호출 per parent product (variant 다수 한 번에 update). **단순 모델 시 90%+ 감소**.

---

## 5. Joom Bridge edge function 설계

기존 `joom-bridge` (kpop-wms 용) 와 별도로 dashboard 용 actions 추가 (또는 같은 함수에 추가):

### 필요한 actions
| Action | Method | Joom 엔드포인트 | 용도 |
|---|---|---|---|
| `joom_product_lookup` | GET | `/products?sku=...` | sku → productId/variantId 매핑 (1회) |
| `joom_products_list` | GET | `/products/multi?updatedFrom=...` | 백필/cache 갱신 |
| `joom_product_update` | POST | `/products/update?id=...` | 가격 일괄 수정 |
| `joom_published_get` | GET | `/products/published?ids=...` | 현재 publish 상태 확인 |

### 기존 joom-bridge 와의 중복 회피
[[project_starwms_joom_api_facts]] 메모리에 따르면 joom-bridge 는 이미 OAuth + polling 흐름 구현됨. SD 용 actions 는 그 OAuth flow 재사용 (refresh token 공유), product 관련 새 action 만 추가.

---

## 6. 위험과 mitigation

| 리스크 | 완화 |
|--------|------|
| Joom variant SKU 가 우리 SKU 와 다름 (변경되었거나 등록자가 다르게 입력) | matching 실패 시 status='joom_unmapped' + last_error 기록 (Shopee R1 패턴) |
| `products/update` 부분 update 시 variants[] 에 빠진 variant 가 disable/삭제 될 수 있음 | OpenAPI 문서로 검증 필요 (현재 spec 만 봐선 불명확). 안전한 default: 모든 variant 포함 |
| OAuth token 만료 | joom-bridge 에 이미 refresh 로직 있음 (memory 검증) |
| Currency mismatch | variant 별로 currency 명시. 일관성 보장 위해 calcRow() 가 region 별 currency 계산해야 함 (Shopee 와 다름) |
| Joom 가격 단위 (cents? 단위?) | OpenAPI 의 price 정의는 `?` (resolved 못함, 별도 검증 필요) |

---

## 7. Phase 별 구현 roadmap

### Phase 1 (백엔드 신호 확인, 1일)
- joom-bridge edge function 에 `joom_product_lookup` action 추가
- 테스트 SKU 로 호출 → response 구조 확인 (productId, variantId, price 단위)
- price 단위가 cent (정수) 인지 dollar (소수) 인지 결정

### Phase 2 (DB 스키마, 0.5일)
- migration: `products` 테이블에 `joom_variant_id text` + `joom_last_synced_price numeric` + `joom_last_synced_at timestamptz` 추가
- (이미 있는 `joom_product_id` 활용 — 누가 채우는지 확인)

### Phase 3 (매핑 backfill, 0.5일)
- 스크립트: 기존 모든 row 의 sku 를 Joom 에 lookup → joom_product_id/variant_id 저장
- 실패 row 는 status='joom_unmapped' 로 표시

### Phase 4 (UI 통합, 1일)
- shopee-modal 옆에 joom-modal 추가 (또는 통합)
- Joom 가격 수정 버튼 → `_joomBulkPriceSync` 호출
- 결과 표시

### Phase 5 (자동 매핑 신규 추가, 1일)
- Shopee GKP `_gkpApply` 와 유사: Joom 신규 추가 시 자동으로 joom_product_id/variant_id 매핑

**총 추정**: ~4일 (1인 기준)

---

## 8. Out of scope (이번 plan 아님)

- Joom 신규 상품 등록 UI (현재는 Shopee 기반 등록만 있음)
- Joom 주문 처리 (이미 kpop-wms 에 있음, 책임 분리)
- FBJ inbound/replenishment 통합 (대규모 별도 프로젝트)
- 다중 Joom store 지원

---

## 9. 다음 결정 사항 (사용자 답변 필요)

1. **Joom 매칭 사용 시점**: 신규 상품 추가 시 자동 매핑 vs 별도 "Joom 매핑 동기화" 버튼 trigger?
2. **DB 스키마**: Option 2 (products 컬럼 추가) vs Option 3 (별도 테이블)?
3. **Phase 1 우선 진행 권한**: edge function 에 lookup action 만 먼저 추가해도 되는지? (deploy 필요)
4. **Joom 가격 단위 검증**: 실제 API 호출 테스트 권한? (기존 joom-bridge 에 OAuth 셋업 되어있어 가능)
