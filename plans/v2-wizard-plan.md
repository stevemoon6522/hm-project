# Plan: shopee-dashboard v2/ — 상품 등록 + PRE→READY + 가격 동기화

- 작성일: 2026-05-12 (초안), revised 2026-05-13 (운영자 3가지 강조 반영)
- 작성자: Opus (Claude Code)
- 선행 문서: `plans/ready-stock-wizard-plan.md` (회의록 요약), `2026-05-11-shopee-dashboard-planning.md`
- Codex 리뷰: 본 문서 §11 (1회차 완료, P0/P1/P2 통합)

---

## 0. 운영자 강조 — V2 dashboard 의 핵심 3가지 워크플로

2026-05-13 운영자가 문서 검토 후 명시한 우선순위. V2 는 이 3개 영역을 갖춰야 하며, 어느 하나도 빠져서는 안 된다.

### ⚠️ 0-0. KRSC (Korean Seller Center) 전제 — 매우 중요
운영자 명시(2026-05-13): "우리는 CBSC 가 아니라 **KRSC** 내용을 확인해야 한다."

KRSC = Korean Seller Center. **CBSC umbrella 의 한국 셀러 업그레이드 버전** (CNSC=중국, KRSC=한국). 기술적으로는 **CBSC 와 동일한 Global Product API 를 사용** 하지만, 한국 셀러 전용 제약 몇 가지가 있다.

출처: `C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\regional\krsc-api-integration-guide.md`

**KRSC 셀러가 따라야 하는 규칙** (regional_rules.json 발췌, 17개 rule):
1. **`Global Product API + Merchant API` 만 사용 가능** — KRSC 업그레이드된 shop 에서는 다른 product listing API 호출이 차단됨.
2. **Shop-level `/api/v2/product/*` API 사용 불가** — `update_item`, `update_model` 등으로 shop 별 개별 product/model 편집 불가능.
3. **shop-level model_sku (MPSKU) 변경 불가** — `product.update_model` 문서 명시: "CNSC and KRSC sellers are not allowed to update the MPSKU model sku". global_model_sku (모상품 SKU) 변경만 가능.
4. **App V2 필수** — Original APP type 는 KRSC 미지원.
5. **Sub-account 권한 부족** — Authorization 은 main account 만.
6. **Token 분리** — merchant token + 각 shop token 별도 저장.
7. **Publish 누락 시 차단** — `create_publish_task` 에서 일부 region shops 가 unchecked 면 그 shop 으로는 API publish 불가.

→ V2 plan 의 모든 mutation 액션은 **Global Product API + Merchant API 안에서만** 설계.

### 0-1. 상품 등록 (PRE_ORDER 분류 포함) — Phase A0 + A1
- Shopee KRSC global product API 로 신규 상품 등록 (mom + variants + region publish)
- 등록 직후 `products.lifecycle_state = 'pre_order'` 로 분류
- 모든 region 의 Days to Ship = 50~60 (선주문 발송 윈도우)
- 상품명에 `[PRE ORDER]` 접두

### 0-2. PRE ORDER → READY STOCK 전환 (입고 시) — Phase B
- 입고된 상품 선택 → 다음을 1회 클릭으로 일괄 실행:
  - **Global level Days to Ship → 1** (`update_global_item.days_to_ship` — KRSC 는 region별 다른 DTS 불가, 통합 1개 값)
  - 옵션별 무게 실측값으로 **global model weight** 갱신 (`update_global_model[].weight`, KG)
  - **Global SKU (`global_model_sku`)** 만 운영 SKU 로 변경 — shop_model_sku 는 KRSC 에서 변경 불가, publish 시 자동 sync 가정
  - 상품명 `[PRE ORDER]` → `[READY STOCK]` (`update_global_item.global_item_name`)
  - region별 무게 기반 신규 판매가 재계산 + push (`update_price` — region별 batch 호출)

### 0-3. 상품 조회 & 매입가 동기화 — Phase C
- 등록된 상품 list (region 매핑 상태 / lifecycle / 현재가 / 무게 / 최근 push 시점)
- 매입가 inline 수정 → 각 region 의 신규 판매가 자동 재계산
- 1클릭 일괄 push (update_price)
- 매입가 변동 14일 미반영 상품 배지

### 0-4. Shopee KRSC API 매핑 (검증 완료, 모두 global_product/merchant 만 사용)
| 워크플로 | Shopee API | KRSC 적용 |
|---------|-----------|-----------|
| 0-1 상품 등록 (mom) | POST `/api/v2/global_product/add_global_item` | ✅ |
| 0-1 상품 등록 (variants) | POST `/api/v2/global_product/add_global_model` | ✅ |
| 0-1 publishable shops 조회 | GET `/api/v2/global_product/get_publishable_shop` | ✅ |
| 0-1 region publish 시작 | POST `/api/v2/global_product/create_publish_task` | ✅ |
| 0-1 publish 결과 polling | GET `/api/v2/global_product/get_publish_task_result` | ✅ |
| 0-1 publish 완료 목록 | GET `/api/v2/global_product/get_published_list` | ✅ |
| 0-2 READY STOCK 전환 (name/desc + global_item_sku + global level DTS + global level weight + pre_order off) | POST `/api/v2/global_product/update_global_item` | ✅ |
| 0-2 variant 전환 (global_model_sku + variant weight) | POST `/api/v2/global_product/update_global_model` | ✅ |
| ~~0-2 region별 DTS (shop level)~~ | ~~`/api/v2/product/update_item`~~ | ❌ **KRSC 사용 불가** — Global DTS 1개 값으로 통합 |
| 0-3 region별 판매가 push | POST `/api/v2/global_product/update_price` | ✅ |
| 0-3 등록 상품 조회 (목록) | GET `/api/v2/global_product/get_global_item_list` | ✅ |
| 0-3 등록 상품 detail | GET `/api/v2/global_product/get_global_item_info` | ✅ |
| 0-3 merchant info / shop info | GET `/api/v2/merchant/get_merchant_info` + `/api/v2/shop/get_shop_info` | ✅ |

전체 사용 endpoint 문서: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.*.json` + `merchant\` + `shop\`

---

## 1. 목표 / 비목표

### 목표
- 현 `index.html`은 운영 손대지 않고, **`v2/index.html` 로 별도 SPA** 신설
- §0 의 3가지 핵심 워크플로 모두 구현 (Phase A0/A1/B/C)
- 모든 mutation은 `shopee_mutation_log`에 기록 (첫 배포부터 강제, 같은 commit)
- Live probe 통과 전엔 `update_global_item.item_name` / `update_global_model.weight` 노출 금지
- 모든 API 호출은 `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\` 의 공식 문서 schema 그대로 사용 (필드 추측 금지)

### 비목표 (본 plan 범위 외)
- 칸반 보드 시각화 (Phase D-1) — lifecycle 컬럼 기반 후속 작업
- xlsx import / Google Sheets onEdit — 가격 동기화는 inline + 일괄 push 만
- v1(index.html) 기능 마이그레이션 — 사용자가 v2 보고 어느 부분 합치고 빼낼지 별도 피드백
- Shopee shop-level only fields (logistics, dimensions per shop) — Phase A0 의 publish 후 default 값 사용, 별도 편집 미지원

---

## 2. v2 분리 전략

### 배치
- 새 파일: `C:\dev\shopee-dashboard\v2\index.html` (단일 HTML+CSS+JS, v1과 동일 스택)
- 접근 URL: `https://shopee-dashboard-kohl.vercel.app/v2/`
- 같은 Vercel project (자동 라우팅), 같은 git repo, 같은 Supabase project, 같은 `shopee-bridge` edge function

### v1과 공유 자원
- Supabase 테이블 `products`, `product_shopee_listings`, `country_settings` — **읽기/쓰기 모두 공유**
- `shopee-bridge` edge function — v2가 새 액션 추가, v1은 변경 없음 (기존 액션 유지)
- 인증/시크릿 — v1과 동일 (재로그인 부담 없음)

### v1과 분리되는 부분
- HTML/CSS/JS 코드는 별도 파일. v1 코드 복사 후 필요한 helper만 가져옴(SB client, Shopee API caller, fetch wrapper)
- v2 전용 mutation은 `shopee_mutation_log` 의 `actor='v2-wizard'` 로 구분

### Vercel 라우팅 검증
- `vercel deploy --prod --yes` 후 `/v2/` 가 디렉토리로 인식되는지 확인 (404 시 `vercel.json`에 `rewrites` 1줄 추가)
- 검증 시점: 빈 `v2/index.html` 만으로 첫 배포해서 라우팅만 먼저 통과 → 그 후 본 구현

---

## 3. 사전 점검 (선결 작업)

### 3-1. DB 마이그레이션 적용 상태 확인 (블로커)
회의록은 Phase A를 "적용 완료" 표기했으나, `index.html` grep 결과 `lifecycle_state`/`days_to_ship`/`title_state`/`last_pushed_name` 컬럼을 코드가 거의 안 씀. 적용 여부 SQL로 확인:

```sql
select column_name, data_type
from information_schema.columns
where table_name in ('products', 'product_shopee_listings')
  and column_name in (
    'lifecycle_state','weight_measured_at','cost_updated_at',
    'days_to_ship','title_state','last_pushed_name','last_pushed_at'
  );
```

- 적용됨: 그대로 사용
- 미적용: `apply_migration` 으로 추가 (idempotent하게 `add column if not exists`)

### 3-2. `shopee_mutation_log` 테이블 신설 (블로커)
Codex 권고 §6-1-3에 따라 본 PR에 포함. 스키마:

```sql
create table if not exists shopee_mutation_log (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  actor           text not null,                 -- 'v2-wizard' | 'v1-bulk' 등
  action          text not null,                 -- 'update_global_item' | 'update_global_model' | ...
  region          text,
  target_global_item_id   bigint,
  target_global_model_id  bigint,
  target_shop_item_id     bigint,
  payload_hash    text not null,                 -- region+target+action+payload SHA256 hex
  before_payload  jsonb,
  after_payload   jsonb,
  request_payload jsonb,
  response        jsonb,
  status          text not null,                 -- 'ok' | 'error' | 'dry_run' | 'skipped'
  error_msg       text,
  request_id      text,
  duration_ms     integer
);

create index if not exists idx_shopee_mutation_log_created_at
  on shopee_mutation_log (created_at desc);
create index if not exists idx_shopee_mutation_log_target_global_item
  on shopee_mutation_log (target_global_item_id);
-- P0-1 (Codex §11): WHERE status='ok' 만 (dry_run 별도 경로 — dry_run row 는
--   payload_hash 에 'dry:' prefix 붙여 별 hash 공간 사용). 그래야 dry_run
--   다음 ok 실호출이 충돌 안 됨.
create unique index if not exists uidx_shopee_mutation_log_idempotent
  on shopee_mutation_log (payload_hash)
  where status = 'ok';
```

멱등 키 unique 제약: 같은 region+target+action+payload_hash 가 한 번 'ok'로 들어가면 재시도 시 PG가 INSERT 거부 → 프론트가 'skipped'로 받음. **dry_run row 는 payload_hash 앞에 `dry:` prefix 를 붙여 저장** 하여 ok 와 hash 공간이 분리됨 (Codex P0-1 권고 반영).

### 3-3. Live probe (사용자 burnable product 선정 후 진행)
- 대상: 사용자가 지정한 단일 test product, 단일 region (SG 권장)
- 검증 1: `update_global_item` payload에 `item_name: "[PROBE TEST]"` 같이 넣었을 때
  - Shopee response error == null인지
  - 잠시 후 `get_global_item_info` 로 실제 변경됐는지 확인
- 검증 2: `update_global_model` payload에 `weight: 80` 같이 넣었을 때 위와 동일 확인 (그리고 무게가 region SKU에 전파되는지 vs CBSC가 region 별로 따로 setting인지 확인)
- 결과:
  - 통과: 그 필드를 마법사 자동 액션에 포함
  - 실패: 해당 필드는 마법사에서 OFF로 고정, UI에 "Shopee API 미지원" 안내
- probe 자체는 v2 dashboard 안에 "🔬 Probe" 메뉴 하나로 구현 (1회용 도구, audit 남김)

---

## 4. 백엔드 (shopee-bridge edge function)

### 4-0. 핵심 워크플로 → KRSC API 매핑 (전체)
| Phase | 신규/기존 | shopee-bridge action | Shopee API | KRSC |
|-------|----------|---------------------|------------|------|
| A0 등록 (mom) | 신규 | `add_global_item` | POST `/api/v2/global_product/add_global_item` | ✅ |
| A0 등록 (variants) | 신규 | `add_global_model` | POST `/api/v2/global_product/add_global_model` | ✅ |
| A0 publishable shops | 신규 | `get_publishable_shop` | GET `/api/v2/global_product/get_publishable_shop` | ✅ |
| A0 region publish 시작 | 신규 | `create_publish_task` | POST `/api/v2/global_product/create_publish_task` | ✅ |
| A0 publish polling | 신규 | `get_publish_task_result` | GET `/api/v2/global_product/get_publish_task_result` | ✅ |
| A0 publish 완료 목록 | 신규 | `get_published_list` | GET `/api/v2/global_product/get_published_list` | ✅ |
| B 전환 (name/desc + global_item_sku + DTS + weight + pre_order off) | 기존 확장 | `update_global_item` | POST `/api/v2/global_product/update_global_item` | ✅ |
| B variant (global_model_sku + weight) | 기존 확장 | `update_global_model` | POST `/api/v2/global_product/update_global_model` | ✅ |
| ~~B region별 shop-level DTS~~ | ~~신규~~ | ~~`update_shop_days_to_ship`~~ | ~~`/api/v2/product/update_item`~~ | ❌ **KRSC 사용 불가** |
| C 가격 push | 기존 유지 | `update_global_price` | POST `/api/v2/global_product/update_price` | ✅ |
| C 등록 상품 list | 신규 | `list_global_items` | GET `/api/v2/global_product/get_global_item_list` | ✅ |
| C 상품 detail | 신규 | `get_global_item_info` | GET `/api/v2/global_product/get_global_item_info` | ✅ |

모든 action 의 request schema 는 `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.<endpoint>.json` 의 `body_params` 그대로 사용. 필드 추가/제거 금지 (Codex P0-4 정책: silent strip → preflight hard-block).

**KRSC 제약 — Shop-level product API (`/api/v2/product/*`) 완전 제외**:
- DTS 는 global level 통합 1개 (`update_global_item.days_to_ship`, required int32). region별로 다르게 설정 불가.
- model_sku 는 global_model_sku 만 변경 가능. shop_model_sku (MPSKU) 는 publish 시 자동 sync.
- weight 는 global_item.weight + global_model[].weight 양쪽 모두 단위 KG.

### 4-1. 기존 액션 확장 (probe 통과 후만 본 구현 노출)
| 액션 | 변경 |
|------|------|
| `update_global_item` | `body.item_name` (optional), `body.description` (optional) 추가. probe 미통과 시 무시 + 경고 응답 |
| `update_global_model` | `body.global_model[].weight` (optional, 단위는 probe로 확인 g/kg) 추가. 동일 |

probe 통과 여부는 `shopee_app.config` 테이블(또는 `country_settings`)의 boolean flag로 표시: `probe_item_name_ok`, `probe_model_weight_ok`.

**P0-4 (Codex §11) — preflight hard-block 정책**: 통과 표시 없으면 edge function 이 해당 필드를 **strip 하지 않고 호출 자체를 거부** (HTTP 412 + body `{ok:false, error:'probe_not_passed', field:'item_name'|'weight'}`). UI 는 운영자가 명시적으로 "degraded 모드 승인" 토글을 켠 경우에만 strip + 진행 모드로 fallback (모든 strip mutation 은 `shopee_mutation_log.warn` 컬럼에 기록).

### 4-2. ~~신규 액션 `update_shop_days_to_ship`~~ — **KRSC 사용 불가, 폐기**
~~shop-level `/api/v2/product/update_item` 기반~~. KRSC 셀러는 shop-level product API 사용 불가하므로 폐기.

**대체**: `update_global_item` 호출 시 `days_to_ship` (int32, required) 필드로 global 통합 DTS 변경. 모든 region shops 에 broadcast 된다. region별 다른 DTS 가 필요한 경우는 KRSC 에서는 불가능.

### 4-3. mutation_log 자동 기록
- edge function 안에서 모든 mutation 액션의 입/출력을 INSERT
- 멱등 키 충돌 시(uidx_shopee_mutation_log_idempotent) → 새 호출은 'skipped' 상태로 별 row 안 만들고 응답에 `skipped: true, previous_log_id` 반환
- dry-run: `body.dry_run === true` 일 때 실제 호출 안 하고 row만 'dry_run' 상태로 저장

### 4-4. shopee-bridge 한 commit에 묶기 (Codex 권고)
- 액션 코드 + mutation_log INSERT 코드 + 멱등 키 + dry-run 모드 — 한 commit 으로 묶어 audit 없는 호출이 라이브로 나가는 창 차단

---

## 5. 프론트 (v2/index.html)

### 5-1. 최소 골격
- Supabase JS SDK (CDN), `shopee-bridge` fetch wrapper, 인증 (v1과 동일 환경변수 / anon key)
- 페이지 구조 (단일 SPA, 라우팅 없음):
  - 상단 nav: `📦 상품 등록 | 📋 PRE ORDER | 🔄 READY STOCK 전환 | 💰 상품 조회/가격 | 🔬 Probe | 📜 변경 이력`
  - 본문은 nav 선택에 따라 swap

### 5-1-A. 상품 등록 모달 (Phase A0 + A1) — 신규

**docs schema 정정 (2026-05-13 — Sonnet 위임 도중 docs_ai/apis/global_product 검증 결과 발견된 실제 schema)**:

| 항목 | 초안 plan | docs_ai 검증 결과 |
|------|----------|------------------|
| 재고 필드 | `normal_stock` | **deprecated (2024-10-23 sunset)** — `seller_stock[].stock` 만 유효 |
| `days_to_ship` 위치 (add_global_item) | `pre_order` 중첩 | nested in `pre_order` (확정) |
| `days_to_ship` 위치 (add_global_model) | 동일 | **top-level flat** (add_global_item 과 다름) |
| `package_length/width/height` (add_global_model) | dimension 중첩 | **top-level flat** |
| variant 별 weight | per-variant | **top-level 단일 float** (모든 variant 공통) |
| `tier_variation` 등록 경로 | add_global_item 본문 | add_global_item 에 없음 — 별도 `init_tier_variation` API 필요 |
| `brand_id` | required | body_params 미등장. examples 에만 표시 — TODO로 표기 |

**4단계 위저드**:
1. **카테고리 + 기본 정보** — `category_id` (트리 선택 — 1차는 직접 입력 TODO), `global_item_name` (운영자가 입력 시 `[PRE ORDER]` 자동 prefix), `description`, `brand.original_brand_name` (brand_id 는 별도 lookup, 1차 TODO), `original_price`, `seller_stock[0].stock`, `weight` (KG, 단일), `condition` (NEW/USED), `package_length/width/height` (cm)
2. **이미지 & 미디어** — 이미지 업로드(`media_space/upload_image` — 1차 TODO, 운영자가 image_id_list 직접 paste) → image_id_list (최대 9개), 선택 video_upload_id
3. **옵션/변형 (variants)** — `tier_variation[0].name` (예: 버전) + `model[]` 동적 행: optionName / global_model_sku / original_price / seller_stock[].stock. weight 는 top-level 1개 공통. 옵션 없으면 skip. `init_tier_variation` 별도 호출 필요 (1차 TODO).
4. **region publish** — `get_publishable_shop` 으로 candidate shops 표시 (1차 TODO, 등록 후 호출) → 사용자가 region 5개 체크박스 (BR banned 비활성) → `create_publish_task` 호출 + task_id 받음 → `get_publish_task_result` polling (5s 간격, 60s timeout)
5. **완료 시점 자동 수행**
   - `products` row INSERT: lifecycle_state='pre_order', cost_price, weight, image_url, shopee_item_id (= global_item_id)
   - `product_shopee_listings` rows INSERT (region별): days_to_ship=50, title_state='PRE_ORDER', last_pushed_name, last_pushed_at
   - 모든 region 의 days_to_ship 은 `add_global_item.pre_order.days_to_ship=50` 으로 등록 시 같이 설정 (KRSC 제약상 region별 다른 DTS 불가, global level 1개)
   - PRE ORDER 분류 완료

**1차 (skeleton)에서 stub 처리 + 후속 TODO**:
- category tree picker (`get_category` + `get_attribute_tree`)
- brand picker (`get_brand_list`)
- media_space.upload_image 통합
- init_tier_variation 호출
- get_publishable_shop 실호출
- Live shopee-bridge raw_call 호출 (현재 console.log + mock confirmation modal)
- DB INSERT (`Storage.upsertProduct`)

PRE ORDER 탭 = lifecycle_state='pre_order' 인 상품 list. 운영자가 이 list 에서 입고 처리 후 READY STOCK 전환 (5-2).

### 5-2. READY STOCK 전환 마법사 (메인)

**docs schema 정정 (2026-05-13 Sonnet 검증 — Phase B 작업 중 발견)**:
- `update_global_item` body 의 `image.image_id_list` 가 **required** (`required_params` 명시). DB 에는 image_id 안 저장 — real call 전 `get_global_item_info` 로 fetch 후 그대로 다시 push 필요. P0-4 정책으로 hard-block.
- `update_global_model` body 의 `package_height/length/width` (top-level, not under dimension) + `days_to_ship` (top-level) 가 **required**. DB 에 없음 → 동일하게 `get_global_item_info`/`get_global_model_list` 에서 fetch 후 그대로 다시 push.
- `update_global_model.weight` 는 **top-level 단일 float** (variant 별 위치 X). 각 variant 별 weight 변경 필요 시 한 product 안에서 model 단위로 fan-out (1 call = 1 model).
```
┌────────────────────────────────────────────────────────────┐
│ [상품 검색...] [region 필터: 전체 ▼] [lifecycle: PRE_ORDER ▼] │
├──────────────┬─────────────────────────────────────────────┤
│ 좌측 30%      │ 우측 70%                                     │
│ ▢ BOYNEXTDOOR │ 선택된 상품 N개 (옵션 M개)                    │
│   - opt A     │                                              │
│   - opt B     │ [옵션별 무게 입력]                            │
│ ▢ NCT 127    │   opt A: [____] g  (이전 측정: 65g)            │
│   - opt C     │   opt B: [____] g                            │
│              │                                              │
│              │ [☑ 자동 액션 (Probe 통과 항목만 enabled)]      │
│              │   ☑ 상품명 [PRE ORDER] → [READY STOCK]        │
│              │   ☑ 모든 region Days to Ship → 1              │
│              │   ☐ 무게 → Global SKU → Shop SKU (Probe 대기)  │
│              │   ☑ region별 신규 판매가 재계산                │
│              │                                              │
│              │ [🔍 미리보기]                                 │
└──────────────┴─────────────────────────────────────────────┘
```

### 5-3. 미리보기 매트릭스
- 행: region × 옵션
- 컬럼: 현재가 | 신규가 | Δ | 무게(g) | DTS | 상품명 변화 | API call 수
- 하단 요약: "총 N개 region × M개 옵션 = R 호출. dry_run 권장 ☑"

### 5-4. 실행
- "🚀 dry-run 실행" → mutation_log 에 dry_run row 들 INSERT (no Shopee call). payload_hash 는 `dry:<hash>` prefix 로 저장하여 ok 와 hash 공간 분리.
- 결과 후 행별 ✓/❌ 표시, 사용자가 dry-run 결과 만족 시 "🔥 실호출" 버튼 활성화

**P0-2 (Codex §11) — token freshness preflight (실호출 직전)**:
- 실호출 시작 직전, **region별 토큰 만료까지 < 10분** 인 경우 자동 refresh (`get_access_token` 또는 shopee-bridge `force_refresh`).
- refresh 실패 → 그 region 의 fan-out 전체 차단 (해당 region 행 모두 ❌, 다른 region 은 진행).
- 실호출 도중 invalid_access_token 응답 받으면 1회 refresh + retry. 두 번째 invalid → 차단 + 알림.

**P0-3 (Codex §11) — 부분 실패 rollback 정책 = "no auto rollback + resume tool"** 채택 선언:
- 30번째 mutation 에서 fail 발생 시 **앞서 성공한 mutation 들은 그대로 두고**, 실패 row 만 ❌ 표시 + 재시도 가능 (이미 §6 "부분 실패" 와 일치).
- 자동 reverse-mutation 안 함 (스냅샷 비용 + 부분 reverse 도중 또 fail 시 복합 inconsistency 위험).
- 대신 매 mutation 이 `mutation_log.before_payload` 에 호출 전 상태 저장 → **resume / inspect tool** 에서 1클릭 reverse 가능 (개별 row 단위).
- 운영자 명시 승인 사항.

- "🔥 실호출" → 멱등 키는 status='ok' 만 unique 이므로 dry_run row 들과 hash 충돌 없음.
- 호출 순서: region별 직렬. **region 내부 model 병렬도 = `parallel=2`** (Codex P1-5: rate-limit 검증 안 된 5 병렬보다 보수). 첫 429 burst 시 자동 throttle.
- 429/5xx 대응: exponential backoff (1s → 2s → 4s, max 3 retry), retry-after 헤더 우선.

### 5-5. 변경 이력 화면
- `shopee_mutation_log` 최근 200건 테이블
- 필터: actor, status, region, action, date range
- 행 클릭 → request_payload/response JSON pretty view

### 5-6. Probe 화면
- 사용자가 burnable global_item_id 1개 입력
- "item_name probe" 버튼 → 가짜 이름 변경 후 재조회 → 결과 표 + Pass/Fail 토글
- "weight probe" 버튼 → 가짜 무게 변경 후 재조회 → 결과
- Pass 클릭 시 `shopee_app.config` 의 flag 업데이트 + 마법사 자동 액션 enable

### 5-7. 상품 조회 & 매입가 동기화 (Phase C) — 신규
운영자가 매입가 변동 시 region별 판매가를 한 번에 맞춤. 한 화면 구성:

**상단 필터** — lifecycle (`pre_order` / `ready_stock` / 전체), region, idol/album 검색

**테이블 (정렬 가능)**
| 컬럼 | 출처 |
|------|------|
| SKU + 옵션 | products |
| Lifecycle | products.lifecycle_state |
| 현 cost (KRW) | products.cost_price (inline 편집 가능) |
| 무게(g) | products.weight |
| 6 region 현재가 | product_shopee_listings.price (region별 컬럼) |
| 신규가 미리보기 | cost × country_settings.margin_formula (inline 편집 시 즉시 계산) |
| Δ vs 현재 | 빨간/초록 색 |
| cost 마지막 갱신 | products.cost_updated_at |
| 매입가 변동 알림 배지 | cost_updated_at < now - 14d AND lifecycle = ready_stock |

**액션**
- cost 셀 inline 편집 → 6 region 신규가 즉시 계산 (UI 만, 아직 DB X)
- "🚀 dry-run" → mutation_log 에 dry_run row + 결과 미리보기
- "🔥 실호출 (선택 행 일괄)" → 행 단위 또는 전체 → `update_global_price` 로 region별 batch push + `products.cost_price` UPDATE
- 행 단위 push 도 가능 — 행 끝 "💰 push" 버튼

**안전장치**
- 매입가 변동률 > 30% 시 confirm 모달 (실수 방지)
- region별 판매가가 country_settings 의 최소가 이하면 거부 + 경고
- 모든 mutation 은 `shopee_mutation_log` 기록 (Phase B 와 동일 audit 경로)

---

## 6. 데이터 흐름 (마법사 1회 클릭)

```
사용자 [실호출 클릭]
  ↓
프론트: 마법사 payload 빌드
  - 옵션별 무게 (g)
  - region별 판매가 (cost + 마진식)
  - lifecycle_state: ready_stock
  - title 치환
  ↓
프론트: dry-run 1회 (필수, 자동) → mutation_log dry_run
  ↓ 사용자 확인
프론트: 실호출 fan-out
  for each region in [SG,TW,TH,MY,PH,BR]:    # 직렬
    parallel chunk(5) for each model:
      shopee-bridge:update_global_model { weight, sku }  # 통과 필드만
      shopee-bridge:update_global_item   { item_name }    # 통과 시
      shopee-bridge:update_global_price  { new_price }
      shopee-bridge:update_shop_days_to_ship { 1 }
    (각 호출은 mutation_log row 자동 생성)
  ↓
프론트: DB update
  products.lifecycle_state = 'ready_stock'
  products.weight_measured_at = now()
  product_shopee_listings.days_to_ship = 1
  product_shopee_listings.title_state = 'READY_STOCK'
  product_shopee_listings.last_pushed_name = new_name
  product_shopee_listings.last_pushed_at = now()
  ↓
프론트: 결과 요약
  성공 X / 실패 Y / 멱등 skip Z / drift 경고 W
```

### 부분 실패 (Codex 권고 §6-1-2 반영)
- mutation 단위 = `region + target_id + action + payload_hash`
- 실패한 row 만 "🔁 실패만 재시도" 버튼으로 재호출
- 성공 row 는 같은 payload_hash 로 두 번째 시도 시 멱등 키 충돌 → 'skipped' 응답 (중복 mutation 방지)

### Drift 감지
- 마법사 진입 시 region별 현재 `item_name`, `model_weight`, `days_to_ship` 1회 조회
- DB `last_pushed_name` 와 다르면 "외부 편집 흔적" 배지
- 사용자 확인 후 진행 (강제 차단 아님)

---

## 7. 구현 순서 (작은 commit 분할)

| # | 작업 | 검증 |
|---|------|------|
| 1 | DB 마이그레이션: §3-1 컬럼 점검 + 누락 시 추가, §3-2 `shopee_mutation_log` 생성 (1 SQL migration 파일) | Supabase SQL editor에서 `select` 컬럼 확인, mutation_log 빈 row INSERT/DELETE 테스트 |
| 2 | shopee-bridge: `update_shop_days_to_ship` 액션 추가 + 모든 mutation 액션에 mutation_log INSERT 통합 + dry-run 모드 + 멱등 키 처리 (한 commit) | 단위 호출 후 mutation_log row 생성 확인 |
| 3 | v2/index.html skeleton (빈 페이지 + nav + auth + Supabase client) → 첫 vercel deploy 로 `/v2/` 라우팅 검증 | `/v2/` 접근 시 정상 로드, console 에러 없음 |
| 4 | v2 Probe 화면 + probe 결과 `shopee_app.config` flag 저장 | burnable product 1개로 두 probe 실행, flag 업데이트 확인 |
| 5 | v2 마법사 화면 1단계: 상품 검색 + 선택 + lifecycle 필터 | PRE_ORDER 상태 상품 N개 선택 가능 |
| 6 | v2 마법사 2단계: 무게 입력 + 자동 액션 체크박스 (probe flag 기반 enable/disable) | UI 동작 확인, prefill 동작 |
| 7 | v2 마법사 3단계: 미리보기 매트릭스 + dry-run | dry-run 실행 시 mutation_log dry_run row 들 INSERT |
| 8 | v2 마법사 4단계: 실호출 fan-out + 부분 실패 재시도 + DB 상태 update | 사용자 지정 test product 1개로 end-to-end 검증, mutation_log 'ok' row 들 확인 |
| 9 | v2 변경 이력 화면 (mutation_log 200건 + 필터) | 필터 조합 확인 |
| 10 | (옵션) drift 감지 배지 | 외부에서 셀러센터 통해 수동 변경 후 마법사 진입 시 배지 노출 |

---

## 8. 검증 기준 (Codex 권고 §6-4 반영)

기존 회의록의 "5옵션×6region 1분 이내" 같은 성능 기준은 보조. 본 PR의 정량 검증은:

- 정상 케이스 1건 end-to-end: 요청 수 N, 성공 N, 실패 0, dry_run/실호출 일치
- 부분 실패 시뮬레이션 (TH region을 일부러 잘못된 shop_item_id 로 호출): 실패 row 만 ❌, 다른 region 정상, 재시도 시 실패 row 만 재호출
- 멱등 검증: 성공 직후 같은 payload 재호출 → 'skipped' 응답, mutation_log row 추가되지 않음
- 토큰 만료 시뮬레이션: invalid_access_token 응답 시 refresh + 자동 재시도 → 최종 성공
- 최종 drift 0건: 마법사 종료 후 `get_global_item_info` 로 모든 region 재조회해 마법사 결과와 일치

---

## 9. 리스크 & 미해결 이슈

1. **CBSC `update_global_model`의 weight 단위 미확정**: g/kg 어느 쪽인지 probe로 확인 필요. Shopee 문서 모순될 수 있음.
2. **region별 무게가 global model의 weight를 그대로 상속하는지 vs shop_item.weight를 따로 setting인지**: probe에서 함께 검증. 만약 shop별 setting이라면 액션 1개 더 필요 (`update_shop_item_weight`).
3. **`shopee_app.config` 테이블 존재 여부**: 없으면 `country_settings`에 boolean 컬럼 추가 또는 신규 1행 `shopee_v2_flags` 테이블.
4. **dry_run + 실호출 멱등 키 충돌**: 같은 payload_hash 로 dry_run 다음 ok 가 들어가야 함. §3-2 unique index 의 WHERE 절을 `status='ok'` 만으로 좁히거나, dry_run/ok 둘 다 허용해도 dry_run row는 별 prefix로 다른 hash 갖게 해야 함 → 구현 시 결정 (가장 단순한 해: 멱등 키는 status='ok' 만, dry_run row 는 멱등 무시).
5. **CBSC global product API payload 스펙 미해결 경고 (`index.html` line 1031)**: 현재 v1의 add_item 분기에서 명시된 경고. probe 게이트가 이 부분도 cover하는지 확인 후 v2 plan에 명시 필요.
6. **Vercel auto-deploy 미연결**: 본 plan의 모든 deploy는 `vercel deploy --prod --yes` 수동 (CLAUDE.md 명시).
7. **v1과 동시 사용 시 충돌**: v1에서도 같은 product를 편집할 수 있어 last_pushed_name 누락 가능. v2는 항상 진입 시 fresh 조회 + drift 배지로 완화.

---

## 10. 후속 작업 (본 PR 범위 외)

- Phase D-1 칸반 보드 (lifecycle_state 컬럼 활용 시각화)
- Phase C 매입가 inline 편집
- xlsx import 경로
- v1 → v2 통합/병합 (사용자 피드백 후 결정)
- 회귀 테스트 3종 (partial failure / invalid_access_token / retry same payload) — fixture 기반 자동 테스트

---

## 11. Revision (Codex)

2026-05-12 `/codex:rescue` 적대적 리뷰 결과 (액션 가능 형태).

### [P0] (본 PR 머지 전 반드시 해결)

1. **Dry-run/real-call idempotency collision (§3-2, §5-4, §9-4)** — 멱등 unique index의 WHERE 절을 `status='ok'` 단독으로 변경하고, dry_run row는 별도 경로(비-unique 또는 별도 테이블)로 저장.
   - Rationale: 현재 `status IN ('ok','dry_run')` 조건은 dry-run 직후 동일 payload_hash의 실 호출을 DB 레벨에서 차단하는 correctness 버그.

2. **Mid-run token expiry between probe and execution (§3-3, §8)** — probe 통과 후 mutation 팬아웃 직전에 region별 토큰 freshness 재확인 + 자동 refresh/retry 정책 명시.
   - Rationale: probe 성공이 이후 호출의 토큰 유효성을 보장하지 않음 → 만료 시 부분 실패가 예측 불가 형태로 발생.

3. **No operator-safe rollback for partial bulk failure (§6, §8)** — PR 머지 전 보상 동작 정책 선언 필수: "스냅샷 + 액션별 revert" 또는 "자동 롤백 없음 + 재개 도구" 중 하나 명시 선택.
   - Rationale: region/model 비-원자적 팬아웃에서 30번째 아이템 실패 시 원격 상태 혼합 + 복구 기준 없음.

4. **Silent field stripping can mask hard downstream failures (§4-1)** — 자동 실행 모드에서는 "warn + strip" 대신 "preflight hard-block, 운영자가 명시적 degraded 모드 승인한 경우에만 진행" 정책으로 교체.
   - Rationale: 필수 비즈니스 필드 없이 진행 → 이후 API에서 hard error → warn-only 무의미.

### [P1] (첫 commit 직후)

5. **Unverified concurrency/rate-limit assumption for model-5-parallel (§5-4)** — "미검증 가정" 명시 + 출시 기본값 `parallel=2` + jittered back-off + 첫 429 burst 시 adaptive throttle 보수 설정.
   - Rationale: 실제 partner rate limit 미인용 상태에서 병렬도 5는 shop/partner 한도 초과 가능.

6. **Probe scope too narrow for shop-level variance (§3-3)** — probe를 active region 당 1개 shop 이상으로 확장 또는 region별 capability matrix 선언. probe 토큰 만료 시 fail-closed.
   - Rationale: CBSC global product도 weight/logistics/dimensions 같은 shop-level 필드가 region별 다를 수 있음 → 단일 region probe는 false positive 위험.

7. **Probe token-expired branch unspecified (§3-3, §5-6)** — "probe 대상 토큰 무효" 분기: refresh 시도 → 대체 region 폴백 → non-pass 유지 순서로 명시.
   - Rationale: 결정적 분기 없으면 operator가 불안정한 probe 결과로 unsafe 동작 의도치 않게 활성화.

8. **v1/v2 concurrent write consistency under-specified (§2, §6, §9-7)** — `products.lifecycle_state` 및 `product_shopee_listings` 주요 컬럼에 `updated_at`/version 기반 optimistic locking 추가.
   - Rationale: 탭 동시 사용 시 stale read로 overwrite 발생, drift 경고는 감지일 뿐 방지 아님.

9. **Wizard interruption/resume state machine missing (§5-4, §6)** — `run_id`, `phase`, `started_at`, `aborted_at` 포함 run-level 엔티티 도입 + 모든 mutation_log row를 run_id에 연결.
   - Rationale: refresh/탭 닫기 시 orphan row + 재개/안전 중단 UX 경로 부재.

### [P2] (후속 개선)

10. **i18n/locale policy not defined for v2 UI copy (§5-1~§5-6)** — UI 텍스트 언어 소스(ko 기본, key-based, API 오류 로케일 폴백) 선언 후 문구 작성.
    - Rationale: 없으면 warn/probe/degraded-mode 메시지 일관성 상실.

11. **Vercel `/v2/` routing fallback acceptance criteria absent (§2)** — `/v2`와 `/v2/` 모두 명시적 테스트 케이스 + 실패 시 동작(hard 404 vs redirect) 정의 deploy 체크리스트에 추가.
    - Rationale: 현재 "rewrite 필요 가능성" 메모만 있고 misconfig 시 user-visible 결과 미정의.

12. **Mutation audit schema lacks run/actor granularity (§3-2, §4-3, §5-5)** — `run_id`, `operator_id`, normalized `region/shop_id`, `request_id` 인덱스 추가.
    - Rationale: 현 로그로는 cross-tab/operator 인시던트 재구성 및 재실행 경계 파악 어려움.

13. **Field-unit assumptions expire without TTL (§3-3, §9-1)** — probe 결과(request/response sample + timestamp + region/shop) persist + capability flag에 TTL 설정.
    - Rationale: 일회성 probe는 API 동작/계정 설정 변경 시 stale → 주기적 재검증 필요.

### Codex Summary

최상위 시스템 리스크는 **부분 실패 하에서의 실행 의미론(idempotency, rollback, resume)이 일관된 트랜잭션 모델을 갖추지 못한 것**. 두 번째는 **rate limit, probe 대표성, 토큰 수명 등 미검증 가정**에 대한 신뢰로 정상 운영을 간헐 장애로 전환시킬 수 있음. 세 번째는 **v1/v2 동시 쓰기 일관성**으로, 강한 concurrency guard 없이는 운영 메타데이터가 조용히 덮어쓰임. 머지 전 commit 경계, 실패 복구, capability 게이팅 규칙을 명확히 정의해야 운영자가 스트레스 상황에서도 결과 예측 가능.

### Opus 응답 (반영 계획)

- P0 1~4: 다음 plan revision pass에서 본문 §3-2/§4-1/§5-4/§6에 직접 반영 (별도 task로 분리).
- P1 5~9: 본 PR 첫 commit 직후, 마법사 skeleton 구현 전에 plan에 흡수.
- P2 10~13: backlog에 추가, 마법사 동작 검증 후 적용.
- 특히 **P0-1 (idempotent index)** 와 **P0-3 (rollback 정책)** 는 사용자에게 선택 요청 후 결정.

### P0 implementation note (2026-05-12)

- P0-1 idempotency: `uidx_shopee_mutation_log_idempotent` is scoped to `where status = 'ok'`. Dry-run rows keep the same payload hash for operator comparison, but they no longer block a later real call.
- P0-2 token freshness: v2 real mutations force token refresh immediately before execution. Merchant/global mutations refresh or issue the merchant token; shop-level `update_shop_days_to_ship` refreshes the region shop token.
- P0-3 partial failure policy: selected **no automatic rollback + resume tooling**. Each mutation logs `rollback_policy='no_auto_rollback_resume_only'`; operators inspect failed rows via `v2_failed_mutations` and retry them via `v2_resume_failed`.
- P0-4 probe gating: `item_name`/`description` and model `weight` are preflight hard-blocked until probe flags pass. Degraded execution requires explicit `allow_degraded=true`, `degraded_approval='APPROVE_V2_DEGRADED_MUTATION'`, and the exact `approved_blocked_fields` list.
