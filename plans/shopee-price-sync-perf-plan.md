# Shopee 상품 로딩 + 가격 수정 Perf 분석 + 단축안

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-16 |
| Target | shopee-dashboard — `index.html` (preflight) + 별도 검토 (spreadsheet 옵션) |
| Trigger | User: "상품을 불러오고 상품 가격을 수정하는 과정에서 약 2~3분 이상 소요" |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\` 공식 문서 검증 |

---

## 0. 결론 요약 (TL;DR)

**원인:** `_shopeeBulkSync` 의 `_preflightShopeePriceTargets` 가 **순차** `for...await` 로 region/item 마다 `get_model_list` 를 1.5초씩 호출. 17개 상품 × 6 region = 102 sequential calls × 1.5s = **약 2.5분**.

**스프레드시트 가설 평가:** Shopee API roundtrip 자체가 병목이라 **DB 저장 위치(Supabase ↔ 스프레드시트)는 거의 영향 없음**. 우리 products 테이블 17 rows = Supabase load < 1초. 진짜 perf 손실은 Shopee API call 횟수 + 직렬화. 스프레드시트는 perf 보다 백업/audit 용으로 더 적합 (#6 별도 검토).

**진짜 단축안 (ROI 순):**
1. **Preflight 병렬화** (concurrency 5) — 1줄 변경, 80% 단축 (2.5분 → 30초)
2. **Mapped 상품 preflight 스킵** — DB 의 `status='mapped'` 신뢰, validation call 생략. 100% 단축 (mapped 비율만큼)
3. **Local cache (Supabase side)** — `product_shopee_listings` 에 `shop_model_validated_at` 추가, 1h TTL — 2회차 sync 시 모두 cache hit
4. **Spreadsheet sync target** — 백업/audit 용. perf 직접 영향 적음. #6 에서 별도 검토

---

## 1. 측정 기반 진단 (코드 정독)

### 1.1 Storage.loadAll (`index.html:1507`) — 로딩 단계

```js
await Promise.all([
  db.from('products').select('*').order(...),          // 17 rows
  db.from('country_settings').select('*'),              // 7 rows
  db.from('product_shopee_listings').select('*'),       // 55 rows
  db.from('inventory').select('sku').not('bundle_components', 'is', null),  // ~1073 rows max
]);
```

- 모두 병렬, Supabase 단일 region (ap-northeast-2), 단순 SELECT
- 데이터량 작아서 **< 1초 예상**
- → "로딩" 자체는 병목 아님

### 1.2 `_shopeeUpdatePrices` (단일 row 가격 수정, `index.html:2467`)

흐름:
1. UI 에서 targets 수집 (region 당 1개) — 즉시
2. `_joomAuthHeaders()` — 캐시되어 있을 가능성, 빠름
3. **`_preflightShopeePriceTargets(targets, headers)`** ← 병목
4. `Promise.all` 로 `update_price` 호출 — 병렬, 빠름

단일 row = 최대 6 region = 6 sequential preflight calls × 1.5s = **약 9초**. 1개 row 라면 사용자가 체감 가능.

### 1.3 `_shopeeBulkSync` (벌크 가격 수정, `index.html:2721`) — 핵심 병목

선택된 N 행에 대해:
1. **N × 6 region 의 targets 빌드** (DB 데이터 사용, 즉시)
2. `_buildShopeeSkuTargets(selectedRows, headers)` — 추가 SKU sync targets
3. **`_preflightShopeePriceTargets(targets, headers)`** ← **핵심 병목**
4. `Promise.allSettled` 로 `update_price` 호출 — 병렬

### 1.4 `_preflightShopeePriceTargets` (`index.html:2426`) — 진짜 범인

```js
async function _preflightShopeePriceTargets(targets, headers) {
  const cache = new Map();
  const valid = [];
  const blocked = [];

  for (const t of targets) {           // ← 순차 for
    // ...
    if (!info) {
      info = await _fetchShopeeModelIndex(t.region, item_id, headers);  // ← 1.5s sequential
      cache.set(cacheKey, info);
    }
    // validation logic
  }
  return { valid, blocked };
}
```

**문제점:**
- `for...of + await` 패턴 → 완전 순차 실행
- `cache` 가 region:item_id 중복은 막지만 첫 hit 은 항상 sequential
- N 개 행 × 6 region 의 unique (region, item_id) 가 모두 sequential

**Bridge 측 `_fetchShopeeModelIndex` → `/raw_call?path=/api/v2/product/get_model_list`**:
- Shopee API `get_model_list` 는 **per-item_id only** (batch 미지원, 공식 문서 `product/v2.product.get_model_list.json` 확인)
- merchant API → 각 region 의 shop token 으로 호출, network latency + Shopee 응답 1-2s 전형적

### 1.5 `_shopeeSyncFetchRegion` (매핑 동기화, `index.html:3052`) — 별도 슬로우 경로

```js
const [rNormal, rUnlist] = await Promise.all([
  fetch(SHOPEE_BRIDGE + '/list_items?region=' + region + '&item_status=NORMAL&max_items=2000', ...),
  fetch(SHOPEE_BRIDGE + '/list_items?region=' + region + '&item_status=UNLIST&max_items=2000', ...),
]);
```

- 사용자가 "Shopee 매핑 동기화" 버튼 누를 때만 호출
- KRSC 셀러 starphotocard 가 region 당 수천 items 등록되어 있으면 bridge 가 pagination 수십 번 + Shopee 응답 5-30s
- 6 region 병렬이라 가장 느린 region 의 시간 (보통 SG/BR 큰 카탈로그)
- 사용자의 **새 자동 매핑 (commit 925164f)** 이 이 sync 를 거의 불필요하게 만듦. 신규 추가는 `_gkpApply` 안에서 매핑되므로 더 이상 `_shopeeSyncFetchRegion` 호출할 일이 줄어듦.

### 1.6 측정 추정 (17 products, 모두 variant)

| 단계 | 시간 추정 | 비고 |
|------|----------|------|
| `Storage.loadAll` | <1s | DB 4 query 병렬 |
| `_buildShopeeSkuTargets` | 5-10s | per row Shopee API 호출, 일부 sequential |
| **`_preflightShopeePriceTargets`** | **~150s (2.5분)** | 17 × 6 = 102 unique (region,item) × 1.5s 순차 |
| `update_price` 병렬 | 3-5s | Promise.allSettled, 각 region 1-2s |
| **총** | **~165s ≈ 2분 45초** | 사용자 체감 "2~3분" 정확히 일치 |

---

## 2. 단축 옵션 분석 (ROI 순)

### 옵션 A: Preflight 병렬화 (concurrency 5) ★ 최우선

```js
// before (sequential)
for (const t of targets) {
  const cacheKey = `${t.region}:${item_id}`;
  let info = cache.get(cacheKey);
  if (!info) {
    info = await _fetchShopeeModelIndex(t.region, item_id, headers);
    cache.set(cacheKey, info);
  }
  // ...
}

// after (parallel with concurrency limit)
const uniqueKeys = [...new Set(targets.map(t => `${t.region}:${parseInt(t.item_id)}`))];
const cache = new Map();
const PARALLELISM = 5;
for (let i = 0; i < uniqueKeys.length; i += PARALLELISM) {
  const chunk = uniqueKeys.slice(i, i + PARALLELISM);
  await Promise.all(chunk.map(async (k) => {
    const [region, item_id_str] = k.split(':');
    const info = await _fetchShopeeModelIndex(region, parseInt(item_id_str), headers);
    cache.set(k, info);
  }));
}
// then normal sequential validation loop using cache (now all hits)
```

- **단축**: 102 × 1.5s 순차 → 102/5 × 1.5s ≈ 30s. **80% 감소**.
- **변경 라인**: ~15줄
- **위험도**: 낮음 (cache 결과 그대로 사용, 로직 동일)
- **Shopee API rate limit**: shop API 10000/day per shop, concurrency 5 안전권

### 옵션 B: Mapped 상품 preflight 스킵 ★ 매우 강력

신규 자동 매핑 (commit 925164f) 으로 `status='mapped'` 인 listing 은 **DB 가 source of truth**. preflight 의 validation 은:
- `hasModel ↔ model_id 존재 여부` 일치 확인
- `model_id ∈ modelIds set` 확인

이 두 가지를 DB 가 이미 검증 후 저장했으므로, `status='mapped'` 면 신뢰 가능. validation skip.

```js
async function _preflightShopeePriceTargets(targets, headers) {
  // separate trusted vs needs-validation
  const trusted = [];
  const needsValidation = [];
  for (const t of targets) {
    const listing = t._listing || (t.row?.shopeeListings || {})[t.region];
    if (listing?.status === 'mapped' && /* shop_model_id 일치 */) {
      trusted.push({ ...t, _priceNormalized: ... });
    } else {
      needsValidation.push(t);
    }
  }
  // only validate untrusted ones (옵션 A 와 함께 사용)
}
```

- **단축**: mapped 비율만큼. 모든 상품이 자동 매핑 된 경우 → preflight 0초.
- **변경 라인**: ~25줄 (target 데이터 구조에 listing 참조 추가)
- **위험도**: 약간. mapped 가 stale 한 경우 (Shopee 측에서 SKU 변경) 잘못된 model_id 로 update_price 실패 → API 가 reject. 명시적 에러로 catch 가능, silent corruption 없음.
- **Mitigation**: `last_synced_at` 기준 TTL 6h, 그 이상이면 untrusted 처리.

### 옵션 C: `product_shopee_listings.shop_model_validated_at` + Local cache

`product_shopee_listings` 에 `shop_model_validated_at TIMESTAMPTZ` 추가. preflight 시 6h 이내 validated 면 trusted.

- **단축**: 첫 validation 후 6h 동안 0초
- **변경 라인**: migration + bridge + preflight 로직 → 50+ 줄
- **위험도**: 낮음 (TTL 보호)
- **Spreadsheet 와 동일 개념을 Supabase 안에서 구현** — DB 가 이미 source of truth 이므로 별도 시트 없이 동일 효과

### 옵션 D: Spreadsheet 백업 사용 (사용자 가설)

가설: Shopee data 를 Google Sheets 같은 외부 저장소에 미리 저장 → 거기서 로드 → 더 빠름.

**현실:**
- 우리 perf 손실은 Supabase loadAll (< 1s) 이 아니라 Shopee API roundtrip
- 스프레드시트 to load 는 Google Sheets API 자체가 2-5s latency → 더 느림 (Supabase 보다 느림)
- 단, **Shopee state 의 cold storage** 로는 유용 (#6 에서 별도 검토):
  - 일일 cron 으로 spreadsheet 동기화 → 사람이 직접 확인/audit
  - DB 가 망가지면 rebuild 소스
  - perf 가 아닌 안정성 목적

**판정**: perf 단축 목적으론 효과 적음. 사용자가 만약 "다른 곳에서 검증/수동 편집 가능" 을 원한다면 #6 의 다른 형태로 진행.

### 옵션 E: Shopee API batch 활용 (구조적 검토)

공식 문서 확인 결과:
- `get_model_list`: per-item_id only, batch 없음 ✗
- `get_item_base_info`: `item_id_list` 배열 받음 ✓ (단, base info 만)
- `update_price`: per-item_id, model 만 batch ✗

**모델 정보 일괄 조회 API 없음** → 우리가 할 수 있는 batch 화는 제한적. 옵션 A (병렬화) 가 사실상 최대.

---

## 3. 추천 단계 (구현 순서, 별도 PR)

**v1 (이번에 즉시 적용 가능, 단일 라인 수준 위험):**
- 옵션 A 만 단독 적용. 80% 단축. 검증 쉬움.

**v2 (다음 sprint):**
- 옵션 B 추가. 자동 매핑된 신규 상품들은 preflight 완전 스킵.
- `last_synced_at < 6h` 조건 추가 (TTL 가드).

**v3 (장기, 필요 시):**
- 옵션 C 의 명시적 `shop_model_validated_at` 컬럼 추가.
- Background cron 으로 stale validation 자동 refresh.

**Spreadsheet (#6 별도 보고):**
- perf 보다 backup/audit 목적.
- Google Sheets API 활용 cron 동기화.

---

## 4. 위험과 완화

| 리스크 | 완화 |
|--------|------|
| 옵션 A 병렬 5 → rate limit 도달 | shop API 10000/day per shop. 한 sync 작업 = 100여 call. 일일 100회 sync 도 안전. 모니터링 필요시 audit log 추가. |
| 옵션 B 의 stale mapped → wrong model_id update | Shopee API 가 `model_id not found` 로 reject → t.statusEl 에 ✕ + 사용자 알림. silent corruption 없음. |
| Cache 결과가 sync 중 stale | 단일 sync 작업 내 cache 만. 다음 sync 는 fresh. |
| Preflight 병렬 → 일시 메모리/CPU 증가 | concurrency 5 = 동시 5 fetch. 매우 가벼움. |

---

## 5. 검증 시나리오

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | 17 products 모두 선택 → 벌크 sync (현재) | 2-3분 소요 (baseline) |
| 2 | 옵션 A 적용 후 동일 작업 | 25-35초 소요 (~80% 단축) |
| 3 | 옵션 B 적용 후 동일 (모두 mapped 상품) | < 10초 (preflight skip, update_price 만) |
| 4 | 일부러 잘못된 model_id 강제 → mapped sync | update_price 실패 → 에러 표시, DB 데이터 변경 없음 |
| 5 | Rate limit 헤더 모니터 | 5 concurrent 시 throttle 응답 없음 확인 |

---

## 6. Out of scope

- Storage.loadAll 자체 최적화 — 이미 < 1s
- `_shopeeBulkSync` 의 SKU sync 부분 (`_buildShopeeSkuTargets`) — 별도 PR
- `_shopeeSyncFetchRegion` (매핑 sync) — 자동 매핑 (925164f) 로 사용 빈도 격감, 별도 처리
- Spreadsheet 통합 — #6 별도 보고

---

## 7. 작업량 추정

| 옵션 | 라인 변경 | 시간 추정 |
|------|----------|----------|
| A | ~15 | 30분 (구현+테스트) |
| B | ~25 + 데이터 흐름 점검 | 1시간 |
| C | migration + bridge + client = ~80 | 3시간 |

→ v1 (옵션 A 만) 만 즉시 시작 가능. 사용자 승인 후 구현.
