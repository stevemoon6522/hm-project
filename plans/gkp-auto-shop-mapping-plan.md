# GKP Add → Auto Shop Mapping (per-region shop_item_id + shop_model_id)

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-15 |
| Target | shopee-dashboard — `index.html` + `edge-functions/shopee-bridge/index.ts` |
| Trigger | User: "Global product 상품 검색 후 추가할때 각 국가 Shop sku 가 자동으로 매핑되게 하는 건 어떨까?" |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\` (verified) |
| Depends on | gkp-search-cache-plan.md (not blocking; both can ship independently) |

---

## 0. Goal (one paragraph)

When the operator clicks **확인** in the "🔍 상품 검색" modal to add picked global items to the product master, the existing `_gkpApply` flow inserts/updates rows in the `products` table only. After this change, the SAME flow ALSO populates `product_shopee_listings` with `(product_id, region, global_item_id, shop_item_id, shop_model_id)` for every region (SG/TW/MY/TH/PH/BR) where the global item is currently published — eliminating the manual per-region mapping step that operators do today via the v2 wizard or by hand.

---

## 1. API findings (verified from official Shopee docs)

### `v2.global_product.get_published_list` (`global_product/v2.global_product.get_published_list.json`)
- Method: GET, merchant scope, requires `global_item_id`
- Optional `shop_id_list` (filter; max 300 first publishable shops if omitted post-migration)
- Response: `response.published_item[] = { shop_id: int, shop_region: str, item_id: int, item_status: int }`
- `item_status` enum: `0=DELETED, 1=NORMAL, 2=BANNED, 3=REVIEWING, 4=INVALID, 5=INVALID_HIDE, 6=BLACKLISTED, 8=NORMAL_UNLIST`
- **Acceptable for mapping**: `1` (NORMAL) and `8` (NORMAL_UNLIST) — both have valid item_id mappings
- **Reject**: `0, 4, 5` (deleted) — no point caching dead mapping
- **Reject + warn**: `2, 3, 6` (banned/reviewing/blacklisted) — listing exists but operator needs to know

### Limitation: no shop_model_id in response
`get_published_list` returns shop-level `item_id` only. For variant (multi-model) global items, we still need shop-level model_id resolution.

### `v2.product.get_model_list` (`product/v2.product.get_model_list.json`)
- Method: GET, shop scope, requires `shop_id` + `item_id`
- Response: `response.model[] = { model_id, model_sku, ... }`
- No global_model_id reference — must match by SKU.

### Mapping rule for variants
Shopee publishes a global model to shop with `model_sku = global_model_sku` by default (operator may override per shop, but rare for kpop merch). Strategy:
1. **Primary**: match `shop.model[].model_sku === global_model_sku` (case-sensitive).
2. **Fallback (warn)**: if no SKU match found, match by **array index** in the order returned by `get_global_model_list` — this works because Shopee preserves option ordering. Mark the product_shopee_listings row with `last_error='mapping_inferred_by_index'` so operator can verify.
3. **Fail (skip)**: if model count differs between global and shop, skip this region for this model and log error to import-log.

### `shopee_shops` table state (verified via DB)
Active shops:
| region | shop_id |
|---|---|
| SG | 1001961186 |
| TW | 1002269092 |
| MY | 1002269081 |
| PH | 1002269083 |
| TH | 1002269088 |
| BR | 1669858301 (replacement after old `1002269093` ban) |

Memory note `project_starwms_leaked_credentials` 와 user-global memory 의 BR=1002269093 banned 표기는 outdated. 별도 commit 으로 메모리 갱신 권장 (out of scope for this PR).

### `product_shopee_listings` schema (verified)
Columns: `product_id (uuid)`, `region (text)`, `global_item_id (bigint)`, `shop_item_id (bigint)`, `shop_model_id (bigint)`, `status (text)`, `published_at (timestamptz)`, `last_error (text)`, `last_synced_price (numeric)`, `last_synced_at (timestamptz)`, `days_to_ship (int)`, `title_state (text)`, `last_pushed_name (text)`, `last_pushed_at (timestamptz)`.
- PK: `(product_id, region)` → one row per product per region. Variants: each model_sku has its own product_id, so each gets its own row per region.
- FK: `product_id → products(id) ON DELETE CASCADE`.

---

## 2. Scope

### In scope
1. New bridge action `published_list` in `edge-functions/shopee-bridge/index.ts` (and mirror in `supabase/functions/shopee-bridge/index.ts` if user maintains both — verify).
2. Reuse existing `model_list` endpoint (shop-level) — already exists per existing code (`get_model_list` is callable via `raw_call?path=/api/v2/product/get_model_list&q=item_id=X`).
   → Add a thin convenience action `shop_model_list` that does the same thing more cleanly: `?action=shop_model_list&region=SG&item_id=N`. Easier for the new client code.
3. Modify `_gkpApply` (`index.html` line 5842) to:
   a. After `products` insert/update, call published_list per unique global_item_id.
   b. For variant global items: call shop_model_list per (region, shop_item_id) where item_status acceptable.
   c. Build per-(product_id, region) mapping rows.
   d. Upsert into `product_shopee_listings` with `onConflict: 'product_id,region'`.
   e. Surface partial failures to import-log without aborting the whole batch.

### Out of scope (별도 PR)
- "동기화" 버튼에 "publish 매핑 새로고침" 추가 (기존 product 의 누락 mapping 보충)
- `last_synced_price` / `published_at` / `days_to_ship` 같은 부가 필드 채우기 — 이번 PR 은 mapping 만.
- BR shop 1002269093 banned 메모리 갱신 → 별도 1줄짜리 변경.
- 사용자가 직접 model_sku 를 shop 마다 다르게 설정한 케이스의 deep mapping (UI 수동 보완 활용).

---

## 3. Data flow

### Input (existing in `_gkpApply`)
`uniqueRows: [{ sku, product_name, shopee_item_id (=global_item_id) }]` already deduped by sku.

### After Step A (products insert/update — unchanged)
We have `products` rows for each picked sku. We need their `id` (uuid) values.
- For inserted rows: `db.from('products').insert(missingRows).select('id, sku, shopee_item_id')`
  → Currently the code does NOT select on insert. **Change required**: switch to `.insert(missingRows).select('id, sku, shopee_item_id')`.
- For updated rows: already have `prev.id` from `existingBySku`.
- Build a flat map `productIdBySku: Map<sku, uuid>` covering all picked rows.

### Step B: Group by global_item_id
- `globalItemIds = unique(uniqueRows.map(r => r.shopee_item_id))` — these are the parent global_item_ids needing published_list lookup.

### Step C: For each global_item_id, call published_list
- `GET ${SHOPEE_BRIDGE}/published_list?global_item_id=N`
- Bridge returns Shopee response wrapper: `{ ok, result: { response: { published_item: [...] } } }`
- Filter `published_item[]` to `item_status ∈ {1, 8}` AND `shop_id ∈ active_shop_ids` (load `shopee_shops` once at start of `_gkpApply`).

### Step D: Identify variant items
For each picked row, determine if its SKU corresponds to a variant model (rowType derived from `_gkpRowsForSelection`):
- If picked row's parent global_item is `model_header` (i.e. has multi-model): need shop_model_id resolution per region.
- If single (no variant): shop_model_id = NULL, just shop_item_id mapping suffices.

We can derive this from `_gkpEnrichedFiltered` (current modal state) by looking up the `global_item_id` and checking if `models.length > 0`.

### Step E: For each variant published shop, call shop_model_list
- `GET ${SHOPEE_BRIDGE}/shop_model_list?region=${region}&item_id=${shop_item_id}`
- Returns `{ model: [{ model_id, model_sku, ... }] }`
- Build `shopModelBySku: Map<model_sku_string, model_id>` per (region, item_id).

### Step F: Build listing rows
For each picked product row × each acceptable published region:
```js
{
  product_id: productIdBySku.get(row.sku),
  region: published.shop_region,
  global_item_id: Number(row.shopee_item_id),
  shop_item_id: Number(published.item_id),
  shop_model_id: variant ? matchModelIdByGlobalSku(...) : null,
  status: 'mapped',
  last_error: null, // or 'mapping_inferred_by_index' for fallback
}
```

### Step G: Upsert in batches of ~50
`db.from('product_shopee_listings').upsert(batch, { onConflict: 'product_id,region' })`

### Step H: Report to import-log
- `✅ N건 추가 / M건 ID 업데이트 / K건 매핑 (regions: SG/TW/MY/...)`
- `⚠️ J건 매핑 실패 (예: 'BR shop banned', 'TW model SKU mismatch') — 수동 보완 필요`

---

## 4. New bridge endpoints

### `GET ?action=published_list&global_item_id=N[&shop_ids=A,B,C]`
```ts
if (action === 'published_list') {
  const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
  if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
  const shop_ids_param = url.searchParams.get('shop_ids');
  const query: Record<string, any> = { global_item_id };
  if (shop_ids_param) {
    const ids = shop_ids_param.split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
    if (ids.length) query.shop_id_list = JSON.stringify(ids); // Shopee accepts JSON array string
  }
  const result = await merchantApiCall(region, '/api/v2/global_product/get_published_list', { query });
  return jsonResp({ ok: !result.error, region, query, result });
}
```
- `region` from existing query param (operator's main account region, e.g. SG) — merchant API is region-bound to merchant token.

### `GET ?action=shop_model_list&region=SG&item_id=N`
```ts
if (action === 'shop_model_list') {
  const item_id = parseInt(url.searchParams.get('item_id') || '0');
  if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
  const result = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id } });
  return jsonResp({ ok: !result.error, region, item_id, result });
}
```
- Uses shop scope (per-region shop access_token). Existing pattern.

Both insertion points: end of action chain, before the 404 fallback. Bridge follows convention `if (action === 'X') { ... }`.

---

## 5. Client code changes (index.html `_gkpApply`)

### State to reuse
- `_gkpEnrichedCache.items` — has `{ type, global_item_id, item_name, item_sku, models: [{global_model_id, global_model_sku, ...}] }`. Use to detect variant vs single.
- `_gkpEnrichedFiltered` — currently same as cache after filter; safe.

### Helper: load active shops once per session
Cache `state.shopeeShops = [{region, shop_id, status}]` from `shopee_shops` table (load at app boot or lazy on first `_gkpApply`).

### Pseudo-flow (drop-in for `_gkpApply` after products insert/update)
```js
// 1. Build productIdBySku
const productIdBySku = new Map();
for (const r of existingRows) productIdBySku.set(r.sku, r.id);
// inserts: re-fetch ids
if (missingRows.length) {
  const { data: insertedIds } = await db.from('products').select('id, sku').in('sku', missingRows.map(r => r.sku));
  for (const r of insertedIds) productIdBySku.set(r.sku, r.id);
}

// 2. Load active shops (cached on state.shopeeShops if available)
const shops = await _ensureShopeeShopsLoaded(); // returns [{region, shop_id}]
const shopIdsByRegion = new Map(shops.map(s => [s.region, Number(s.shop_id)]));
const allShopIds = shops.map(s => Number(s.shop_id));
const activeShopIdSet = new Set(allShopIds);

// 3. For each unique global_item_id, fetch published_list + (if variant) per-region model_list
const globalItemIds = [...new Set(uniqueRows.map(r => Number(r.shopee_item_id)))];
const mappingErrors = [];
const listingRows = [];

for (const gid of globalItemIds) {
  const enriched = _gkpEnrichedCache.items.find(it => Number(it.global_item_id) === gid);
  const isVariant = !!(enriched && Array.isArray(enriched.models) && enriched.models.length);

  // 3a. published_list
  let publishedItems = [];
  try {
    const r = await fetch(`${SHOPEE_BRIDGE}/published_list?region=SG&global_item_id=${gid}&shop_ids=${allShopIds.join(',')}`, { headers: AUTH });
    const j = await r.json();
    publishedItems = j.result?.response?.published_item || [];
  } catch (e) {
    mappingErrors.push(`gid=${gid} published_list 실패: ${e.message}`);
    continue;
  }

  const usable = publishedItems.filter(p => activeShopIdSet.has(Number(p.shop_id)));
  for (const p of usable) {
    if (![1, 8].includes(Number(p.item_status))) {
      mappingErrors.push(`${p.shop_region}/gid=${gid}: item_status=${p.item_status} (skip)`);
      continue;
    }

    let modelMapByGlobalSku = null; // null = not loaded; only loaded for variants
    if (isVariant) {
      try {
        const mr = await fetch(`${SHOPEE_BRIDGE}/shop_model_list?region=${p.shop_region}&item_id=${p.item_id}`, { headers: AUTH });
        const mj = await mr.json();
        const models = mj.result?.response?.model || [];
        modelMapByGlobalSku = new Map();
        // Primary: SKU match
        for (const m of models) {
          if (m.model_sku) modelMapByGlobalSku.set(String(m.model_sku), Number(m.model_id));
        }
        modelMapByGlobalSku._all = models; // attach for fallback index access
      } catch (e) {
        mappingErrors.push(`${p.shop_region}/gid=${gid} model_list 실패: ${e.message}`);
        continue;
      }
    }

    // For each picked row whose parent is this gid, build a listing row
    const picksForThisGid = uniqueRows.filter(r => Number(r.shopee_item_id) === gid);
    const globalModels = enriched?.models || [];

    for (const pickedRow of picksForThisGid) {
      const product_id = productIdBySku.get(pickedRow.sku);
      if (!product_id) continue;

      let shop_model_id = null;
      let last_error = null;
      if (isVariant) {
        // primary: SKU match
        shop_model_id = modelMapByGlobalSku.get(String(pickedRow.sku));
        if (!shop_model_id) {
          // fallback: index match (only safe if model count matches)
          if (globalModels.length === modelMapByGlobalSku._all.length) {
            const idx = globalModels.findIndex(gm => String(gm.global_model_sku) === String(pickedRow.sku));
            if (idx >= 0) {
              shop_model_id = Number(modelMapByGlobalSku._all[idx]?.model_id);
              last_error = 'mapping_inferred_by_index';
            }
          }
        }
        if (!shop_model_id) {
          mappingErrors.push(`${p.shop_region}/${pickedRow.sku}: shop_model 매칭 실패`);
          continue;
        }
      }

      listingRows.push({
        product_id,
        region: p.shop_region,
        global_item_id: gid,
        shop_item_id: Number(p.item_id),
        shop_model_id,
        status: 'mapped',
        last_error,
      });
    }
  }
}

// 4. Upsert in batches of 50
let upsertedCount = 0;
for (let i = 0; i < listingRows.length; i += 50) {
  const batch = listingRows.slice(i, i + 50);
  const { error: upsertErr } = await db.from('product_shopee_listings').upsert(batch, { onConflict: 'product_id,region' });
  if (upsertErr) { mappingErrors.push(`upsert 실패: ${upsertErr.message}`); break; }
  upsertedCount += batch.length;
}

// 5. Compose final log message (extending existing inserted/updated log)
let logMsg = `✅ ${inserted}건 추가 / ${updated}건 ID 업데이트 / ${skipped}건 기존 유지 / ${upsertedCount}건 매핑.`;
if (mappingErrors.length) {
  logMsg += `\n⚠️ ${mappingErrors.length}건 매핑 실패:\n${mappingErrors.slice(0, 10).join('\n')}`;
  if (mappingErrors.length > 10) logMsg += `\n... ${mappingErrors.length - 10}건 더`;
}
logEl.textContent = logMsg;
```

Note the structural change: the existing `setTimeout(... initStorage, 1000)` should run AFTER mapping completes too. Move into post-mapping.

---

## 6. API call cost analysis

- **Worst case**: 100 picked rows = 50 unique global_items, all variants, 6 regions.
  - published_list: 50 calls
  - shop_model_list: 50 × 6 = 300 calls (only for variant items; if 50% are single, only 150)
  - Total: 350 calls
- Shopee rate limits: shop API 10000/day per shop, merchant API 1000/min. 350 calls in a few minutes is fine.
- Latency: each merchant API call ~1-2s. Per global item ~ (1 + 6 × 1s) = 7s. 50 global items sequentially = 350s = ~6min.
- Mitigation: parallelize batch of 5-10 global_items concurrently. Reduces wall time to ~1min for 50 variants.
- **Default**: parallelize at 5. Adjustable constant.

---

## 7. Verification (success criteria)

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | 단일(no-variant) 상품 1개 추가 | products 1행 + product_shopee_listings 4-6행 (publish 된 region 만), shop_model_id=NULL, status='mapped' |
| 2 | 변형(multi-model) 상품 3 model 모두 선택 후 추가 | products 3행 + listings 3 × N_regions 행, 각 row 의 shop_model_id 가 SKU 매칭으로 채워짐, last_error=NULL |
| 3 | publish 안 된 region 이 있는 상품 | 해당 region 은 listings 에 안 들어감, import-log 에 단순 정보로 표시 안 됨 (오직 status 2/3/6 만 warn) |
| 4 | item_status=2 (BANNED) 한 region 포함 | 해당 region 만 skip + import-log 에 "TW/gid=X: item_status=2 (skip)" 표시. 다른 region 정상 매핑. |
| 5 | model_sku 가 shop 에서 변경되어 매칭 실패 (artificial test) | fallback 로 index match 시도 → 성공 시 last_error='mapping_inferred_by_index'. 실패 시 import-log error. |
| 6 | 50개 일괄 추가 (성능) | 1분 이내 완료 (parallelism=5). UI 가 멈추지 않고 진행상황 표시. |
| 7 | 같은 SKU 재추가 (이미 listings 존재) | upsert 가 기존 row 갱신 (shop_item_id 변경 시), `(product_id, region)` PK 위반 없음 |
| 8 | published_list API 응답 errors (e.g., expired token) | 해당 global_item 만 skip + import-log error. 다른 item 영향 없음. |
| 9 | BR shop 신 ID 1669858301 매핑 | 정상 작동 (활성 상태). 매핑 row 생성됨. |

### Regression
- `products` insert/update 동작 그대로
- 단일 상품(no-variant) 의 `shopee_item_id` 컬럼 채우기 동작 유지
- 모달 close + initStorage 호출 그대로 (mapping 끝난 후)

---

## 8. Risks & mitigations

| 리스크 | 완화 |
|--------|------|
| Shopee API 부분 실패 시 일부 region 만 매핑됨 | per-error 메시지 import-log 에 표시. 사용자가 수동 보완 가능. 절대 silent fail 금지. |
| Variant 모델 SKU 가 shop 별로 다르게 설정된 경우 | primary SKU 매치 실패 → fallback index 매치 → 그것도 실패 시 skip + warn |
| upsert 시 기존 listings 의 last_synced_price 등 부가 필드 덮어쓰기 | upsert payload 에 이런 필드는 포함하지 않으므로 NULL 로 변경되지 않음 (Postgres upsert 는 명시한 컬럼만 갱신). 단 `status='mapped'` 와 `last_error` 는 매번 갱신 — 의도된 동작. |
| 대량 추가 시 사용자 UI freeze | 진행률 표시 (i/total) + parallelism 제한 5. logEl 에 실시간 업데이트. |
| 토큰 만료 (CBSC merchant) | 첫 published_list 실패 시 throw → catch 에서 모든 매핑 abort + 기존 products insert 는 보존. import-log 에 "토큰 만료, 매핑은 스킵됨" 표시. |
| BR shop 메모리 outdated | DB 가 정본. shops 쿼리로 신규 ID 1669858301 자동 사용. plan 에 별도 메모리 갱신 노트. |
| `state.shopeeShops` 캐시 stale | `_ensureShopeeShopsLoaded` 가 매 `_gkpApply` 호출 시 재로드 (작은 테이블, 1 query). |

---

## 9. Estimated effort

- 코드 변경: 
  - `edge-functions/shopee-bridge/index.ts`: ~30 라인 (2 새 action)
  - `supabase/functions/shopee-bridge/index.ts`: 동일 코드 (mirror) — 사용자가 두 곳 다 유지 중인지 확인 필요
  - `index.html` `_gkpApply`: ~120 라인 추가/수정 (helper + 새 매핑 흐름)
- 검증: 위 9개 시나리오 (Vercel 배포 후 직접)
- 총 2-3시간 (Sonnet 작업 + 메인 검토 + Codex 리뷰)

---

## 10. Out-of-scope follow-ups (별도 PR)

1. **수동 매핑 새로고침 버튼** — 기존 product 의 listings 가 비어있거나 stale 한 경우 사용자가 강제 재매핑.
2. **동기화 버튼 통합** — 가격 sync 동시에 매핑 누락 자동 보충.
3. **last_synced_price / published_at / days_to_ship 채우기** — published item 의 추가 필드 활용.
4. **BR shop 메모리 갱신** — `project_starwms_leaked_credentials` 또는 user-global memory 에서 shop_id 1002269093 → 1669858301 update.
5. **Mapping 결과 캐싱** — per-product mapping 도 localStorage 또는 DB 캐시. 단 DB 가 source of truth 이므로 우선순위 낮음.
6. **모달 취소 시 진행 중 요청 abort** — `AbortController` 도입. v1 은 백그라운드 진행 허용 (idempotent 이므로 데이터 안전).
7. **수동 매핑 보완 UI** — `status='mapping_pending'` 행을 review queue 로 표시하고 operator 가 직접 shop_model_id 입력하는 화면.

---

## 11. Revision (Codex adversarial review, 2026-05-15)

Codex 가 2개 BLOCKER + 3개 RISK 제기. 메인 세션이 검증 후 다음과 같이 반영.

### 11.1 채택 (수정 필수)

**R1. 인덱스 폴백 매핑 제거 (Codex BLOCKER #2 + #8)** — Codex 정확한 지적. Shopee 공식 문서 `get_model_list` 에 모델 배열 순서 보장이 명시 없음. 인덱스 매칭으로 잘못된 `shop_model_id` 가 `status='mapped'` 로 저장되면 이후 가격 push 가 wrong variant 에 적용되는 silent data corruption. **인덱스 폴백을 완전히 제거**. SKU 매칭 실패 시:

- `shop_model_id = NULL`
- `status = 'mapping_pending'`
- `last_error = 'shop_model_sku_mismatch'`
- import-log 에 명시적 warning 표시
- operator 가 수동으로 보완 가능 (out-of-scope §10.7 review queue UI 도 구상 가능, v1 은 raw 컬럼 편집)

→ §3 Step F 의 `shop_model_id` 결정 로직 단순화. §5 의 fallback index 블록 삭제.

**R2. `shop_id_list` 파라미터 미사용 (Codex RISK #1)** — JSON 직렬화 형식 미검증 + Shopee 가 omit 시 자동으로 publishable shop 리스트 반환 (최대 300, 우리는 6개). 굳이 보낼 필요 없음. **bridge 의 `published_list` action 에서 `shop_id_list` 인자를 받지 않음**. 클라이언트는 published_item[] 을 받아서 `activeShopIdSet` 으로 필터 (이미 plan 에 있음).

→ §4 의 `published_list` 코드에서 `shop_ids_param` 분기 삭제. §5 의 `shop_ids=${allShopIds.join(',')}` 쿼리스트링 삭제.

### 11.2 부분 채택 (메모만)

**R3. Race condition (Codex RISK #3)** — 복수 탭/사용자 동시 클릭 시: products insert 는 이미 select-then-insert 로 idempotent. listings 도 PK=(product_id, region) upsert 로 idempotent. **데이터 손상 없음**, 단 동일 작업 2회 진행될 뿐. 비용 측면에서 약간의 중복 API call 만 발생 → mitigation 불필요. plan 본문에 노트 추가만.

**R4. Modal 취소 처리 (Codex RISK #5)** — 모달 ✕ 누르면 mapping 백그라운드 계속 진행, products row 는 이미 commit, listings 부분 populate. 모두 idempotent 이므로 **다시 동일 SKU 추가하면 자연스럽게 보완**. 사용자 행동 측면에선 약간 불친절 (UI 닫혀도 작업 안 멈춤). v1 은 그대로 두고 §10.6 follow-up 으로 빼기.

**R5. Region=SG 하드코딩 (Codex RISK #1 후반)** — 기존 bridge 의 `merchantApiCall(region, ...)` 가 region 파라미터를 받지만 실제로는 merchant credential 을 사용 (region 은 컨텍스트 태그에 가까움). 기존 `global_items` action 도 동일 패턴 (line 2247: `merchantApiCall(region, ...)` with region from URL). **기존 패턴 그대로** 사용 — region=SG 가 merchant scope call 에서 어떻게 처리되는지는 v37/v39 bridge 코드가 검증 완료. 추가 작업 불필요.

### 11.3 변경 요약

| Step | 원안 | Revision 후 |
|------|------|------------|
| §3 Step F | SKU 매치 → 실패 시 인덱스 폴백 → 그것도 실패 시 skip | SKU 매치 → 실패 시 즉시 status='mapping_pending', shop_model_id=NULL, last_error 기록. 인덱스 폴백 코드 제거. |
| §4 published_list action | optional shop_id_list 파라미터 처리 | shop_id_list 파라미터 받지 않음. Shopee 가 publishable shop 자동 반환 (≤6 in our setup). |
| §5 client code | `shop_ids=...` 쿼리 + index fallback 블록 | shop_ids 쿼리스트링 삭제. fallback 블록 삭제. SKU mismatch 시 status='mapping_pending' row 생성. |
| §7 Verification | 시나리오 5 "fallback index match 시도" | "**SKU mismatch → status='mapping_pending', shop_model_id=NULL, import-log 에 warning. 인덱스로 추측하지 않음 (안전)**" 으로 변경. |
| §8 Risks | "Variant 모델 SKU 가 shop 별로 다르게 설정된 경우" 폴백 인덱스 매칭으로 우회 | 인덱스 우회 제거. 명시적 mapping_pending 상태로 operator 수동 보완 유도. **no silent corruption.** |

### 11.4 Verification 추가

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 10 | model_sku 가 shop 에서 변경되어 매칭 실패 | listings 행 생성됨 (status='mapping_pending', shop_model_id=NULL, last_error='shop_model_sku_mismatch'), import-log 에 warning 표시. **인덱스 추측 매핑 절대 발생하지 않음.** |
| 11 | 동일 사용자 두 탭에서 동시에 같은 SKU 추가 클릭 | 양쪽 다 성공, products + listings idempotent upsert. 데이터 손상 없음. |

이 Revision 을 반영한 상태로 Sonnet 에게 implementation 위임.
