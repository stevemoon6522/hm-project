# Plan: v2/ 상품 등록 — 옵션 묶음 1 Global Product + N Models (마스터 저장 + Shopee 발행)

- 작성일: 2026-05-22 (v1 초안 → v2 운영자 답변 #767/#768/#770 반영)
- 작성자: Opus (Claude Code)
- 트리거: 운영자 메시지 #767 "Master 상품 등록할때 옵션 상품들의 경우 Shopee에 1개의 Global product에 여러 옵션으로 해서 상품 등록"
- 선행 문서: `plans/v2-wizard-plan.md`, `plans/register-shopee-rebuild-phase-a.md`, [[project_sd_shopee_publish_root_causes]]
- Codex 적대적 리뷰: 미실시 (이 plan 완성 후 `/codex:rescue` 진행)

---

## 0. 운영자 결정 요약 (msg #767 / #768 / #770 확정)

| 번호 | 결정 |
|------|------|
| 1 | 멤버 행 복제로 생성된 행 = 1 Global Product 의 여러 옵션. 별개 상품 아님. UI 도 그렇게 보이도록 정리. |
| 2 | URL 한 개로 시작 → 그 안에 옵션 행 추가하는 흐름. (현재 카드 단위 입력 패턴 유지) |
| 3 | 기본 1축, 필요 시 2축 확장 가능. Shopee 2축 정식 지원 (조합 ≤ 50). |
| 4 | **옵션별 가격/무게 다를 수 있음**. 옵션 행 단위로 입력. |
| 5 | **옵션별 이미지 다를 수 있음**. 옵션 행 단위로 입력. |
| 6 | StarOneMall 옵션 자동 인식 안 함. 운영자 수동 입력. |
| 7 | 기존 잘못 분리 상품 정리 안 함 (운영자가 삭제 처리). 신규부터 적용. |
| 8 | **마스터 저장 + Shopee 발행 한 번에**. 1단계 + 2단계 분리 안 함. |
| 9 | SKU 운영자가 옵션 행마다 수동 입력. 자동 조립 제거. |

---

## 1. 목표 / 비목표

### 본 plan 목표 (단일 단계, 운영자 결정 #8 반영)
- 운영자가 v2/ `view-register` 에서 URL 1개 입력 + 옵션 행 N개 추가 → 한 카드 안에서 모두 입력.
- 옵션 행 단위로 SKU/매입가/무게/이미지 입력. 카드 헤더 값은 옵션 행 prefill 용 기본값 (UI 도우미).
- 운영자가 옵션 축 모드 토글 (1축 기본 / 2축 확장).
- "전체 등록 → 상품 목록" 클릭 시 한 사이클 안에서:
  1. 마스터 데이터 (products + product_shopee_listings) INSERT — 옵션 묶음 정보 포함.
  2. Shopee `register_cbsc` 호출 — 1 Global Product + N Models + 6 region publish + polling.
  3. 발행 응답의 `global_item_id` / `global_model_id` 를 products row 들에 sync.
  4. 발행 실패 region 은 listing row 의 last_error 에 표시, 마스터는 살려두고 재시도 가능.

### 본 plan 비목표
- legacy view-register-legacy 의 5-step wizard 삭제 (남겨두고 view-register 만 옵션 묶음 + 발행 지원).
- 옵션 자동 인식 (크롤러 파싱).
- 기존 product 마이그레이션.
- 옵션별 무게/이미지의 Shopee 측 정식 검증 — docs 가 부분적으로 모호 (§2-4 참조), best-effort 매핑 + 발행 후 verify.

---

## 2. Shopee API 매핑 (docs_ai 검증)

### 2-1. tier_variation 구조 (init_tier_variation body)
```
tier_variation: [
  // axis 0
  { name: "멤버", option_list: [{option: "셔누"}, {option: "형원"}, ...] },
  // axis 1 (운영자가 토글 켜면 등장)
  { name: "버전", option_list: [{option: "A ver."}, {option: "B ver."}] }
]
```

shopee-bridge `normalizeVariation` (line 1396-1403) 가 이미 tier ≤ 2 + model ≤ 50 검증. 운영자 결정 3 와 일치.

### 2-2. global_model[] (init_tier_variation + add_global_model body)
현재 bridge `buildGlobalModels` (line 1405-1414) 가 model 마다 채우는 필드:
```
{ tier_index, global_model_sku, original_price, normal_stock }
```

운영자 결정 4 (옵션별 가격/무게) 반영하려면 bridge 의 `buildGlobalModels` 에 다음 필드 추가:
- `seller_stock: [{ stock }]` (normal_stock 2024-10-23 sunset, docs 명시).
- `weight` (옵션별 — 단 model[] 안의 위치인지 top-level batch 인지 docs 모호, §2-4 참조).

### 2-3. 옵션별 이미지 (image)
- 자유 텍스트 tier_variation 의 `option_list[].image` request body 에 명시 안 됨 (init_tier_variation docs).
- 그러나 init_tier_variation **응답** 에는 `response.tier_variation[].option_list[].image.image_url` 존재 (line 765-776) — 즉 Shopee 내부적으로는 옵션별 이미지 슬롯 있음.
- 매핑 경로 (검증 필요):
  - **경로 A**: init_tier_variation body 의 `tier_variation[].option_list[].image` (자유 텍스트 채널) 에 직접 image 객체 보내기 — undocumented but legacy wizard 패턴이 비슷.
  - **경로 B**: 발행 후 별도 `update_tier_variation` 호출로 옵션별 image_id 갱신 — KRSC 가 shop-level update_tier_variation 차단인지 검증 필요.
  - **경로 C**: standardise_tier_variation 사용 (variation_option_list[].image_id, line 477) — Shopee 가 인식하는 standard variation 매핑 필요, K-pop 멤버 옵션은 standardise 안 됨.
- **MVP 선택**: 경로 A 시도 → bridge `buildGlobalModels` 에 image 필드 추가, Shopee 가 reject 하면 발행 후 update_tier_variation 으로 fallback. plan 에 "옵션별 image 매핑 verified 후 확정" 명시.

### 2-4. 미해결 docs 항목 (live probe 로 확정)

Explore agent docs 광범위 grep (2026-05-22) 결과 통합. 11개 unverified 항목 — live probe gate (§7 step 5.5) 에서 모두 확정 필요.

1. **옵션별 weight (model-level)** — add_global_model / update_global_model docs 양쪽 body_params 의 `weight` 가 top-level (model[] 밖). 그러나 update_log 2024-05-29: "add model level weight and dimension" — body 명세와 update_log 가 불일치. probe 결과 (a) 한 호출의 모든 model 공통 / (b) 사실상 1 호출 = 1 model 처리 / (c) `global_model[].weight` 가 undocumented 받음 중 어느 것인지 확정.
2. **옵션별 image** — free-text tier_variation 의 `option_list[].image` 가 request body 에 명시 안 됨. response 에는 `tier_variation[].option_list[].image.image_url` (init_tier_variation L765-776). 경로 A (request body 패스스루) probe.
3. **옵션별 dimension (model-level)** — #1 과 동일 위치 패턴. top-level body_params + update_log 의 "model level dimension" 불일치.
4. **옵션별 days_to_ship (model-level)** — add_global_model body 의 `days_to_ship` 도 top-level. update_log 2024-06-21: "add model level DTS" 명시. body 에 `global_model[].pre_order.days_to_ship` 패스 가능 여부 probe.
5. **tier_index 배열 의미** — `global_model[].tier_index: int32[]`. tier_variation 가 axis 1개일 때 `[option_idx]`, 2개일 때 `[axis0_idx, axis1_idx]` 인지, 또는 다른 좌표 표현인지. add_global_model docs L194 description 이 "If you want to update one tier/two tier to no tier, can just pass the tier_variation and standardise_tier_variation as []" 라고만 명시 → axis 수와 tier_index 배열 길이 관계 모호.
6. **add_global_model 호출 전 init_tier_variation 강제** — add_global_model error `error_busi_cannot_update_model_for_no_tier_item`: "Item without tier_variation. Please use init_tier_variation api to upgrade." → init 안 거치고 add_global_model 직접 호출 불가. bridge 흐름 (init → add) 이 강제 sequencing 임을 명문화. **shopee-bridge `register_cbsc` 가 baseVariation 있으면 init 먼저 호출하고 있음 (line 2529-2541, 검증 완료).**
7. **add_global_model `model_list` vs docs `global_model`** — docs body_params 는 `global_model` (object[]). shopee-bridge 가 `model_list` 로 보냄 (line 2256, 2538). KRSC undocumented variant 가능성 → probe 통과 시 둘 다 시도하거나 model_list 가 정식인지 확인.
8. **normal_stock sunset 후 잔존** — 2024-10-23 sunset 선언이지만 add_global_item / add_global_model body_params 에 여전히 optional 로 명시. seller_stock 단일 사용 OK 인지, 양쪽 모두 보내야 reject 안 되는지 probe.
9. **update_tier_variation 2025-09-12 deprecated** — v2.product.update_tier_variation docs L19: "The tier_variation structure in the documentation has been deprecated." → **발행 후 옵션 추가/이름 변경/이미지 갱신 경로 차단 가능**. migration path 미명시. KRSC 에서 사용 가능 여부 + 대체 API (standardise_tier_variation?) 검증 필수. **운영자 결정 필요 (P0)**: 발행 후 옵션 수정 불가능을 전제로 등록 흐름 설계할지, deprecated 라도 사용해서 우회할지.
10. **model[].original_price > 0 강제** — add_global_model error `error_busi_global_item_price_should_bigger_than_zero`. global item original_price 와 model original_price 사이 cross-field validation (예: model price ≥ item price?) docs 미명시. probe.
11. **KRSC 옵션 endpoint 차단 여부** — regional_rules.json 17 rule 중 tier_variation / add_global_model / update_global_model 차단 명시 없음. KRSC API integration guide 에도 옵션 흐름 별도 가이드 부재. **shop-level update_tier_variation 은 KRSC 차단 가능성** (다른 shop-level /api/v2/product/* 전부 차단 패턴) → 결정 #9 와 결합해 발행 후 옵션 수정 경로 자체가 사실상 막혀 있을 위험.
12. **tier_variation 의 tier 수/option 수 한계** — error_codes 에 `error_busi_global_tier_variation_over_limit` + `error_busi_global_item_tier_option_over_limit` 있지만 한계값 숫자 docs 미명시. plan §2-5 의 "조합 ≤ 50" (update_tier_variation docs L825 "Count of 2-level variations combinations should be under 50") 외에는 axis 별 option 수 한계, item 당 tier 수 한계 등 미확정. 안전한 boundary 권고: 1축이면 option ≤ 50, 2축이면 각 axis ≤ 약 7-8 (조합 ≤ 50 만족).
13. **model response 의 image_url 포함 여부** — init/add/update_global_model 의 response 정의가 `error/message/warning/request_id` 만. model 별 image_url 이 반환되는지 별도 GET 호출 (`get_global_model_list`) 으로 확인.
14. **KRSC variation 초기화 경로 docs 미명시** — KRSC 가이드는 "Global Product API + Merchant API 만 사용" 요구. 그러나 `init_tier_variation` 은 shop-level Product API (v2.product.init_tier_variation) docs 만 존재, global_product 경로 docs 부재. shopee-bridge 가 `/api/v2/global_product/init_tier_variation` 호출 중 + KRSC 환경에서 verified ([[project_v2_krsc_wizard]] 검증). 문서가 닫혀 있지 않다는 점만 plan 에 명문화 — probe 통과 + 운영 모니터링으로 보강.
15. **update_global_model 의 required_params 와 body 예시 불일치** — required_params 에 `package_height/length/width`, `days_to_ship` 표기되지만 body 예시 payload 에는 누락. 실제 호출 시 어떤 최소셋이 통과하는지 불명. 운영 시 필수 필드 표 별도 관리 + 422 응답 받으면 누락 필드 추정.
16. **update_global_model 에서 옵션별 image 수정 경로 부재** — body_params 에 `image` 필드 자체가 없음. 즉 발행 후 옵션별 이미지 변경은 docs 상 불가능. 결정 #5 (옵션별 이미지) 와 결합 → 초기 발행 시점에 옵션별 이미지를 한 번에 정확히 세팅해야 하고, 이후 변경하려면 카드 전체 재발행 (delete_global_item → 재발행) 외 경로 없음.

### 2-5. KRSC publish 5가지 root cause 통과 (이미 bridge 에 구현됨)
[[project_sd_shopee_publish_root_causes]] 의 5가지 — item_status=NORMAL / region 별 image upload / pre_order channel filter / BR 2-image / shop_publishable_status pre-check — 모두 `register_cbsc` 에 이미 구현됨 (CORTIS ACAI / 박재범 LNGSHOT 2026-05-22 검증). 본 plan 은 그 위에 옵션 묶음 입력만 얹음.

---

## 3. 데이터 모델 변경

### 3-1. products 테이블 — 옵션 묶음 컬럼 추가
```sql
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS product_group_id uuid,
  ADD COLUMN IF NOT EXISTS variation_tier_index integer[],
  ADD COLUMN IF NOT EXISTS variation_tier_names text[],
  ADD COLUMN IF NOT EXISTS variation_option_names text[];

CREATE INDEX IF NOT EXISTS idx_products_product_group_id
  ON public.products (product_group_id);

ALTER TABLE public.products
  ADD CONSTRAINT products_variation_consistency_check
    CHECK (
      (variation_tier_index IS NULL AND variation_option_names IS NULL)
      OR (array_length(variation_tier_index, 1) = array_length(variation_option_names, 1))
    );

ALTER TABLE public.products
  ADD CONSTRAINT products_variation_tier_names_len_check
    CHECK (
      variation_tier_names IS NULL
      OR (array_length(variation_tier_names, 1) BETWEEN 1 AND 2)
    );
```

기존 컬럼 `cost_krw`, `weight_g`, `main_image`, `extra_images`, `sku`, `option_name` 은 그대로 — 옵션 행마다 다른 값 가짐.

### 3-2. product_group_id 규칙
- 단독 상품 (옵션 0 또는 1): `product_group_id = id` (INSERT 직후 self-reference).
- 옵션 묶음 (2+): 묶음의 첫 row id 를 다른 모든 row 에 동기.

### 3-3. product_shopee_listings — 그대로
- (product_id, region) primary key 유지.
- 같은 그룹의 N products × 6 region = N×6 listing rows.
- Shopee 발행 후 응답에서 받은 `global_item_id` 는 같은 group 의 모든 listing row 가 동일.
- `global_model_id` 는 product row 별로 다름 (옵션별 model).
- `shop_id`, `shop_item_id`, `shop_model_id` 는 region 별 응답에서 채움.

---

## 4. RPC 신설 — promote_source_group_to_products

### 4-1. 시그니처
```sql
create or replace function public.promote_source_group_to_products(
  p_source_record_id uuid,
  p_lifecycle_state text default 'pre_order',
  p_variation_tier_names text[],        -- ["멤버"] 또는 ["멤버","버전"]
  p_variation_options jsonb,            -- 옵션 행 배열 (아래 구조)
  p_card_header_overrides jsonb default null  -- 카드 공통값 (백업/기본값 prefill)
) returns table (product_id uuid, sku text, group_id uuid, row_status text)
```

### 4-2. `p_variation_options` 구조 (옵션 행마다 1 객체, 모두 필수)
```json
[
  {
    "sku": "PO-XSH-LOVEM-LOV-SHN",            // 운영자 수동 입력
    "cost_krw": 78408,                         // 옵션별 매입가
    "weight_g": 150,                           // 옵션별 무게
    "main_image": "https://...",               // 옵션별 메인 이미지 URL
    "extra_images": ["https://..."],           // 옵션별 추가 이미지
    "option_names": ["셔누"],                  // 1축이면 길이 1, 2축이면 길이 2
    "tier_index": [0],                         // 좌표
    "collision_mode": "reuse" | "overwrite"
  },
  ...
]
```

### 4-3. 동작
1. source_record FOR UPDATE 조회 → 크롤 데이터 (title, image, description) 백업.
2. **트랜잭션 안에서** 옵션 row 별로 INSERT/UPDATE 분기.
3. 첫 row id 캡처 → 모든 row 의 product_group_id 동일 set.
4. source_record.status = 'published', linked_master_product_id = group_id, batch_id = crawl_run_id.
5. audit_log INSERT (action='approve_group').

### 4-4. 멱등
- 같은 source_record + 동일 SKU set 재호출 → 이미 published 면 거부 (운영자가 row 별 collision_mode='overwrite' 명시 시만 진행).

### 4-5. 옵션 0/1 케이스
- 옵션 0: 기존 `promote_source_to_product` 로 fallback (UI 가 분기).
- 옵션 1: group RPC 호출. variation_tier_names = ["멤버"], variation_option_names = [그 옵션명], variation_tier_index = [0]. → 단독 상품이지만 group 구조 안에 일관성 유지.

---

## 5. UI 변경 (v2/index.html `view-register`)

### 5-1. 카드 구조 (운영자 결정 #2, #4, #5, #9 반영)
```
┌─────────────────────────────────────────────────────────────────────────┐
│ #1 카드 — 1 상품 / N 옵션                                                │
│ [앨범 이미지 대표]                                                       │
│ URL: https://staronemall.com/...                                        │
│ 제목: 서누X형원 SHOWNU X HYUNGWON ... LOVE ME (LOVE RING VER.)           │
│                                                                          │
│ 기본 매입가 (KRW): [78,408]  기본 무게 (g): [150]                        │
│   ↑ 새 옵션 행 추가 시 prefill 용 기본값 (옵션 행에서 개별 수정 가능)     │
│                                                                          │
│ tier_variation 축 ① 이름: [멤버____]                                     │
│ [+ 옵션 축 추가]   (2축 모드 토글)                                       │
│                                                                          │
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ 옵션 행 ①                                                            ││
│ │   멤버: [SHN___]                                                     ││
│ │   SKU: [PO-XSH-LOVEM-LOV-SHN_____]                                   ││
│ │   매입가(KRW): [78408]  무게(g): [150]                               ││
│ │   메인 이미지 URL: [https://...]   추가 이미지: [+ URL]               ││
│ │   [X 제외]                                                           ││
│ ├─────────────────────────────────────────────────────────────────────┤│
│ │ 옵션 행 ②                                                            ││
│ │   멤버: [HYW___]   SKU: [PO-XSH-LOVEM-LOV-HYW_____]                  ││
│ │   매입가(KRW): [78408]  무게(g): [150]                               ││
│ │   메인 이미지 URL: [https://...]                                     ││
│ │   [X 제외]                                                           ││
│ ├─────────────────────────────────────────────────────────────────────┤│
│ │ ...                                                                  ││
│ └─────────────────────────────────────────────────────────────────────┘│
│ [+ 옵션 행 추가] [X 카드 전체 제외]                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5-2. 2축 모드 (옵션 축 추가 토글 ON)
- 카드 헤더에 두 번째 tier 이름 input 등장.
- 옵션 행에 두 번째 축 input 추가 (예: "버전: [A___]").
- SKU 는 옵션 행 단위로 운영자가 수동 입력 (자동 조립 제거).
- 좌표 자동 계산: 운영자가 입력한 옵션명을 카드 안에서 unique 매핑해서 axis별 인덱스 부여 (옵션 행 단위 옵션명 입력 → 카드 단위 옵션명 집합 → tier_index 좌표).

### 5-3. 변경되는 함수 (v2/index.html)
| 함수 | 변경 |
|------|------|
| `mrRenderPreviewCards` (line ~10300) | 같은 source_record_id 의 옵션 행을 한 카드 안에서 렌더. 옵션 행 단위로 SKU/매입가/무게/이미지 input. |
| `mrComputeSku` (line ~10456) | **삭제 또는 deprecate** — 자동 조립 제거. 운영자 수동 입력. prefill 도우미 함수로 남길 수 있음 (예: 1축 prefix 자동 제안). |
| `mrPromoteAll` (line ~10446) | 같은 source_record_id row 들을 group 화 → group RPC 호출 → 응답 받기 → Shopee `register_cbsc` 호출 → listing 매핑 INSERT. |
| `addVariantRow` (legacy, line 4980) | 본 plan 영향 없음 (legacy wizard 그대로). |

### 5-4. 검증 (UI 사전)
- 카드 안 옵션 행 SKU 중복 → inline error.
- 옵션 행 매입가/무게 0 또는 빈값 → row 단위 error.
- 옵션 행 메인 이미지 URL 비어 있음 → row 단위 error (Shopee 발행 시 image required).
- 2축 좌표 (option_names 쌍) 중복 → inline error.
- 2축 조합 수 > 50 → 사전 차단.
- 카드 안 옵션 행 0개 → 단독 상품 분기 (기존 promote RPC).

---

## 6. 데이터 흐름 (운영자 "전체 등록" 클릭 → 한 사이클)

```
운영자 카드에 옵션 행 입력 (옵션별 SKU/매입가/무게/이미지)
  ↓
프론트 사전 검증 (§5-4)
  ↓
1. RPC promote_source_group_to_products(source_record_id, options[], tier_names)
   → DB 트랜잭션 안에서 products N row INSERT + product_group_id 동일 + audit_log
   → 응답: [{product_id, sku, group_id, row_status}, ...]
  ↓ (모든 row 성공 시)
2. Shopee 발행 — shopee-bridge `register_cbsc` 호출 (카드 단위)
   body: {
     region: 'SG', // primary region (publishable_shop 조회용)
     name, sku, category_id, image_id_list (대표),
     variation: { tier_variation, model: [...] }, // 옵션 행 → bridge 가 buildGlobalModels 로 변환
     targets: [
       { region: 'SG', shop_id, days_to_ship, price (region별), image_id_list (region별), ...},
       ...6 region
     ],
     lifecycle_state: 'pre_order',
     is_pre_order: true
   }
   → bridge atomic 흐름:
     a) add_global_item → global_item_id
     b) init_tier_variation (첫 model)
     c) add_global_model (나머지 models)
     d) get_publishable_shop + get_shop_publishable_status pre-check
     e) for each region: create_publish_task + get_publish_task_result polling
   → 응답: { global_item_id, results: [{region, ok, shop_id, shop_item_id, shop_model_ids, error?, message?}, ...] }
  ↓
3. 응답 매핑 → DB UPDATE
   - products.shopee_item_id = global_item_id (같은 그룹 모든 row 동일)
   - products.global_model_id = 각 model 의 응답에서 매핑 (tier_index 좌표로 매칭)
   - product_shopee_listings (group × region × variants):
     - region 별 shop_id, shop_item_id, shop_model_id (variant 별)
     - status='published' 또는 'failed', last_error, last_pushed_at
  ↓
4. UI: 카드 옵션 행 상태 표시 (✓ region별 발행 결과, ❌ 실패 region + 사유)
   - 일부 region 실패 시 카드 status='partial_done', 운영자가 재시도 또는 무시
   - 모든 region 실패 시 카드 status='failed' (마스터는 살림, 재시도 가능)
   - 모든 region 성공 시 카드 status='done'
  ↓
loadData() → 상품 목록 view 갱신
```

### 6-1. 부분 실패 — Failure State Machine (Codex P0-2)

DB 측 product row 에 명시적 발행 상태 컬럼을 추가해 Shopee 와 DB state divergence 를 추적한다.

```sql
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS shopee_publish_state text NOT NULL DEFAULT 'unpublished';

-- 상태 enum: 'unpublished' | 'pending_publish' | 'published' | 'partial_published' | 'publish_failed' | 'cleanup_required'
ALTER TABLE public.products
  ADD CONSTRAINT products_shopee_publish_state_check
    CHECK (shopee_publish_state IN ('unpublished','pending_publish','published','partial_published','publish_failed','cleanup_required'));
```

**state transition + cleanup ownership**:

| 단계 실패 | DB row 상태 | Shopee 상태 | Cleanup 책임 | 운영자 액션 |
|----------|-----------|-----------|--------------|------------|
| promote_group RPC | (트랜잭션 rollback, row 자체 없음) | — | — | SKU/필드 수정 후 재시도 |
| add_global_item | `unpublished` (shopee_item_id null 유지) | 없음 | — | 카드 그대로 재시도 |
| init_tier_variation | `cleanup_required` (shopee_item_id 보존) | orphan global_item 존재 | **자동 delete_global_item 시도 (bridge 책임)**, 실패 시 `cleanup_required` 유지 + 텔레그램 알림 | 알림 받고 셀러센터 정리 후 운영자가 cleanup_required → unpublished 로 수동 reset |
| add_global_model 부분 실패 | `partial_published` (shopee_item_id + 일부 global_model_id) | global_item + 일부 model | **자동 cleanup 안 함** (위험), `partial_published` 상태 유지 + 알림 | 운영자 결정: 부분 발행 살리거나 (남은 model 만 add_global_model 재시도) 카드 전체 삭제 (delete_global_item) |
| create_publish_task region 별 실패 | `published` (모든 region 실패 시 `publish_failed`) | global_item OK, region publish 일부/전체 실패 | bridge 가 listing.last_error 자동 기록 | 운영자 그 region 만 재시도 |

**bridge 측 책임** (shopee-bridge/index.ts 변경):
- `register_cbsc` 가 stage 마다 명시적 stage 코드 반환 (이미 `stage='add_global_item'|'init_tier_variation'|'add_global_model'|'create_publish_task'` 반환).
- init_tier_variation 실패 시: 자동 `delete_global_item(global_item_id)` 시도. 성공 시 `cleanup_done`, 실패 시 `cleanup_required` 응답.
- add_global_model 부분 실패: 자동 cleanup 안 함, `partial_published` 응답 + 성공/실패 model 목록 반환.

### 6-2. 멱등성 — Card-level Idempotency Token (Codex P0-3)

`source_record.status='published'` guard 만으로는 double-click, tab duplication, slow network retry, browser refresh 대비 부족. **카드 단위 idempotency_token** 도입.

**메커니즘**:
1. 운영자가 "전체 등록" 클릭 → 프론트가 **카드 단위로 UUID idempotency_token 1회 생성** (브라우저 세션 내 카드 객체에 attach).
2. promote_source_group_to_products RPC body 에 `p_idempotency_token` 전달.
3. RPC 안에서 idempotency_token 으로 in-flight lock + duplicate 검증:
   - **DB 측 token 저장 테이블**:
     ```sql
     CREATE TABLE IF NOT EXISTS public.v2_register_idempotency (
       idempotency_token uuid PRIMARY KEY,
       source_record_id uuid NOT NULL,
       product_group_id uuid,
       state text NOT NULL CHECK (state IN ('in_progress','completed','failed')),
       result jsonb,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     );
     ```
   - RPC 시작 시 token INSERT (state='in_progress'). UNIQUE 제약으로 duplicate 호출 차단 → 이미 있으면 그 row 의 result 반환 (이전 결과 그대로).
   - RPC 완료 시 state='completed' + result jsonb 저장.
   - 에러 시 state='failed' + 에러 사유 저장 → 같은 token 으로 재시도 가능 (UNIQUE 제약은 token 별이므로 새 token 으로 새 요청 가능).
4. `register_cbsc` 호출에도 동일 token 을 `request_id` 로 전달 → bridge 가 중복 publish 차단 (이미 동일 token 으로 발행한 적 있으면 이전 응답 반환).

**효과**:
- 운영자가 "전체 등록" 두 번 누르거나 새 탭에서 같은 카드 다시 열어 등록해도 동일 token 이라 두 번째 호출은 첫 결과 반환.
- 다른 카드는 별 token 이라 정상 진행.
- 운영자가 의도적으로 같은 source_record 를 새로 발행하려면 (예: 카드 삭제 후 재생성) 새 카드 객체 = 새 token 이므로 정상 진행.

**RPC 호환**: 기존 promote_source_to_product 도 idempotency_token 파라미터 추가 (optional, NULL 허용). NULL 인 경우 기존 동작 그대로 (source_record.status guard).

---

## 7. 구현 순서 (작은 commit 분할 — Codex P0-1 probe gate 반영)

| # | 작업 | 영향 파일 | 검증 |
|---|------|----------|------|
| 1 | DB 마이그레이션 — products 컬럼 4개 + CHECK + 인덱스 | `supabase/migrations/202605220001_v2_register_variants.sql` | Supabase SQL editor 컬럼/CHECK 확인 |
| 2 | DB 마이그레이션 — `promote_source_group_to_products` RPC + idempotency_token 컬럼 | 같은 마이그레이션 파일 | RPC 단위 호출: 가짜 source + variation_options 2개 → 2 row INSERT + group_id 동일 + idempotency_token unique |
| 3 | UI 카드 구조 변경 — 옵션 행에 SKU/매입가/무게/이미지 input + 1축 모드 | `v2/index.html` view-register 영역 + `mrRenderPreviewCards` | 운영자가 멤버 행 복제 → 같은 카드 안에 옵션 행 추가, 옵션 행별 입력 가능 |
| 4 | UI + 프론트 — 1축 카드 promote_group RPC 호출 (Shopee 발행 X 먼저) | `mrPromoteAll` 분기 | 카드 1장 (3 옵션) DB 저장 + group_id 동일 + variation_tier_index 확인 |
| 5 | shopee-bridge `buildGlobalModels` 확장 — seller_stock 사용 + weight + image_url 필드 추가 | `shopee-bridge/index.ts` line 1405-1414 | unit: 모델 별 seller_stock/weight/image 필드가 payload 에 포함 |
| **5.5** | **Live Probe Gate (Codex P0-1)** — 운영자 burnable product 1개로 옵션별 weight / 옵션별 image / seller_stock 매핑이 실제로 Shopee 에서 verify 되는지 확인. 결과 기반으로 `shopee_app.config` 의 `probe_per_model_weight_ok`, `probe_per_option_image_ok` flag 갱신. **Gate 통과 안 한 항목은 step 6 의 publish payload 에서 strip + 발행 후 update_global_model fallback 호출**로 우회. | `view-probe` 확장 + bridge unit test | 두 flag 가 명시적으로 PASS/FAIL 기록, step 6 분기 동작 확인 |
| 6 | UI 발행 트리거 — `register_cbsc` 호출 + 응답 매핑 (shopee_item_id, global_model_id, product_shopee_listings) + idempotency_token 전달 + probe gate flag 분기 | `mrPromoteAll` 후속 단계 | 카드 1장 end-to-end: DB 저장 → Shopee 발행 (test product) → listing row 확인 → double-click 멱등 차단 확인 |
| 7 | UI 2축 모드 토글 + 좌표 자동 계산 + 2축 SKU 검증 | `v2/index.html` | 2축 카드 end-to-end |
| 8 | Codex 코드 리뷰 + 패치 + 운영자 sandbox 1 카드 (3 옵션) 검증 + 배포 | — | end-to-end 통과 |

---

## 8. 검증 기준 (Codex §6-4 패턴)

- **1축 3옵션 end-to-end**: DB 3 row INSERT + group_id 동일 + Shopee 1 global_item + 3 global_model + 6 region publish (이미지 통과 region 만, 실패 region 은 listing.last_error 기록) + drift 0.
- **2축 4조합 end-to-end** (2 멤버 × 2 버전): DB 4 row + tier_index 좌표 [0,0]/[0,1]/[1,0]/[1,1] 각각 unique + Shopee 4 global_model.
- **단독 상품** (옵션 0): 기존 promote RPC + add_global_item only (init_tier_variation/add_global_model skip) + 6 region publish.
- **옵션별 다른 매입가/무게/이미지**: DB 저장 정확, Shopee 응답에서 model 별 값 readback 일치.
- **SKU 중복 사전 차단**: 카드 안 + 전체 products 양쪽 모두.
- **부분 실패**: TH region 만 실패 시 다른 region 살림, listing 6 row 중 5 ✓, 1 ❌.
- **멱등**: 동일 source_record 두 번 호출 → 두 번째 거부.
- **2축 조합 50 초과 차단**: 운영자가 51개 조합 시도 시 사전 차단.

---

## 9. 리스크 & 미해결 이슈

1. **옵션별 weight 매핑** (§2-4-1): Shopee docs 가 model[].weight 명시 안 함. probe 로 확정. 안 되면 fallback: 발행 시 max(weights) 사용 + 발행 후 update_global_model 으로 model 별 갱신.
2. **옵션별 image 매핑** (§2-4-2): 자유 텍스트 tier_variation 의 option_list[].image 가 request body 에서 받아지는지 unverified. fallback 동일 (probe + update).
3. **shopee-bridge `buildGlobalModels` 수정**: 현재 normal_stock 사용 (2024-10-23 sunset). 본 plan 의 step 5 가 seller_stock 으로 마이그레이션. 다른 호출 (legacy register_cbsc 등) 도 영향 받음 — 회귀 테스트 필요.
4. **카드 헤더 prefill ↔ 옵션 행 override 분리**: 카드 헤더의 매입가/무게는 prefill 도우미만이고 실제 저장값은 옵션 행. 운영자가 카드 헤더만 채우고 옵션 행 안 채우면 발행 차단 (옵션 row 가 0 또는 빈값 → 발행 안 됨).
5. **2축 좌표 매핑**: 운영자가 옵션 행에 옵션명 입력 → 카드 안에서 axis 별 unique 옵션 set 만들기 → tier_index 좌표 부여. 같은 옵션명 정규화 (공백 trim, 대소문자) 필요.
6. **legacy view-register-legacy read-path 호환 (Codex P0-4)**: legacy wizard 는 write path 에서 variation_* 컬럼 안 채우지만, 새 plan 의 view-register 가 만든 grouped products 를 legacy 화면이 어떻게 읽어 표시할지 contract 명시:
   - **상품 목록 (view-products)**: 같은 product_group_id row 들을 flat list 로 표시. group 의 첫 row (variation_tier_index 가 가장 낮은 좌표) 가 "대표 row" 로 셀러센터 link / shopee_item_id 보여줌. 나머지 row 는 동일 shopee_item_id + global_model_id 별로 표시.
   - **product_name + option_name 표시 규칙**:
     - variation_* 가 NULL: 기존 단독 상품 → `product_name` 만 표시.
     - variation_tier_names = ["멤버"]: row 표시 = `product_name` + " — " + variation_option_names[0]. 예: "SHOWNU X HYUNGWON LOVE ME — 셔누".
     - variation_tier_names = ["멤버","버전"]: row 표시 = `product_name` + " — " + variation_option_names.join(" / "). 예: "... — 셔누 / A ver.".
   - **legacy 5-step wizard 진입 차단**: legacy wizard 가 새 group row 를 편집 모드로 열면 (현재 가능) 데이터 손상 위험. variation_tier_index IS NOT NULL row 는 legacy wizard 에서 read-only 표시 + "옵션 묶음 상품은 새 등록 화면에서 편집해주세요" 안내.
   - **상품 목록 정렬**: 같은 product_group_id row 들이 옵션 순서대로 묶여 보이도록 `order by product_group_id, variation_tier_index` 적용. group_id NULL row 는 product_name 알파벳 순.
7. **register_cbsc 의 region 별 image_id_list**: bridge 가 region 별 image upload 처리 ([[project_sd_shopee_publish_root_causes]] #2). 옵션별 image 가 추가되면 region 별 + 옵션별 image upload 가 곱해짐 (6 region × N 옵션). image upload throttle 검토.
8. **6 region publish 시간**: register_cbsc 가 region 별 직렬 + polling 30회×2초 = 최대 60s × 6 region = 6분 가능. UI 가 long-poll 대응 (progress bar + cancel).
9. **batch 등록 (여러 카드 동시)**: 운영자가 카드 여러 개를 한 번에 "전체 등록" 클릭하면 카드 순차 처리 (1 카드 1 transaction + 1 register_cbsc 호출). 시간이 매우 오래 걸릴 수 있음 — UI 가 카드 단위 진행 표시.
10. **products.product_group_id self-reference**: 첫 row INSERT → id 캡처 → UPDATE 로 자기 자신 id set. 트랜잭션 안에서 모두 처리하면 외부에서 group_id null 인 row 보일 일 없음.
11. **50 조합 초과 = listing split 강제** (Codex docs review #19): docs 가 명시한 안전 boundary 는 2축 조합 ≤ 50. 50 초과는 단일 listing 으로 처리할 docs 근거 없음 → **운영자가 60 멤버 같은 케이스 입력 시 카드 분할 (예: 1-50 / 51-60 두 카드)**. UI 가 51번째 옵션 행 추가 시 사전 차단 + "두 번째 카드로 나누세요" 안내.
12. **post-publish 옵션 구조 변경 비지원** (Codex #13 + §2-4 #9, #16): update_tier_variation 2025-09-12 deprecated + KRSC shop-level 차단 가능 + update_global_model 에 image 필드 부재. 결론: **발행 후 옵션 추가 / 옵션명 변경 / 옵션별 이미지 변경 = docs 상 정식 경로 없음**. **운영자 결정 (텔레그램 #783 첫째 항목): immutable 채택 — 발행 후 옵션 수정은 Shopee KRSC 셀러센터에서 운영자가 직접 처리.** 코드 측 fallback 호출 흐름 미구현. plan §5 의 미리보기 모달은 일반 검증 수준 유지 (운영자가 직접 셀러센터 정리 가능하므로 추가 강화 X).
13. **add_global_item body 에 tier_variation 부재 + 관련 에러 존재** (Codex #10): add_global_item docs body_params 에 tier_variation 필드 없음. 그러나 `error_busi_global_tier_variation_over_limit` 같은 관련 에러는 존재 → "item 생성 → init_tier_variation → add_global_model" 단계 분리가 강제. bridge 가 이미 이 패턴 ([[project_sd_shopee_publish_root_causes]] 검증 완료).
14. **parent SKU vs option SKU 의미 명시** (Codex #15): `global_item_sku` = parent SKU (item-level 식별자, ERP 추적용). `global_model_sku` = 실제 판매 단위 SKU (옵션별). 운영자 결정 #9 의 "수동 SKU 입력" 은 옵션별 = global_model_sku. global_item_sku 는 카드 단위 자동 생성 (예: 첫 옵션 SKU 의 공통 prefix 또는 카드 식별자).
15. **attribute_list + tier_variation 동시 사용 허용** (Codex #18): 같은 global_item 에 카테고리 attribute (앨범 발매일, 아티스트 등) + tier_variation (멤버/버전) 동시 적용 가능. 우리 plan 의 데이터 모델과 일치.
16. **delete_global_model race risk** (Codex #9): 단건 삭제 가능 (global_item_id + global_model_id). default model 보호 + 삭제 전후 `get_global_model_list` 재조회 필요. stale id 사용 시점 docs 미명시 → 운영 절차로 보완 (P1).

---

## 10. 후속 작업 (본 plan 범위 밖)

- legacy view-register-legacy 의 variant 흐름과 통합 (또는 deprecation).
- 옵션별 image 의 별도 업로드 흐름 (Cloudinary → Shopee media_space.upload_image 자동화).
- product_groups 정규화 테이블 (group 단위 메타 + 발행 상태).
- standardise_tier_variation 매핑 (카테고리별 standard variation 사전 확보).
- 1축 → 2축 사후 전환 (저장 후 옵션 축 추가).

---

## 11. Revision (Codex)

2026-05-22 `/codex:rescue` 적대적 리뷰 결과. 판정: **REVISE**.

방향 자체는 맞지만 현재 순서와 failure boundary 가 공격에 약하다. 특히 §2-4 unverified API behavior 를 안은 채 §7 step 5-6 에서 바로 register_cbsc 발행으로 들어가고, §6-1 partial failure 정리와 §6-2 idempotency 가 source-level guard 중심으로만 적혀 있어 DB state 와 Shopee state divergence 가능성이 남음. merge 전 probe sequencing, idempotency key, failure reconciliation, legacy read-path 명시 필수.

### [P0] 머지 전 반드시 해결 — 본문에 반영 완료 (이 v3)

1. **§7 순서 수정**: Live probe 를 step 5-6 뒤가 아니라 그 앞 gate 로. unverified `model[].weight` / `option_list[].image` 를 안고 phase 1 publish 여는 것은 위험. → §7 step 5.5 (Live Probe Gate) 신설, step 8 (구 probe) 흡수.
2. **register_cbsc failure contract 명문화**: `add_global_item OK / init_tier_variation OK / add_global_model partial fail` 시 DB row 상태, retry 조건, orphan cleanup 책임 주체 명확화. → §6-1 (failure state machine + cleanup ownership) 보강.
3. **Register All idempotency 강화**: source_record.status 만으로는 double-click, tab duplication, slow network retry 부족. → §6-2 card-level idempotency_token (UUID) 신설, RPC + publish call 양쪽 전달 + in-flight lock.
4. **legacy compatibility read-path**: view-register-legacy 가 new rows (product_group_id, variation_*) 를 읽을 때 표시 방법 plan 에 추가. → §9-6 보강.

### [P1] 첫 commit 직후 — 별도 task 로 추적

5. **SKU helper 강화**: 운영자 수동 SKU 유지하되 20+ member 카드에서 prefix/suffix prefill + duplicate/format validation + bulk edit prefix 를 mandatory helper 로. → §10 후속 작업의 SKU helper 우선순위 상향.
6. **collision tracking 보강**: 기존 SKU 가 다른 product_group_id 에 속한 경우 same-group / cross-group conflict 분리 기록. overwrite 도 분기 처리.
7. **batch UX 보강**: 6분/card + multi-card long run 인정. queue UI + 예상 소요시간 copy + safe background processing 명시.

### [P2] 후속

8. option image upload fan-out 모니터링 — 6 region × N options 실제 throttle 영향 계측.
9. product_groups 정규화 테이블 도입 — self-referencing product_group_id 는 최소 변경엔 좋지만 group entity 가 audit/retry 모델에 더 적합.
10. separate modal 대안 spike — current card flow 유지하되 옵션 행 편집만 drawer 로 분리하는 light spike.

### Codex point-by-point (요약)

| # | 항목 | Risk | 본 plan 반영 위치 |
|---|------|------|-------------------|
| 1 | per-model weight / per-option image unverified | HIGH | §7 step 5.5 probe gate |
| 2 | SKU 수동 입력 UX (20+ member) | HIGH | §10 P1 우선순위 상향 |
| 3 | promote RPC self-reference 트랜잭션 | MEDIUM | §4-3 returned group_id authoritative 명시 |
| 4 | register_cbsc partial failure | HIGH | §6-1 state machine 보강 |
| 5 | Register All 멱등성 | HIGH | §6-2 card-level idempotency_token |
| 6 | collision_mode cross-group | MEDIUM | §10 P1 |
| 7 | 6-region publish 시간 + 배치 UX | MEDIUM | §10 P1 |
| 8 | legacy 호환성 read-path | MEDIUM | §9-6 보강 |
| 9 | region × option image fan-out | MEDIUM | §10 P2 |
| 10 | separate modal 대안 | LOW | §10 P2 |

---

## 12. 변경 이력

- 2026-05-22 v1: 초안. 잠정 가정 (1단계만, 옵션별 가격/무게/이미지 공통).
- 2026-05-22 v2: 운영자 msg #770 답변 반영. 옵션별 가격/무게/이미지 옵션 행 단위, SKU 수동, 마스터 저장 + Shopee 발행 한 사이클.
- 2026-05-22 v3: Codex 적대적 리뷰 (§11) 반영. P0 4건 본문 흡수 — §7 Live Probe Gate (step 5.5) / §6-1 failure state machine + cleanup ownership / §6-2 card-level idempotency_token / §9-6 legacy read-path contract.
- 2026-05-22 v4: Explore agent docs 광범위 grep 결과 통합 — §2-4 unverified 항목을 3개 → 13개로 확장. 신규 핵심 항목: update_tier_variation 2025-09-12 deprecated (발행 후 옵션 수정 경로 차단 가능), weight/dimension/DTS 가 top-level body 위치 (per-model 모호), normal_stock sunset 잔존, KRSC 옵션 endpoint 차단 여부 미명시, tier_variation tier/option 수 한계 docs 부족, add_global_model 의 model_list vs global_model body 키 불일치, model[].original_price cross-field validation, tier_index 배열 의미 정확성. 이 모두 live probe gate (§7 step 5.5) 의 검증 항목으로 확장.
- 2026-05-22 v5: Codex 적대적 docs 분석 (19 항목, P0 7건) 통합. §2-4 에 추가 3개 (KRSC variation 초기화 경로 docs 닫혀 있지 않음, update_global_model required_params 불일치, update_global_model 에 image 필드 부재). §9 에 신규 6개 (50 조합 초과 listing split 강제, post-publish 옵션 구조 변경 비지원, add_global_item body 의 tier_variation 부재 + 단계 분리 강제, parent SKU vs option SKU 의미 명시, attribute_list + tier_variation 동시 허용, delete_global_model race).
- 2026-05-22 v6: 운영자 결정 (텔레그램 #783) immutable 채택 — 발행 후 옵션 수정은 셀러센터 직접. §9-12 갱신. Codex 코드 리뷰 1회차 REVISE (P0 2 / P1 3 / P2 1) 패치 Sonnet 위임 완료 → 마이그레이션 202605220002 (atomic claim) + 202605220003 (FK) 적용. Codex 재리뷰 2회차 REVISE (CRITICAL 3): cross-card SKU in-flight 누락 / failed_models 분기 도달 불가 / category_id + DTS 검증 부재 + parent SKU 혼용. 추가 패치 Sonnet 위임 중. 운영자 추가 결정 (텔레그램 #788): staronemall 이미지 URL 그대로 사용 (별도 upload 단계 X) + 옵션 행 region 별 ✓/❌ 격자 표시 불필요 (카드 단위 결과 + 실패 옵션 식별자만).
- 2026-05-22 v7: CRITICAL 3 패치 완료. CROSS_SKU_INACTIVE Set 도입 (cross-card SKU 검증 활성 카드 모두 cover) + 응답 분기 5개 재구성 (정상 / partial_published / cleanup_done / cleanup_required / publish_failed) + category_id select 드롭다운 (100740/101390) + DTS 1-150 정수 검증 + parent SKU 자동 생성 (_commonPrefix 함수, fallback `-P` suffix, 카드 헤더 read-only 표시). Codex 3회차 재리뷰 진행 중.
- 2026-05-22 v8: Codex 4회차 REVISE (HIGH 2 + MEDIUM 1 + LOW 2) 패치 — renderOptionRow badge 추가, parent SKU 충돌 가드 + `-P50` 자동 suffix + group._cachedParentSku 캐싱, DTS invalid state 빨강 border + null state, cleanup_required 분기 narrow (init_tier_variation 만), 카드 단위 실패 stamp 중복 제거 (`_cardError` 마킹).
- 2026-05-22 v9: Codex 5회차 **WATCH** — P0/P1 blocker 없음. 12 항목 중 6 PASS + 6 P2 PARTIAL (UX/follow-up). 다음 단계 진행 (edge function 배포 + Vercel 배포 + 운영자 burnable probe). WATCH 항목은 후속 task 로 추적 — (P2-i) `-P50` exhaustion 카드-단위 banner 추가, (P2-ii) parent SKU suffix 순서 dependency 문서화, (P2-iii) DTS 입력 inline helper 텍스트, (P2-iv) plan §2-4 / §9 잔여 OPEN 항목 deferred 처리, (P2-v) per-region image 사전 count gate, (P2-vi) `failed_models.error` 본문 운영자 UI 노출.
