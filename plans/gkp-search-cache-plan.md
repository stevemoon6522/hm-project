# GKP Keyword Search — Persistent Cache + Background Prefetch

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-15 |
| Target | shopee-dashboard — `index.html` (single file) |
| Trigger | User report: "상품 검색에서 키워드 검색 시에 매우 오랜 시간이 소요" |
| Approach | Option A (localStorage 영구 캐시) + Option B (백그라운드 prefetch) |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\get_global_item_list.json` (no server-side keyword filter; only `update_time_from/to` + offset/page_size 50) |

---

## 0. Why this is slow (root cause, confirmed)

`🔍 상품 검색` 모달 (`#keyword-price-open` 버튼, line 791) 의 검색 흐름:

1. **Phase 1 — list:** `_gkpFetchAllGlobalItems()` (line 5475) 가 `/global_items?page_size=50` 을 offset 기반 순차 호출. 키워드와 무관하게 전체 카탈로그의 `global_item_id` 만 받음. Shopee 공식 API 가 list 단계에서 name/sku 를 안 줌(`get_global_item_list` 응답: `global_item_id`, `update_time`, `total_count`, `has_next_page`, `offset` only).
2. **Phase 2 — enrich:** `_gkpEnrichItemsComplete()` (line 5576) 가 `/global_item_info` 를 50개 batch 단위로 순차 await. 여기서 처음으로 `item_name`, `item_sku`, `has_model` 가 채워짐.
3. **Phase 3 — filter:** `_gkpFilter()` 가 클라이언트 사이드로 keyword 매칭.
4. **Phase 4 — model fetch:** matched item 중 `has_model=true` 인 것만 `/global_model_list` 추가 호출.

세션 메모리 캐시 `_gkpEnrichedCache` (line 5473) 는 모달이 열려있는 동안만 유효. 페이지 새로고침/탭 닫음/다음날 접속 → 캐시 소실 → Phase 1+2 전체 재실행. Shopee API 가 keyword 서버 검색을 지원하지 않으므로 **첫 검색은 구조적으로 "전체 카탈로그 다운로드" 시간 = 수십초~분 단위** 가 들 수밖에 없음.

→ 해결책: Phase 1+2 결과를 **localStorage 에 영구 캐시 + 페이지 진입 시 백그라운드 prefetch** 로 옮긴다. 사용자가 모달을 여는 시점엔 이미 enriched 데이터가 메모리에 있어 즉시 검색.

---

## 1. Scope

### In scope
- `index.html` 내부 GKP 모듈 (line 5460–5934 GLOBAL SKU BULK PRICE UPDATE 섹션) 만 수정.
- localStorage 키 `gkp_enriched_cache_v1` 에 `{ items, fetchedAt, fallbackMode, schemaVersion }` 저장.
- 페이지 로드 시 백그라운드 prefetch (idle 시점, 메인 데이터 로드 완료 후).
- Stale-while-revalidate 패턴: cache 가 TTL(24h) 초과해도 즉시 사용하고, 백그라운드로 새로고침.
- 사용자가 "🔍 상품 검색" 모달을 열 때, 캐시가 있으면 메모리에 hydrate 만 하고 즉시 검색 가능 상태로.
- Cache 용량 초과(QuotaExceededError) 시 graceful fallback (캐시 없이 동작, 콘솔 경고).

### Out of scope (이번 PR 아님)
- **Delta sync** (`update_time_from` 으로 변경분만 받기) — 코드는 이미 bridge 가 지원하므로 follow-up 으로 1주 내 추가 가능. 이번 PR 은 단순 full-cache 로 가서 검증부터 한다.
- **Supabase 캐시 테이블** (option D) — 모든 직원 기기 공유. 이 방향은 별도 plan.
- 모델 정보(`global_model_list`) 캐싱 — 현재 구조상 filtered item 만 lazy 로 받으므로 영향 작음. 후속 과제.
- Enrich 병렬화 (option C) — 캐시가 효과 보면 불필요해짐.

---

## 2. Data model

### localStorage entry

```json
{
  "schemaVersion": 1,
  "items": [
    { "type": "item" | "model_header", "global_item_id": 12345, "item_name": "...", "item_sku": "...", "price": "...", "models": [] }
  ],
  "fetchedAt": 1715800000000,
  "fallbackMode": false
}
```

- `schemaVersion: 1` — 미래에 구조 바꾸면 bump. 미스매치 = null 처리(=캐시 없음).
- `items` 는 현재 `_gkpEnrichItemsComplete()` 의 return 값 그대로. `models` 는 항상 빈 배열 (lazy).
- `fetchedAt` — epoch ms.
- `fallbackMode` — bridge 가 fallback path 로 갔는지 여부 (현재 의미 보존).

### 상수

```js
const GKP_CACHE_KEY = 'gkp_enriched_cache_v1';
const GKP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GKP_PREFETCH_DELAY_MS = 5000; // wait 5s after dashboard load before prefetching
```

---

## 3. Implementation steps

### Step 1: Helper functions (새로 추가, 5474 라인 근처)

```js
function _gkpLoadPersistedCache() {
  try {
    const raw = localStorage.getItem(GKP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch (e) {
    console.warn('[gkp] cache load failed:', e);
    return null;
  }
}

function _gkpSavePersistedCache(items, fallbackMode) {
  try {
    const payload = { schemaVersion: 1, items, fetchedAt: Date.now(), fallbackMode };
    localStorage.setItem(GKP_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    // QuotaExceededError or storage disabled — caller continues without persistence
    console.warn('[gkp] cache save failed:', e);
  }
}

function _gkpCacheIsFresh(cache) {
  if (!cache || !cache.fetchedAt) return false;
  return (Date.now() - cache.fetchedAt) < GKP_CACHE_TTL_MS;
}
```

### Step 2: Initial hydrate from localStorage (모듈 로드 시)

`_gkpEnrichedCache` 를 모듈 진입 시 즉시 hydrate:

```js
// before: let _gkpEnrichedCache = { items: [], fetchedAt: 0, fallbackMode: false };
// after:
let _gkpEnrichedCache = _gkpLoadPersistedCache() || { items: [], fetchedAt: 0, fallbackMode: false };
```

이 시점부터 메모리 캐시 = localStorage 캐시 (있으면).

### Step 3: 백그라운드 prefetch 함수 + 트리거

```js
let _gkpPrefetchInFlight = false;

async function _gkpBackgroundPrefetch({ force = false } = {}) {
  if (_gkpPrefetchInFlight) return;
  const cache = _gkpEnrichedCache;
  if (!force && _gkpCacheIsFresh(cache) && cache.items.length > 0) return;
  _gkpPrefetchInFlight = true;
  // silent statusEl shim — does not touch any visible UI
  const silentEl = { set textContent(_v) {} };
  try {
    let items, fallbackMode = false;
    try {
      const allGlobal = await _gkpFetchAllGlobalItems(silentEl);
      items = await _gkpEnrichItemsComplete(allGlobal, silentEl);
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (!/global_items 오류|product\.error_unknown|invalid_access_token|invalid_acceess_token/i.test(msg)) {
        console.warn('[gkp] prefetch failed:', e);
        return;
      }
      fallbackMode = true;
      items = await _gkpFetchShopItemsFallback(silentEl);
    }
    _gkpEnrichedCache = { items, fetchedAt: Date.now(), fallbackMode };
    _gkpSavePersistedCache(items, fallbackMode);
    console.log(`[gkp] prefetch done: ${items.length} items (fallback=${fallbackMode})`);
  } finally {
    _gkpPrefetchInFlight = false;
  }
}
```

페이지 로드 트리거 (대시보드 init 끝 부분 근처):

```js
// kick off after main UI is ready, low priority
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => _gkpBackgroundPrefetch(), { timeout: GKP_PREFETCH_DELAY_MS + 5000 });
} else {
  setTimeout(() => _gkpBackgroundPrefetch(), GKP_PREFETCH_DELAY_MS);
}
```

> 트리거 위치는 `init()` IIFE 안 — 정확한 line 은 implementation 시 결정. 단 사용자 인증/주요 데이터 로드 끝난 다음.

### Step 4: 검색 버튼 핸들러 수정 (line 5860 부근)

핵심 변경: `cacheValid` 판정을 단순 `length > 0` 에서 → `_gkpCacheIsFresh()` 기반 stale-while-revalidate 로.

```js
const cache = _gkpEnrichedCache;
const cacheValid = cache.items.length > 0; // 기존과 같음 — stale 도 즉시 사용
const cacheStale = cacheValid && !_gkpCacheIsFresh(cache);

if (cacheValid) {
  enriched = cache.items;
  fallbackMode = cache.fallbackMode;
  const tag = cacheStale ? '캐시 사용 (만료, 백그라운드 갱신 중)' : '캐시 사용';
  statusEl.textContent = `${tag} · ${enriched.length}건 · "${keyword || '(필터없음)'}" 필터 적용 중…`;
  if (cacheStale) {
    // fire-and-forget background refresh; doesn't block this search
    _gkpBackgroundPrefetch({ force: true });
  }
} else {
  // 기존 로직 그대로 (full fetch + enrich + 저장)
  try {
    const allGlobal = await _gkpFetchAllGlobalItems(statusEl);
    statusEl.textContent = `전체 ${allGlobal.length}건 로드. 상품 정보 조회 중…`;
    enriched = await _gkpEnrichItemsComplete(allGlobal, statusEl);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (!/global_items 오류|product\.error_unknown|invalid_access_token|invalid_acceess_token/i.test(msg)) throw e;
    fallbackMode = true;
    enriched = await _gkpFetchShopItemsFallback(statusEl);
  }
  _gkpEnrichedCache = { items: enriched, fetchedAt: Date.now(), fallbackMode };
  _gkpSavePersistedCache(enriched, fallbackMode); // ← 추가
}
```

나머지 코드(필터, 모델 fetch, 렌더) 는 변경 없음.

### Step 5: (선택) 수동 캐시 새로고침 UI

모달 안에 작은 "🔄 캐시 새로고침" 버튼 추가 — 클릭 시 `_gkpBackgroundPrefetch({ force: true })` 호출 후 statusEl 에 진행상황 표시. **이번 PR 에서 추가할지는 implementer 판단**, 안 해도 24h TTL + stale-while-revalidate 로 자동 갱신됨.

---

## 4. Verification (success criteria)

각 단계 후 `https://shopee-dashboard-kohl.vercel.app/` (또는 로컬 file://) 에서 직접 확인:

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | localStorage 비운 상태에서 페이지 로드 → 5–10s 대기 | DevTools Network 탭에 `/global_items` + `/global_item_info` 요청 다수 → 종료 후 `localStorage.getItem('gkp_enriched_cache_v1')` 가 `items.length > 0` 인 객체 |
| 2 | (1) 다음 모달 열고 키워드 입력 → 검색 클릭 | Network 탭에 `/global_items` 호출 **0건**. 즉시 결과 표시. statusEl 에 "캐시 사용 · N건…" |
| 3 | localStorage 의 `fetchedAt` 을 25h 전으로 수동 수정 → 검색 | 결과 즉시 표시 + statusEl 에 "(만료, 백그라운드 갱신 중)" + Network 에 백그라운드 fetch 시작. 갱신 끝나면 다음 검색은 fresh tag |
| 4 | localStorage 비우고 모달만 즉시 열고 검색 (prefetch 트리거 전) | 기존 동작과 동일 (전체 fetch). 끝나면 캐시 저장됨 |
| 5 | localStorage 에 깨진 JSON 강제 주입 → 페이지 로드 | console warn `[gkp] cache load failed` + 기존 동작 (캐시 없음 모드) |
| 6 | localStorage 5MB 가까이 채워서 quota 초과 시뮬레이트 | console warn `[gkp] cache save failed` + 검색 자체는 정상 동작 |
| 7 | 카탈로그가 매우 큰 경우 (수천 items, JSON 1MB+) | 저장 성공 (Chrome localStorage 평균 5MB+) → 다음 로드 시 hydrate 시간 < 100ms |

### Regression 체크
- 일반 상품 검색(`#search` input, `els.search.addEventListener('input', renderProducts)`) 와 무관 → 영향 없음
- v2 wizard (`v2/index.html`) 와 무관 → 영향 없음
- 기존 `_gkpFetchShopItemsFallback`, `_gkpEnsureModelsForItems`, `_gkpRenderResults` 로직 변경 없음

---

## 5. Risks & mitigations

| 리스크 | 완화 |
|--------|------|
| Stale 데이터로 사용자가 잘못된 결정 | statusEl 에 "(만료, 갱신 중)" 표시 + 백그라운드로 항상 새로고침. 24h TTL 내에서만 stale, 그 이상은 즉시 갱신 트리거. |
| Multi-tab 환경에서 두 탭이 동시에 prefetch | `_gkpPrefetchInFlight` 는 탭 단위. 같은 사용자 두 탭이 동시에 다 fetch 해도 서로 덮어쓰기만 하고 데이터는 동일. 비용은 최대 2배 fetch — 허용 가능. (후속 과제: BroadcastChannel 로 잠금) |
| QuotaExceededError | try/catch 로 swallow + console warn. 검색 동작은 정상. |
| `models: []` 가 캐시 안에 있어도 detail 부족 | 현재 캐시되는 enriched 도 models 빈 상태. lazy fetch 는 `_gkpEnsureModelsForItems` 가 변함없이 처리. 동일한 동작. |
| Schema 변경 시 옛 캐시 hit | `schemaVersion` 미스매치면 null 반환 → 새로 fetch. |
| 사용자가 SG 외 region 으로 검색 | 현재 코드는 `region=SG` 하드코딩. 캐시 키도 SG 전용. region 다중화는 별도 과제. |
| Catalog 가 5MB+ 라 localStorage 초과 | console warn 후 메모리 캐시만 사용 (현재 동작과 동일). 후속 과제: IndexedDB 로 이전 (option D 와 같이). |

---

## 6. Out-of-scope follow-ups (별도 PR)

1. **Delta sync** — `_gkpBackgroundPrefetch({ force: true })` 가 `update_time_from = 마지막 fetchedAt - 1h` 로 변경분만 받아서 merge. Bridge `global_items` 가 이미 지원.
2. **수동 새로고침 버튼** — UI 차원에서 사용자가 강제 새로고침 가능.
3. **Region 별 캐시** — `gkp_enriched_cache_v1_SG` / `_TW` 등.
4. **Supabase 공유 캐시** — 모든 직원 기기 공유. cron 으로 갱신.
5. **IndexedDB 이전** — localStorage 5MB 한도 우려 시.

---

## 7. Estimated effort

- 코드 변경: index.html 한 파일에 ~80 라인 추가/수정
- 검증: 위 7개 시나리오 직접 브라우저 테스트
- 총 1–2시간 (Sonnet 작업 + 메인 검토)

---

## 8. Revision (Codex adversarial review, 2026-05-15)

Codex 가 적대적 리뷰에서 7개 이슈를 제기. 메인 세션이 코드/문서 검증 후 다음과 같이 반영.

### 8.1 채택 (수정 필수)

**R1. modal-open 핸들러가 캐시를 리셋함 (Codex #1)** — `index.html:5848` 에서 `openBtn.click` 마다 `_gkpEnrichedCache = { items: [], ... }` 로 강제 초기화. Step 2 의 module-init hydrate 가 이 라인 때문에 무력화됨. **이 라인을 제거**해야 함. UI 상태 리셋(`_gkpRows`, `_gkpEnrichedFiltered`, `_gkpExpanded`, results-wrap, status, results-body, keyword input) 은 그대로 두되, `_gkpEnrichedCache` 만 보존. → Step 2 에 명시 추가.

**R2. Multi-tab last-writer-wins (Codex #2)** — 두 탭이 동시에 prefetch 끝나면 더 오래된 fetch 가 더 새로운 fetch 를 덮어쓸 수 있음. **저장 직전 localStorage 의 `fetchedAt` 을 다시 읽어 "내가 쓰려는 fetchedAt 이 더 크거나 같을 때만" 저장**. BroadcastChannel/lease 같은 무거운 잠금은 **불채택** — 두 탭이 거의 동시에 끝나는 케이스에서 데이터는 어차피 같음. → `_gkpSavePersistedCache` 에 timestamp guard 추가:

```js
function _gkpSavePersistedCache(items, fallbackMode) {
  try {
    const now = Date.now();
    const existingRaw = localStorage.getItem(GKP_CACHE_KEY);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw);
        if (existing && Number(existing.fetchedAt) > now) return; // someone wrote a newer one
      } catch (_) { /* corrupted, overwrite */ }
    }
    const payload = { schemaVersion: 1, items, fetchedAt: now, fallbackMode };
    localStorage.setItem(GKP_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('[gkp] cache save failed:', e);
  }
}
```

**R3. Prefetch + 사용자 검색 동시 발생 시 중복 fetch (Codex #3)** — Stale 분기에서 `_gkpBackgroundPrefetch({ force: true })` 가 fire-and-forget 되는데 사용자가 이어서 캐시 비운 상태로 검색하면 양쪽이 같은 작업을 또 함. **공유 in-flight Promise 도입**: prefetch 가 이미 진행 중이면 (`_gkpPrefetchInFlight`) 사용자 검색은 그 Promise 를 await 한 뒤 결과를 사용. → 새 변수 `_gkpPrefetchPromise` 도입:

```js
let _gkpPrefetchInFlight = false;
let _gkpPrefetchPromise = null;

async function _gkpBackgroundPrefetch({ force = false } = {}) {
  if (_gkpPrefetchInFlight && _gkpPrefetchPromise) return _gkpPrefetchPromise;
  // ... fresh check ...
  _gkpPrefetchInFlight = true;
  _gkpPrefetchPromise = (async () => {
    try { /* existing logic */ } finally { _gkpPrefetchInFlight = false; _gkpPrefetchPromise = null; }
  })();
  return _gkpPrefetchPromise;
}
```

검색 핸들러: 캐시 없고 `_gkpPrefetchPromise` 있으면 그것을 await. 없으면 직접 fetch (현재 로직).

**R4. Price 데이터 영구 저장 (Codex #5)** — `original_price` 가 가격 전략 데이터로 약간 민감. 모달 열면 어차피 보이는 데이터지만 영구 저장은 불필요. **캐시 직전 `price` 필드 제거**. 검색 결과 렌더 시 다시 보여줘야 하니, 사용자 검색 시점에는 enriched 가 메모리에 있으므로 OK. localStorage 에서 hydrate 한 직후 첫 검색은 price 가 빈값으로 표시될 수 있음 → 그건 trade-off (가격 보려면 강제 새로고침 한 번 필요). **단순화: price 도 그냥 저장**. 사용자가 모달 보면 어차피 노출. 원가(`cost_krw`) 는 다른 테이블이므로 localStorage 와 무관. → **R4 는 불채택**, 대신 향후 IndexedDB 이전 시 재검토 (Out-of-scope §6 에 노트 추가).

### 8.2 부분 채택 (메모만)

**R5. Verification 에 race 시나리오 추가 (Codex #7)** — 검증표에 추가:
- (8) 두 브라우저 탭 동시 prefetch 트리거 → 둘 다 끝난 뒤 localStorage 의 fetchedAt 이 더 큰 값으로 안정. 콘솔에 timestamp guard 로 인한 "skipped older write" 같은 경고 없어도 OK (조용히 drop).
- (9) Stale 캐시 상태에서 검색 클릭 → 백그라운드 prefetch 중 빠르게 다시 검색 클릭 → 두 번째 클릭은 진행 중 prefetch 의 Promise 를 await 후 결과 표시 (Network 에 중복 페이지네이션 없음).

### 8.3 불채택 (사유 명시)

**R6. update_time_from required 처리 (Codex #4)** — Codex 는 docs 의 에러 코드 목록(`update_time_from is required`)을 근거로 우려했으나, **공식 스키마 (`get_global_item_list.json` line 537, 541) 는 둘 다 `required: false`** 이고 production 코드는 현재도 둘 다 안 보내고 정상 동작 중. Bridge 정책이 갑자기 바뀔 가능성은 매우 낮고, 그런 경우엔 어차피 catch 블록에 떨어져서 fallback 경로 (`_gkpFetchShopItemsFallback`) 가 실행됨. 추가 mitigation 불필요.

**R7. error_auth 코드 기반 분기로 변경 (Codex #4 후반)** — 기존 코드의 문자열 매칭 (`/global_items 오류|product\.error_unknown|invalid_access_token|invalid_acceess_token/i`) 은 caller 가 throw 할 때 message 로 던져버려서 코드 필드 접근이 어려움. 이번 PR 은 **기존 패턴 그대로 사용** (typo 포함). 에러 처리 리팩토링은 별도 과제로 분리. → Out-of-scope §6 에 노트 추가.

**R8. 1차로 캐시만 (수동 새로고침) → 2차 prefetch (Codex #6)** — 사용자가 명시적으로 "A + B 조합" 선택했으므로 그대로 진행. 단 multi-tab BroadcastChannel 같은 추가 복잡도는 R2 의 단순 timestamp guard 로 대체 (Codex 가 권한 lease 까지 제안한 부분은 과도).

### 8.4 변경 요약

| Step | 원안 | Revision 후 |
|------|------|------------|
| Step 2 | 모듈 진입 시 `_gkpEnrichedCache` hydrate | + `index.html:5848` 의 `_gkpEnrichedCache = { items: [], ... }` **라인 제거**. 모달 open 시 UI만 reset, 캐시는 보존. |
| Step 1 | `_gkpSavePersistedCache(items, fallbackMode)` | + 저장 전 기존 entry 의 `fetchedAt` 비교 후 더 오래된 write 는 drop |
| Step 3 | `_gkpPrefetchInFlight` 단순 boolean | + `_gkpPrefetchPromise` 추가, in-flight 시 같은 Promise 반환/공유 |
| Step 4 | 캐시 없으면 직접 fetch | + 캐시 없고 `_gkpPrefetchPromise` 있으면 그것을 `await` 후 결과 사용 |
| §4 검증 | 7개 시나리오 | + (8) multi-tab 동시 prefetch, (9) stale 검색 직후 빠른 재검색 |
| §6 follow-up | delta sync, refresh button, region cache, supabase, IndexedDB | + 에러 처리 리팩토링 (error_auth 등 코드 기반 분기) |

이 Revision 을 반영한 상태로 Sonnet 에게 implementation 위임.
