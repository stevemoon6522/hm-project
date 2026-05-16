# Shopee Days-to-Ship 일괄 수정 plan

| | |
|---|---|
| Author | Opus 4.7 |
| Date | 2026-05-16 |
| Target | shopee-dashboard — 신규 일괄 DTS 수정 기능 |
| Trigger | User: "각 국가별 shop products 의 days to ship을 일괄로 수정하는 기능" |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\` (KRSC 셀러 제약 따름) |
| Status | 보고만, 구현은 별도 승인 후 |

---

## 0. TL;DR

Shopee 공식 docs 검증 결과:
- **단일 값 일괄 (모든 region 동일 DTS)** → `POST /api/v2/global_product/update_global_item` 의 `pre_order.days_to_ship` 한 번 호출로 가능. 모든 published shop 에 자동 propagate.
- **Region 별 다른 값** → KRSC 셀러 제약으로 **불가능** (shop-level `product.update_item` API 차단됨). `set_sync_field` 로 sync 해제 후 shop-level 수정해야 하는데 그게 막혀 있음.

→ 우리가 만들 수 있는 건 **A 옵션 (모든 region 동일 DTS 일괄)** 뿐. 사용자 의도가 B 였다면 KRSC 제약 surface 후 다른 워크플로우 (수동 Shopee Seller Center 편집) 안내.

---

## 1. Shopee API 문서 검증 (verified facts)

### 1.1 update_global_item (`global_product/v2.global_product.update_global_item.json`)
- `pre_order` object:
  - `is_pre_order` (boolean, required) — pre-order 여부
  - `days_to_ship` (int32, required) — "Days to ship."
  - Note from official sample: **"Updating the DTS of global item will overwrite the DTS of all global models under the global item"**
- → 1 API 호출 = 1 global_item 의 모든 variant + 모든 published shop 의 DTS 가 동시에 갱신됨
- 매우 효율적, 사용자 의도 (A) 일괄 변경에 최적

### 1.2 update_global_model (`global_product/v2.global_product.update_global_model.json`)
- `pre_order.days_to_ship` (int32) — variant 단위로 DTS 설정 (overrides global item DTS)
- Note: "If don't set the DTS of this global model, will use the DTS of the global item by default."
- 일부 셀러는 권한 없음 — 에러 메시지 `error_auth: Your shop can not use model level dts` 가능

### 1.3 set_sync_field (`global_product/v2.global_product.set_sync_field.json`)
- 각 published shop 별로 어떤 필드를 global 에서 sync 받을지 toggle
- `shop_sync_list[]` 안에 `days_to_ship: boolean` 항목 있음
- `false` 로 설정하면 해당 shop 은 global update 를 무시하고 shop-level 값 유지
- 즉 **region 별 다른 DTS 를 원한다면 → set_sync_field 로 sync OFF → shop-level `product.update_item` 호출 필요**
- 하지만 KRSC 셀러는 `product.update_item` 차단됨 (memory `[[project_shopee_krsc_facts]]`)
- → region 별 다른 DTS 는 사실상 Shopee Seller Center UI 에서 수동 편집해야 함

### 1.4 get_global_item_limit (`global_product/v2.global_product.get_global_item_limit.json`)
- 카테고리 별 `dts_limit` (허용 범위) 반환
- 사용자가 입력한 DTS 가 카테고리 범위 벗어나면 update API 가 reject
- → preflight 단계에서 `get_global_item_limit` 으로 범위 확인 권장

### 1.5 KRSC 제약 (memory `[[project_shopee_krsc_facts]]`)
- starphotocard 는 KRSC 업그레이드 셀러
- 사용 가능: Global Product API + Merchant API
- 차단: Shop-level Product API (`/api/v2/product/update_item` 등)
- → DTS 수정은 **반드시 update_global_item 또는 update_global_model 통해야** 함

---

## 2. 사용자 의도 해석

"각 국가별 shop products 의 days to ship 을 일괄로 수정" — 2가지 해석:

### 해석 A: 모든 region 에 같은 DTS 일괄 적용 (most likely)
- 예: "이번 신보는 발매 후 7일 배송" → 6 region 의 DTS 를 모두 7로
- API: `update_global_item` 1번 호출 per global_item
- 호출 비용: N global_items × 1 API call (변형이든 단일이든 상관없이 parent global_item 만 호출)
- KRSC 셀러 가능 ✅

### 해석 B: Region 별 다른 DTS 를 한 화면에서 일괄 설정
- 예: SG=5, TW=3, BR=10, ...
- KRSC 셀러 **불가능** (shop-level update_item 차단)
- 대안:
  - Shopee Seller Center 에서 수동 편집 (region 별 로그인)
  - 또는 set_sync_field 로 sync OFF + shop-level API 권한 요청 (Shopee 영업 통해 별도 신청)

→ 추천: **해석 A 를 가정하고 구현**, B 가 필요하면 사용자 답변 후 별도 설계.

---

## 3. 구현 설계 (해석 A 기준)

### 3.1 UI

상품 마스터 toolbar 에 신규 버튼 추가:
- `🚚 DTS 일괄 변경 (<count>)` — 선택된 row 의 DTS 를 모달에서 입력받아 일괄 적용

모달 (Shopee 가격 modal 과 유사):
```
[ DTS 일괄 변경 ]
선택된 상품: N개

새 DTS (일수): [___] (범위: <cat_min>-<cat_max>, get_global_item_limit 으로 확인)
pre-order 여부: [✓ pre-order]  [  ready-stock(즉시 출고)]

전체 region 동시 적용됨 (KRSC 제약, shop 별 다른 값 불가)

[취소]  [적용]
```

### 3.2 Bridge action

기존 `shopee-bridge` 에 새 action 추가:

```typescript
if (action === 'update_global_dts' && req.method === 'POST') {
  const body = await req.json();
  const global_item_id = parseInt(body.global_item_id);
  const days_to_ship = parseInt(body.days_to_ship);
  const is_pre_order = !!body.is_pre_order;
  if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
  if (!Number.isFinite(days_to_ship) || days_to_ship < 1) {
    return jsonResp({ ok: false, error: 'days_to_ship must be positive integer' }, 400);
  }
  // update_global_item with pre_order field set
  const result = await merchantApiCall(region, '/api/v2/global_product/update_global_item', {
    method: 'POST',
    body: { 
      global_item_id, 
      pre_order: { is_pre_order, days_to_ship }
    }
  });
  return jsonResp({ ok: !result.error, region, global_item_id, days_to_ship, is_pre_order, result });
}
```

(선택) `category_dts_limit` action 추가 — 사용자가 입력한 DTS 가 카테고리 범위 안인지 사전 확인:
```typescript
if (action === 'category_dts_limit') {
  const category_id = parseInt(url.searchParams.get('category_id') || '0');
  if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
  const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_limit', {
    query: { category_id }
  });
  return jsonResp({ ok: !result.error, region, category_id, result });
}
```

### 3.3 Dashboard client (`_dtsBulkUpdate`)

```js
async function _dtsBulkUpdate() {
  const selected = _getSelectedMasterRows();
  if (!selected.length) return;
  // Group by global_item_id (avoid duplicate API calls for same parent)
  const uniqueGlobalIds = [...new Set(selected.map(r => r.shopee_item_id).filter(Boolean))];
  if (!uniqueGlobalIds.length) {
    alert('선택된 상품에 global_item_id 가 없습니다.');
    return;
  }
  // Modal: ask user for days_to_ship + pre_order flag
  const dts = parseInt(prompt(`${uniqueGlobalIds.length}개 global product 의 DTS 를 변경합니다.\n새 DTS (일수, 1-30):`, '5'));
  if (!Number.isFinite(dts) || dts < 1 || dts > 30) {
    alert('유효한 일수 (1-30) 를 입력해주세요.');
    return;
  }
  const isPreOrder = confirm('Pre-order 로 설정할까요? (취소 = ready stock)');
  
  // Parallel 5 calls
  const headers = { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  let ok = 0, fail = 0;
  const errors = [];
  const PARALLELISM = 5;
  for (let i = 0; i < uniqueGlobalIds.length; i += PARALLELISM) {
    const chunk = uniqueGlobalIds.slice(i, i + PARALLELISM);
    const results = await Promise.allSettled(chunk.map(async (gid) => {
      const r = await fetch(`${SHOPEE_BRIDGE}/update_global_dts`, {
        method: 'POST', headers,
        body: JSON.stringify({ global_item_id: parseInt(gid), days_to_ship: dts, is_pre_order: isPreOrder }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(`gid=${gid}: ${j.error || j.result?.error || 'unknown'}`);
      return { gid, ok: true };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else { fail++; errors.push(r.reason.message); }
    }
  }
  alert(`DTS 변경: ${ok}개 성공 / ${fail}개 실패\n${errors.slice(0, 5).join('\n')}`);
  // Optionally: persist to product_shopee_listings.days_to_ship for tracking
  // (이미 컬럼 존재, 자동 매핑 같은 패턴으로)
}
```

### 3.4 DB 추적 (선택사항)

`product_shopee_listings` 에 이미 `days_to_ship integer` 컬럼 존재 (Phase 1 mapping 에서 도입됨).
- DTS 업데이트 성공 시 해당 product 의 모든 region listing 의 `days_to_ship` 컬럼 갱신
- 또는 `products` 테이블에 `default_days_to_ship` 컬럼 추가 (단일 source of truth)

추천: `products.default_days_to_ship` (단일 컬럼) — 어차피 KRSC 제약상 region 별 다른 값 불가능하므로.

---

## 4. 위험 & mitigation

| 리스크 | 완화 |
|--------|------|
| 사용자가 너무 짧거나 긴 DTS 입력 → API reject | 입력 범위 1-30 제한 (UI), `get_global_item_limit` 로 카테고리 범위 사전 확인 |
| pre_order 토글 잘못 → ready_stock 상품이 pre_order 가 되거나 반대 | confirm dialog + 명시적 라벨. 향후 row 별 `lifecycle_state` 자동 반영 (lifecycle='ready_stock' → is_pre_order=false 강제) |
| 같은 global_item_id 가 N row 에 걸쳐있을 때 N번 호출 | uniqueGlobalIds 로 dedupe (이미 plan 에 포함) |
| update_global_item 실패 (잘못된 카테고리 등) → 일부 변경, 일부 실패 | Promise.allSettled + 실패 목록 표시. 자동 rollback 없음. |
| Shopee API rate limit | merchant API 1000/min, 5 parallel × 1.5s 평균 → 한 batch 최대 약 200/min — 안전 |
| KRSC 셀러가 model-level DTS 권한 없음 (`error_auth: Your shop can not use model level dts`) | update_global_item 만 사용, update_global_model 안 씀 — 영향 없음 |

---

## 5. 검증 시나리오

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | 단일 row 선택 → DTS=7 → 적용 | 1 API 호출, 모든 region 의 DTS=7 |
| 2 | 변형 상품 5 row 선택 (같은 parent) → DTS=10 | 1 API 호출 (dedupe), 모든 region 의 DTS=10, 모든 model 동일 |
| 3 | 단일+변형 혼합 10 row, 4개 unique global_items 선택 → DTS=5 | 4 API 호출 (parallel 5 이하라 1 chunk), 모두 DTS=5 |
| 4 | DTS=0 입력 | UI validation reject |
| 5 | DTS=999 입력 | UI validation reject (>30) |
| 6 | 같은 작업 두 번 연속 → idempotent | 2번째도 성공, 결과 동일 (Shopee API 가 idempotent) |
| 7 | 카테고리 dts_limit 보다 큰 값 (UI validation 우회 시) | API 가 reject, 사용자에게 명확한 에러 |
| 8 | pre-order=false + DTS=10 | ready_stock 상품으로 설정. is_pre_order=false 가 의미 있는지 Shopee 동작 확인 필요 |

---

## 6. Out of scope (해석 B 가 필요해지면)

만약 사용자가 **region 별 다른 DTS** 를 원한다면:
1. set_sync_field 로 해당 shop 의 days_to_ship sync OFF
2. shop-level `product.update_item` 으로 region 별 DTS 설정
3. **KRSC 차단** → Shopee 영업 통해 권한 신청 필요 (또는 Seller Center UI 수동 편집)

이 경로는 별도 plan 으로 분리.

---

## 7. 작업량 추정

- Bridge action 추가: ~30 라인 (1 action, optional second action for limit)
- Dashboard `_dtsBulkUpdate` + UI 버튼 + 모달: ~80 라인
- DB column 추가 (`products.default_days_to_ship`) — migration 5 라인
- 검증: 위 8 시나리오
- **총: 0.5일 (4시간) 추정**

---

## 8. 결정 필요 사항

사용자 답변 부탁드립니다:

1. **해석 A 맞나요?** 모든 region 에 같은 DTS 일괄 적용 (한 번에 모두 7일 등). 가장 흔한 케이스.
2. 만약 해석 B (region 별 다른 DTS) 였다면, KRSC 제약 surface — Shopee 영업 통해 권한 신청 필요한지 결정 필요.
3. **UI 형태**: simple prompt() 시작 (위 plan) vs 정식 modal (Shopee 가격 modal 같은 디자인)?
4. **DB 추적**: `products.default_days_to_ship` 컬럼 추가 OK? (단순 audit 용)
5. **Pre-order 토글**: confirm() 으로 충분 vs lifecycle_state 자동 매핑 (ready_stock=false, pre_order=true)?
