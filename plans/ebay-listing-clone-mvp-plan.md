# eBay Listing Clone MVP — Plan

- 작성자: Claude Opus 4.7
- 작성일: 2026-05-24
- 대상 작업: shopee-dashboard v2 에서 staronemall 소싱 URL 을 입력받아 운영자분의 기존 eBay 등록 패턴 (286513755306) 과 동일한 모양으로 단일 SKU 상품을 자동 발행하는 MVP.
- 정본 참고:
  - 운영자 등록 모델: <https://www.ebay.com/itm/286513755306> (TXT BEOMGYU PANIC, $32.99, single SKU, K-Pop Album Music CDs)
  - 소싱 페이지: staronemall BEOMGYU's Mixtape Panic (Members Only Price, 단일 옵션, 이미지 2장)
  - eBay API 정본: `C:\dev\api-refs\marketplaces\ebay\` (Sell + Commerce + Developer family OpenAPI 3 specs, 2026-05-16 snapshot)
  - V2 기존 발행 패턴: Joom (`mrPromoteJoom` @ `v2/index.html` L11864~)

---

## 1. 목표와 성공 기준

### 1.1 목표
- staronemall 상품 페이지 URL 한 줄 입력으로 master data 생성 → eBay 단일 SKU listing 발행까지 한 번에.
- 발행 결과를 운영자분 기존 286513755306 과 1대1 비교했을 때 다음 7개 영역이 모두 동등해야 함:
  1. 제목 (포맷 + 키워드 구성)
  2. Leaf 카테고리 (K-Pop Album Music CDs)
  3. 필수 Item Specifics 8개 (Artist, Type, Format, Record Label, Release Year, Release Title, Genre, Country of Origin)
  4. 이미지 (starphotocard 1000×1000 레이어 합성된 2장 이상)
  5. 가격 (사전 정의된 마진 공식 기반 USD, 단일 통화)
  6. 상태 (Brand New) + Brand New condition descriptor
  7. 배송·반품·결제 정책 (무료 Standard International Shipping / 30일 buyer-paid / Managed Payments)

### 1.2 비-목표 (MVP 범위 외)
- variant (멤버별 포카 등) listing — 286513755306 자체가 single 이라 후속 단계.
- 가격 sync / 재고 sync / 주문 가져오기 — 별도 phase.
- 다중 marketplace (`EBAY_GB`, `EBAY_DE` 등) — MVP 는 `EBAY_US` 만.
- 대량 발행 / bulk migration — 한 상품씩 발행.

---

## 2. 운영자 결정 필요 항목 (기본값 + 확인 요청)

| 항목 | 기본값 (응답 없을 때 진행) | 운영자 확정 시 변경 가능 |
|---|---|---|
| eBay developer 앱 + production refresh token 보유 여부 | "이미 셀러센터에서 286513755306 을 등록하셨으므로 developer 가입은 안 되어 있을 가능성 큼 → MVP 1단계는 sandbox + production OAuth 동의 흐름 함께 구축" | "이미 있다" 시 production 직행 |
| Target marketplace | `EBAY_US` | `EBAY_GB`/`EBAY_DE` 추가 가능 |
| 가격 공식 | Joom V1 SG 공식 (`_v2JoomCalcSgListing`) 임시 재사용 + eBay 13% 판매 수수료 보정용 보조 상수 1개 추가 | eBay 전용 공식 별도 작성 |
| Leaf 카테고리 ID | Taxonomy API `get_category_suggestions(q="K-Pop CD")` 결과의 최상위 (수동 검증 후 fallback 상수 박음) | 운영자 지정 ID 우선 |
| Fulfillment / Return / Payment policy | 셀러센터에 등록된 기존 policy 를 `getFulfillmentPolicy / getReturnPolicy / getPaymentPolicy` 로 조회해서 그 ID 재사용. 없으면 무료 Standard International Shipping + 30일 buyer-paid 반품으로 자동 생성 | 운영자 지정 policy 이름 |
| 매입가 (cost_krw) 입력 흐름 | v2 master data row 의 cost_krw 칼럼 그대로 사용 (운영자분이 별도로 입력) | 자동 추출 불가능 — staronemall Members Only |
| 제목 패턴 | 286513755306 의 짧고 키워드 위주 패턴 그대로 ("ARTIST MEMBER ALBUM TITLE + 구성품 + Official KPOP") | 다른 셀러 처럼 구성품 상세 나열 |
| 이미지 합성 | `[[project_starphotocard_layer_overlay_rule]]` 메모리에 따라 1000×1000 레이어 합성 ON | OFF 가능 |

---

## 3. 영향 파일

| 경로 | 변경 | 비고 |
|---|---|---|
| `edge-functions/ebay-bridge/index.ts` | **신규** | shopee-bridge / joom-bridge 와 동일 구조. OAuth refresh, Inventory + Offer + Account + Taxonomy orchestration. |
| `supabase/migrations/202605240001_sd_ebay_columns.sql` | **신규** | `products` 테이블에 `ebay_item_id`, `ebay_sku`, `ebay_offer_id`, `ebay_marketplace_id`, `ebay_status`, `ebay_published_at`, `ebay_last_synced_price` 등 컬럼 추가. `ebay_tokens` 테이블 신설 (joom_tokens 패턴 동일). |
| `v2/index.html` | **수정** | (a) `mrPromoteEbay(group)` 함수 추가 — `mrPromoteJoom` 패턴 복제. (b) 발행 카드 UI 에 eBay 버튼/상태 추가. (c) `ebay-bridge` 호출 helper. |
| `scripts/setup-ebay-oauth.mjs` | **신규** | OAuth authorization code grant flow 부트스트랩 스크립트 (로컬에서 1회 실행, refresh token 을 `ebay_tokens` 에 insert). |
| `plans/ebay-listing-clone-mvp-plan.md` | **이 파일** | 정본 plan. |

---

## 4. 데이터 흐름

```
[운영자] staronemall URL 입력 + 매입가 cost_krw 직접 입력
   ↓
[v2 UI] master row 생성 (artist, album, weight, images[], cost_krw)
   ↓ "eBay 발행" 클릭
[v2 mrPromoteEbay] master row → payload 변환
   ├─ 제목: 286513755306 패턴으로 영문 변환 (artist + member + title + 구성품 + Official KPOP)
   ├─ 이미지: starphotocard 레이어 합성 (1000×1000) → shopee-bridge proxy_image 로 검증
   ├─ 가격: _v2EbayCalcUsdListing(cost_krw, weight_g) 호출
   └─ 카테고리: master row 의 _ebayCategory (default = "music_kpop_cd")
   ↓
[ebay-bridge edge function /publish] 다단계 orchestration
   ├─ 1. OAuth refresh token → access_token (ebay_tokens row)
   ├─ 2. (1회만) merchantLocationKey 보장 — Account /location/{key} PUT
   ├─ 3. (1회만) fulfillment/return/payment policy 확보 — Account 조회 또는 생성
   ├─ 4. Taxonomy API → category_tree_id 캐싱 + leaf categoryId 검증
   ├─ 5. Inventory API PUT /inventory_item/{sku} — 제목, 설명, 이미지, condition=NEW, aspects 등록
   ├─ 6. Inventory API POST /offer — 가격, listingPolicies, categoryId, merchantLocationKey
   └─ 7. Inventory API POST /offer/{offerId}/publish → listingId 반환
   ↓
[v2 UI] DB update — ebay_item_id, ebay_offer_id, ebay_status='active', ebay_last_synced_price
   ↓
[검증] lookup: GET /inventory_item/{sku} + GET /offer/{offerId} → 모든 필드가 master 와 일치하는지 확인
   ↓ 불일치 시 토스트 + 운영자 알림
[성공] 발행 페이지 URL 표시 + 286513755306 1대1 비교 보고
```

---

## 5. eBay API 활용 매핑 (공식 spec 기준)

### 5.1 OAuth (참조: `_guides/authorization-guide.txt`)
- Flow: **Authorization Code Grant** (user token, 18개월 refresh token + 2시간 access token).
- Required scopes for MVP:
  - `https://api.ebay.com/oauth/api_scope/sell.inventory`
  - `https://api.ebay.com/oauth/api_scope/sell.account`
- 1회 부트스트랩: `scripts/setup-ebay-oauth.mjs` 가 redirect_uri 로 받은 code 를 token endpoint 와 교환해서 `ebay_tokens` 에 refresh_token 저장.
- 이후 edge function 은 refresh token → access token swap (Joom 패턴 동일).

### 5.2 Inventory API (참조: `sell/inventory.yaml`)
- 핵심 endpoint:
  - `PUT /inventory_item/{sku}` — SKU 단위 인벤토리. 제목, 설명, 이미지 URL, condition, aspects (artist/type/format/etc.), package weight/dimensions.
  - `POST /offer` — 가격, marketplaceId, categoryId, listingPolicies (fulfillment/payment/return ID), merchantLocationKey.
  - `POST /offer/{offerId}/publish` — listing 활성화. 응답 `listingId` 가 eBay item id.
  - `GET /inventory_item/{sku}` + `GET /offer/{offerId}` — 발행 후 검증.
- 단일 SKU 만 다루므로 `inventory_item_group` 은 사용 안 함 (variant 단계에서 도입).

### 5.3 Account API (참조: `sell/account.yaml`)
- `GET /fulfillment_policy?marketplace_id=EBAY_US` — 기존 정책 조회.
- `POST /fulfillment_policy` — 없을 때 새로 생성 (무료 Standard International Shipping, ship-from=KR).
- 동일 패턴으로 `return_policy`, `payment_policy`.
- `merchantLocationKey` — `PUT /location/{key}` 로 Suwon, KR 한 번 등록.

### 5.4 Commerce/Taxonomy (참조: `commerce/taxonomy.yaml`)
- `GET /get_default_category_tree_id?marketplace_id=EBAY_US` → tree id (US 는 0).
- `GET /category_tree/{id}/get_category_suggestions?q=K-Pop+album+CD` → 상위 추천에서 K-Pop Album Music CDs leaf 선택. 결과를 코드에 fallback 상수로 박고, edge function 에서 첫 실행 시 한 번 검증.
- `GET /category_tree/{id}/get_item_aspects_for_category?category_id={leaf}` → 필수/권장 aspect 목록. 286513755306 의 8개 (Artist, Type, Format, Record Label, Release Year, Release Title, Genre, Country of Origin) 가 이 응답에 포함되는지 확인 후 master → aspect 매핑 테이블 고정.

---

## 6. 가격 공식

MVP 1단계: Joom 의 V1 SG 마진 공식 (`_v2JoomCalcSgListing`) 을 그대로 재사용하되 eBay 의 13% 판매 수수료를 반영하도록 `country_settings` 에 eBay 행 (EX 같은 country_code) 을 신규 추가:
- `exchange_rate`: 1380 (KRW→USD 기준)
- `sales_fee`: 13 (eBay 일반 카테고리 final value fee)
- `pg_fee`: 2.7 (Managed Payments)
- `gst`: 0 (US 는 sales tax 별도 처리)
- `settlement_fee`, `other_fee` 등 SG 와 동일 default

함수 시그니처: `_v2EbayCalcUsdListing(costKrw, weightG, ebayCountry)` — `_v2JoomCalcSgListing` 와 동일 본문, ship fee table 만 eBay International Standard 기준 (또는 단순 KRW→USD 환산 + 고정 배송비) 으로 교체.

운영자 확인 사항: 286513755306 가 $32.99 인데 cost_krw 가 얼마였는지 알면 공식 검증 가능. (Members Only 가격이라 자동 추출 불가)

---

## 7. 이미지 합성

- `[[project_starphotocard_layer_overlay_rule]]` 메모리 기준: 850×850 inner 메인 이미지를 1000×1000 starphotocard 레이어 중앙에 합성. eBay 도 적용 대상.
- 합성 처리는 기존 shopee-bridge 의 image overlay endpoint (Shopee 발행 흐름에서 사용 중) 와 동일 helper 재사용.
- eBay 는 EPS (eBay Picture Services) 호스팅 또는 외부 URL 둘 다 허용. MVP 는 외부 URL (Cloudinary 또는 Supabase storage) 로 시작.
- 메인 이미지는 정사각형 강제 (`mrPromoteJoom` 의 검증 패턴 그대로 복제).

---

## 8. 검증 기준 (Phase 단위)

### Phase 0: API 문서 검증 (오프라인)
- `C:\dev\api-refs\marketplaces\ebay\` yaml 에서 위 5장 endpoint 모두 실재 확인.
- `get_item_aspects_for_category` 응답 스키마가 8개 aspect 매핑을 모두 지원하는지 확인.

### Phase 1: OAuth 부트스트랩
- `setup-ebay-oauth.mjs` 1회 실행 → `ebay_tokens` 에 refresh token row 1건 insert.
- edge function `/healthz` 가 access token swap 성공 응답.

### Phase 2: 정책 + 위치 1회 셋업
- merchantLocationKey "STARONE-SUWON" 등록.
- fulfillment/return/payment policy 각 1건 확보 (조회 후 없으면 생성).

### Phase 3: burnable 단일 발행
- staronemall 범규 URL → master row → publish → listingId 회수.
- 286513755306 과 비교: 제목 단어 8개 이상 일치, 카테고리 ID 동일, aspect 8개 일치, 이미지 ≥2, 가격 ±5% 이내, condition NEW, 정책 3종 일치.

### Phase 4 (운영자 검증)
- 운영자가 셀러센터에서 발행된 listing 을 실제로 확인.
- 이상 없으면 burnable listing 종료 + 다음 phase (variant, 가격 sync 등) 로 이행.

---

## 9. 막힘 처리

운영자 msg #905 가이드라인 반영:
- 코드 오류는 Codex (`/codex:rescue`) 와 Sonnet 서브에이전트를 번갈아 호출해 286513755306 패턴과 동등해질 때까지 반복.
- 추론이 아니라 공식 문서 (`C:\dev\api-refs\marketplaces\ebay\` yaml) 인용 의무.
- 검색 결과에서 더 좋은 제안 발견 시 별도 보고. (제목 패턴 검토는 Section 10 참조.)

---

## 10. 시장 비교 (참고)

같은 검색 결과 (TXT BEOMGYU MIXTAPE PANIC, CD 카테고리, 한국 발송) 에서 운영자분 32.99 USD = KRW 약 45,000원이 가장 저렴. 다음 한국 셀러는 53,112원. 영국·미국 import 셀러는 76,099 ~ 89,667원. 가격 경쟁력은 MVP 단계에서 손댈 필요 없음.

제목 패턴 측면에서 한 셀러 (KRW 72,084) 가 "Album/CD+View Master+2Disc+11 Karte+Sticker+etc+GIFT" 처럼 staronemall 구성품을 훨씬 더 상세히 나열하고 있어 키워드 노출 확장 가능. 단 MVP 는 286513755306 패턴 카피가 우선이고, 풍부한 제목 패턴은 다음 phase 의 옵션으로 보류.

---

## 11. 단계별 작업 순서

1. **이 파일 작성** (지금)
2. **Codex 적대적 검증** — `/codex:rescue` 또는 codex CLI 로 이 plan 검토, "Revision (Codex)" 섹션 추가.
3. **Sonnet 서브에이전트 구현** — `ebay-bridge` edge function + migration + `mrPromoteEbay` v2 UI 추가.
4. **Codex 코드 리뷰**.
5. **Phase 0/1/2 검증** (오프라인 + OAuth + 정책 셋업).
6. **Phase 3 burnable 발행 + 286513755306 비교**.
7. **Phase 4 운영자 검증**.

---

## Revision (grill-with-docs, 2026-05-24)

Plan 의 추론 부분을 `C:\dev\api-refs\marketplaces\ebay\` 정본 spec 으로 검증한 결과 다음 10개 사실을 인용으로 교체/추가했습니다.

1. **`PUT /inventory_item/{sku}` headers 보완** — `Content-Language: en-US` 가 path param 외에 **required header** 임 (`sell/inventory.yaml` L733~743). plan 의 Section 5.2 에 헤더 명시 누락. → ebay-bridge edge function 에서 모든 inventory PUT 호출에 `Content-Language: en-US` 추가 의무.

2. **SKU max length 50** (`sell/inventory.yaml` L748). master row 의 `_sku` 가 50 자 초과하면 발행 차단 가드 필요.

3. **createOrReplaceInventoryItem 은 complete replacement** (L693~698). 부분 업데이트 불가 — 매번 GET 으로 현재 상태 가져온 뒤 모든 필드 다시 전송해야 함. ebay-bridge 의 update 흐름은 read-modify-write 패턴 필수.

4. **같은 SKU 의 multi-marketplace 동시 발행 불가** (`sell/inventory.yaml` L3791): _"At this time, the same SKU value can not be offered across multiple eBay marketplaces"_. → MVP 는 EBAY_US 단독이라 OK 지만, EBAY_GB / EBAY_DE 확장 시 marketplace 별 SKU suffix (`-US`, `-GB`) 가 필수. Section 2 의 marketplace 확장 가지에 이 제약 명시.

5. **Product.aspects name/value max** (`sell/inventory.yaml` L10791): aspect name 40 자 / aspect value 50 자. 286513755306 의 "Tomorrow X Together, TXT, BEOMGYU" (33 자) 는 통과. master → aspects 매핑 시 양쪽 길이 가드.

6. **Product.description max 4000 + HTML 한정** (L10843): 기본 HTML 태그 (b, strong, br, ol, ul, li, table 계열) 만 허용, JS/Flash/form 활성 콘텐츠 금지. staronemall 의 한국어 본문은 영문 번역 후 4000 자 컷.

7. **EAN/UPC/ISBN 으로 eBay Catalog 자동 매칭** (L10848): GTIN 으로 catalog product match 가 잡히면 title/description/aspects/이미지가 **자동으로** 카탈로그 데이터로 덮어써짐. staronemall 의 barcode `8800303086174` 를 `product.ean` 으로 넘기면 우리 master data 보다 카탈로그가 우선될 위험. 286513755306 과 동일한 패턴 (셀러분 직접 작성한 영문 제목 + 패턴) 을 유지하려면 **EAN 전송을 끄거나** 카탈로그 매칭 결과를 사후에 덮어쓰는 추가 호출이 필요. ← 운영자 결정 필요.

8. **Condition enum 매핑** (`sell/inventory.yaml` L8527): `NEW`, `LIKE_NEW`, `NEW_OTHER`, `NEW_WITH_DEFECTS` 가 신상품 계열. 286513755306 의 "Brand New" UI 라벨은 enum 값 `NEW` 에 매핑 (eBay 표준 새 상품 라벨). conditionDescription 은 사용 안 함 (NEW 계열에선 무시되고 warning 만 뜸).

9. **Fulfillment policy 의 globalShipping 은 EBAY_GB 전용** (`sell/account.yaml` L3033~3055): EBAY_US 는 "eBay International Shipping" 이 **account-level setting** 이라 fulfillment policy 에 별도 필드 명시 불필요. policy 안에는 individual international shipping option (예: Standard International Shipping flat-rate) 하나만 등록하면 됨. 286513755306 의 "무료 Standard International Shipping" 와 정확히 일치.

10. **Ship-from 위치는 fulfillment policy 가 아닌 merchantLocationKey** (`sell/inventory.yaml` L6791, L7694): 한국 수원 발송 정보는 `PUT /location/{key}` 로 한 번 등록한 위치 키가 offer 의 `merchantLocationKey` 에 들어감. fulfillment policy 에는 ship-from 필드 없음. → Section 5.3 의 location 셋업이 Section 5.2 의 offer create 보다 먼저 1회 실행되어야 한다는 dependency 명시.

### 추가 결정 필요 항목 (운영자 묶음 질문으로 전달)

- EAN 전송 ON/OFF (위 항목 7)
- conditionDescriptors 사용 여부 (음반 카테고리 기본 enum `NEW` 로 충분한지)
- merchantLocationKey 등록용 KR Suwon 주소 (우편번호/도로명) — 셀러센터 등록 정보 그대로 가져올지, 별도 입력할지
- description 의 staronemall 한국어 본문 처리 (영문 번역 자동 / 영문 패턴 템플릿 / 운영자 직접 입력)
- 가격 공식 sales_fee=13, pg_fee=2.7 기본값 확인
- 286513755306 의 condition descriptor (현재 페이지에 노출되는 "Brand New" 외에 추가 descriptor 가 셀러센터에 등록되어 있는지)
- production refresh token 보유 여부 (msg 909 로 이미 질문 중)

## Operator Decisions (2026-05-25, Telegram msg #960)

1. **매입가 (cost_krw)**: [sd] v2 의 staronemall 크롤링 기능이 이미 가격 필드를 추출 가능. 구현 시 v2/index.html 의 기존 staronemall fetch 로직에서 가격 부분 식별해서 재사용. 마스터 데이터의 `cost_krw` 컬럼 자동 채움.
2. **eBay developer 앱**: 운영자분이 직접 production 키 (App ID/Cert ID/RuName + OAuth refresh token) 발급 예정. Sonnet 구현 단계에서는 `scripts/setup-ebay-oauth.mjs` 부트스트랩 스크립트만 미리 작성해두고, 운영자분이 키 받으시면 그 스크립트로 토큰을 `ebay_tokens` 테이블에 1회 insert.
3. **Business Policies**: 이미 셀러 계정에서 활성화됨. 24시간 lead time 없음. `getFulfillmentPolicies` / `getReturnPolicies` / `getPaymentPolicies` 로 marketplace=EBAY_US 의 기존 policy ID 를 조회해서 영속화 (`ebay_policy_ids` 테이블 또는 시드 상수).
4. **EAN 전송**: **OFF**. `Product.ean` 필드 자체를 inventory item PUT body 에서 제외해 eBay 카탈로그 자동 매칭 회피. 286513755306 의 영문 제목·이미지·aspects 가 운영자분 master data 로만 채워짐.
5. **KR 발송지 (merchantLocationKey 등록용)**:
   - `addressLine1`: 신원로 55, 지하 105호 (Shinwon-ro 55, B105)
   - `city`: Suwon
   - `stateOrProvince`: Gyeonggi-do (KR-41)
   - `country`: KR
   - `postalCode`: `16677` (운영자 확정, Telegram msg #962)
   - `merchantLocationKey`: `STARONE-SUWON-B105`
6. **상품 설명 (description)**: 운영자분이 발행마다 직접 입력. 자동 번역/템플릿 사용 안 함. v2 UI 에 description 입력 칸을 mrPromoteEbay 다이얼로그 안에 추가.

## Revision (Codex Code Review — 2026-05-25, post-Sonnet)

검증 대상: Sonnet 이 작성한 4개 파일 (`supabase/migrations/202605260001_sd_ebay_schema.sql`, `edge-functions/ebay-bridge/index.ts`, `v2/index.html` 의 `mrPromoteEbay` + `_v2EbayCalcUsdListing` + `_v2LoadEbayExCountry`, `scripts/setup-ebay-oauth.mjs`). 전체 review 는 `C:\Users\STEVE\ebay-implementation-review.md`.

### 해결된 항목 (RESOLVED)

- Condition NEW 강제 + conditionDescription/conditionDescriptors 제외 (ebay-bridge/index.ts:355-382, v2/index.html:12273)
- fulfillmentTime 제외 (ebay-bridge/index.ts:367-369)
- merchantLocationKey GET-then-PUT idempotent (ebay-bridge/index.ts:145-198)
- Marketplace-scoped policy IDs 영속화 (ebay-bridge/index.ts:213-258)
- listingDuration GTC (ebay-bridge/index.ts:41-43, 433-434)
- createOffer 중복 시 updateOffer fallback (ebay-bridge/index.ts:447-460)
- 우편번호 16677 (ebay-bridge/index.ts:147 후처리 적용)
- OAuth flow (scripts/setup-ebay-oauth.mjs: scope/response_type/redirect_uri/Basic auth 모두 spec 일치)
- Migration idempotent (모든 객체 if not exists / on conflict)

### 잔여 BLOCKER 1건

1. **가격 공식 spec 비근거**: migration 의 sales_fee=13/pg_fee=2.7 와 UI 의 `_v2EbayCalcUsdListing` (shipping=0, Joom 공식 클론) 는 실제 eBay `POST /offer/get_listing_fees` 호출 없이 추정값. (`supabase/migrations/202605260001_sd_ebay_schema.sql:69-87`, `v2/index.html:11904-11924`)

### 잔여 WARNING 6건

1. 카테고리 유효성 preflight 미사용 — `getCategoryTreeId` 캐시 정의됐으나 publish 흐름에서 안 부름. `getExpiredCategories` 와 leaf-node 검증 미통합. (`ebay-bridge/index.ts:268-290, 327-490`)
2. Metadata preflight 부재 — `getItemConditionPolicies`, `getListingTypePolicies` 호출 안 함. 에러가 publish 단계에서야 surface. (`ebay-bridge/index.ts:359-477`)
3. Post-publish 검증 약함 — `/lookup-item` 은 status=PUBLISHED + listing.listingId 만 확인. 이미지 순서/카운트, aspect, leaf 유효성, scheduled-start 검증 없음. (`v2/index.html:12287-12291`, `ebay-bridge/index.ts:509-522`)
4. Item specifics 이름 drift — plan 은 "Country of Origin" 인데 UI 는 "Country of Manufacture" 전송. 또 Record Label 을 artist 필드에서 채움. (`v2/index.html:12222, 12227`)
5. 운영자 결정 #1 (cost crawl 재사용) 미구현 — `mrPromoteEbay` 는 `firstRow._cost_krw`/`cost_krw` 만 읽고 없으면 중단. eBay 측 신규 추출 로직 없음. (`v2/index.html:12176`)
6. eBay 에러 envelope 비구조적 surface — eBay 응답의 `errors[].errorId/message/longMessage` 가 `JSON.stringify(body)` 로 묶여서 throw. UI 는 `json.error || json.message` 만 읽음. (`ebay-bridge/index.ts:405-407, 466, 475-477`, `v2/index.html:12318-12319`)

### Overall Verdict

운영자 결정 6가지 중 5건 OK, 1건 (cost crawl 재사용) 미구현. Codex 적대적 라운드의 6 BLOCKER 중 5건 해결, 1건 (가격 공식) 잔존. WARNING 7건 중 6건 잔존.

## Revision (Codex — Adversarial Round 2)

### (a) Spec Conflicts

- [BLOCKER] The plan still treats "Brand New condition descriptor" as a normal clone target, but the local Inventory spec says new-condition items should use `condition=NEW`; `conditionDescription` is ignored for new-condition items, and `conditionDescriptors` are category-specific metadata rather than a generic "Brand New" flag. Citation: `sell/inventory.yaml` section `conditionDescription` / `conditionDescriptors`; `sell/metadata.yaml` section `getItemConditionPolicies`.
- [BLOCKER] `fulfillmentTime` is the wrong field for standard shipped listings; shipping handling belongs in Account fulfillment policy `handlingTime`, while Inventory `fulfillmentTime` is for `PickupAtLocationAvailability` (in-store pickup only). Citation: `sell/account.yaml` section `FulfillmentPolicy.shippingOptions.handlingTime`; `sell/inventory.yaml` section `PickupAtLocationAvailability.fulfillmentTime`.
- [WARNING] The plan collapses locale, marketplace, and currency into one "US/USD" assumption, but the specs model them separately: Inventory write calls require `Content-Language`, Account/Taxonomy lookups are keyed by `marketplace_id`/`marketplaceId`, and the offer price carries its own `Amount.currency`. None is derived from another in the local corpus. Citation: `sell/inventory.yaml #/paths/~1offer/post`; `sell/inventory.yaml` section `Amount`; `commerce/taxonomy.yaml #/paths/~1get_default_category_tree_id/get`.
- [WARNING] Offer lifecycle is underspecified: Inventory offer `status` is only `PUBLISHED` or `UNPUBLISHED`; scheduled activation is modeled through `listingStartDate`, not a third offer state. A future-dated clone can still be `PUBLISHED` while not yet live. Citation: `sell/inventory.yaml` section `status`; `sell/inventory.yaml` section `listingStartDate`; `sell/inventory.yaml #/paths/~1offer~1{offerId}~1publish/post`.
- [WARNING] Retry semantics are missing: `createOffer` stages the offer once, and the `sku + marketplaceId + format` combination must be unique; subsequent completion should use `updateOffer`, not repeated `createOffer` for the same tuple. Citation: `sell/inventory.yaml #/paths/~1offer/post`; `sell/inventory.yaml` error text `"The combination of SKU, marketplaceId and format should be unique."`

### (b) Missing Endpoint Dependencies

- [BLOCKER] The plan omits Business Policies opt-in. The Inventory spec says live Inventory listings require Business Policies, and the Account spec says `optInToProgram` can take up to 24 hours to process, so this must be front-loaded before burnable publish. Citation: `sell/inventory.yaml` section `listingPolicies`; `sell/account.yaml #/paths/~1program~1opt_in/post`.
- [BLOCKER] The plan assumes `merchantLocationKey` can just be "ensured", but the key only exists after `createInventoryLocation`, and the safe idempotent preflight is `getInventoryLocation` -> create if missing -> verify enabled status. Citation: `sell/inventory.yaml #/paths/~1location~1{merchantLocationKey}/put`; `sell/inventory.yaml #/paths/~1location~1{merchantLocationKey}/get`; `sell/inventory.yaml` section `merchantLocationKey`.
- [BLOCKER] Policy bootstrap is still incomplete unless IDs are resolved per marketplace. `getFulfillmentPolicies`, `getPaymentPolicies`, and `getReturnPolicies` are all marketplace-scoped; the plan should persist the selected US policy IDs and not rely on generic "existing policy" assumptions. Citation: `sell/account.yaml #/paths/~1fulfillment_policy/get`; `sell/account.yaml #/paths/~1payment_policy/get`; `sell/account.yaml #/paths/~1return_policy/get`.
- [WARNING] Category tree caching is underspecified. `getDefaultCategoryTreeId` returns both `categoryTreeId` and `categoryTreeVersion`, and the spec explicitly recommends caching the version for drift detection; when drift occurs, `getExpiredCategories` is the only local-spec remap surface for stale leaf IDs. Citation: `commerce/taxonomy.yaml #/paths/~1get_default_category_tree_id/get`; `commerce/taxonomy.yaml` section `BaseCategoryTree.categoryTreeVersion`; `commerce/taxonomy.yaml #/paths/~1category_tree~1{category_tree_id}~1get_expired_categories/get`.
- [WARNING] Category-policy preflight is missing. The local specs expose `getItemConditionPolicies`, `getListingTypePolicies`, and Metadata `getReturnPolicies` as the category-aware validation surfaces for condition enums, fixed-price duration support, and return-policy legality; without these, errors surface late at `publishOffer`. Citation: `sell/metadata.yaml #/paths/~1marketplace~1{marketplace_id}~1get_item_condition_policies/get`; `sell/metadata.yaml #/paths/~1marketplace~1{marketplace_id}~1get_listing_type_policies/get`; `sell/metadata.yaml` section `ReturnPolicy`.

### (c) Price Formula Audit

- [BLOCKER] The hard-coded `sales_fee=13` and `pg_fee=2.7` are not backed by any local spec file. The only fee surface in the local corpus is `POST /offer/get_listing_fees`, which returns expected listing fees for unpublished offers; the fee schedule itself is otherwise not in local spec. Citation: `sell/inventory.yaml #/paths/~1offer~1get_listing_fees/post`; not in local spec: fixed percent fee table.
- [WARNING] The $32.99 target is not reproducible from the current plan inputs. With the plan's own `exchange_rate=1380`, gross USD 32.99 implies KRW 45,526.20 before any fees; if the plan's assumed 15.7% combined fee were applied mechanically, that leaves about KRW 38,379 before shipping, settlement_fee, other_fee, and margin. `cost_krw`, target margin, and shipping rule are all still missing, so the arithmetic chain cannot be audited end-to-end. Citation: plan Sections 6 / 8; `sell/inventory.yaml` section `Amount`.
- [WARNING] The rounding rule that produces exactly `32.99` is unspecified. Local Inventory price fields only define `Amount.currency` and string `Amount.value`; they do not define cent-rounding behavior, charm-pricing rules, or FX rounding sequence. Citation: `sell/inventory.yaml` section `Amount`.
- [NOTE] If you want a spec-grounded fee check before publish, the only local option is `getListingFees` on the unpublished offer, but that response is aggregated by marketplace and does not prove a single-SKU "13% fee" heuristic. Citation: `sell/inventory.yaml #/paths/~1offer~1get_listing_fees/post`; `sell/inventory.yaml` section `FeeSummary`.

### (d) Phase 3 Burnable Verification

- [BLOCKER] `image >= 2` is too weak. The spec allows up to 24 images and can auto-inject catalog stock images when GTIN/ePID matching is active, so burnable verification must compare exact image count, exact order, and whether catalog-populated images displaced seller images. Citation: `sell/inventory.yaml` sections `Product.imageUrls`, `Product.ean`, and `Product.epid`.
- [BLOCKER] "Category ID same" is insufficient unless you also prove the chosen node is a leaf and still valid in the current tree version. The taxonomy spec exposes leaf-ness and expired-category remaps explicitly. Citation: `commerce/taxonomy.yaml` section `CategoryTreeNode.leafCategoryTreeNode`; `commerce/taxonomy.yaml #/paths/~1category_tree~1{category_tree_id}~1get_expired_categories/get`.
- [WARNING] Comparing only the visible 8 item specifics is not enough. The publish contract requires `product.aspects`, and the authoritative required/recommended set comes from `getItemAspectsForCategory`; the reference listing may be under-specified relative to current category requirements. Citation: `sell/inventory.yaml` section `Product.aspects`; `commerce/taxonomy.yaml #/paths/~1category_tree~1{category_tree_id}~1get_item_aspects_for_category/get`.
- [WARNING] The 7 checks miss listing duration and scheduled-start drift. For fixed-price listings, `listingDuration` must be `GTC`, and a future `listingStartDate` would mean the clone is not immediately live even after publish. Citation: `sell/inventory.yaml` section `listingDuration`; `sell/inventory.yaml` section `listingStartDate`.
- [WARNING] The 7 checks miss the actual offer/listing state contract. Verification should assert `getOffer.status=PUBLISHED` and the presence of the `listing` container with a concrete `listingStatus`; "SCHEDULED" is not an offer status in the local Inventory spec. Citation: `sell/inventory.yaml` section `status`; `sell/inventory.yaml` section `ListingDetails`; `sell/inventory.yaml #/paths/~1offer~1{offerId}/get`.
- [NOTE] The 7 checks do not cover storefront category placement. Inventory offers can carry one or two `storeCategoryNames` paths, so a reference-item store filing would currently go unverified. Citation: `sell/inventory.yaml` section `storeCategoryNames`.
- [NOTE] The 7 checks do not explicitly rule out Motors-only policy paths. The local Metadata corpus has a separate `getMotorsListingPolicies` surface for `EBAY_MOTORS_US`; burnable verification should assert that this clone stays on standard `EBAY_US` listing policy surfaces, not a Motors flow. Citation: `sell/metadata.yaml #/paths/~1marketplace~1{marketplace_id}~1get_motors_listing_policies/get`.

### (e) Simpler Alternative

- [WARNING] A single Trading `AddItem` / `AddFixedPriceItem` path may be simpler in principle, but the authoritative local corpus does not include Trading API schemas; the repo README explicitly says legacy XML APIs were intentionally not collected and modern integrations should use REST. That makes Trading a docs-gap spike, not a drop-in simplification under the current source-of-truth rule. Citation: `C:\dev\api-refs\marketplaces\ebay\README.md` section `Not included`.
- [NOTE] Auth is not the blocker. The local authorization guide says Trading API requests can use OAuth user access tokens via `X-EBAY-API-IAF-TOKEN` and the authorization code grant. Citation: `_guides/authorization-guide.txt` sections `Trading API` and `Using OAuth in Trading API requests`.
- [NOTE] Trading may reduce some pre-registration overhead for returns/shipping because the Metadata corpus maps legacy `AddItem` `ReturnPolicy` and shipping exclusion fields directly, whereas the Inventory path requires Account business policy IDs plus the offer lifecycle. Citation: `sell/metadata.yaml` section `ReturnPolicyDetails` (Trading API or Sell Feed API notes); `sell/metadata.yaml` section `ShippingLocation` (`AddItem.ExcludeShipToLocation` note).
- [WARNING] The switch is not reversible per listing. Once a listing is created with the Inventory API, the local Inventory spec says it cannot be revised or relisted using Trading API calls. Mixing models later is therefore operationally expensive. Citation: `sell/inventory.yaml` note under `publishOfferByInventoryItemGroup`; `sell/inventory.yaml` notes referencing Trading incompatibility.
- [NOTE] Sandbox coverage, exact field parity, and direct `AddFixedPriceItem` request semantics are not in local spec. If you want to pursue the simpler XML path, the README's prescribed next step is to pull the specific Trading docs into `_legacy/` first and only then compare round trips honestly. Citation: `C:\dev\api-refs\marketplaces\ebay\README.md` section `Not included`.
