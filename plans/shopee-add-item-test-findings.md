# Shopee 상품 등록 자동 디버깅 결과 (2026-05-11 새벽 v2)

작성: Opus, 사용자 취침 중 자동 진행. CBSC=KRSC 확정 후 global_product 흐름으로 전환.

## TL;DR — 사용자 1분 액션

브라우저에서 열기: **https://bpdafetvjyvvwbksvowu.supabase.co/functions/v1/shopee-oauth-helper**

"Shopee로 로그인 시작" 버튼 → CBSC 메인 계정(1842717)으로 로그인 → 권한 승인. shopee_tokens 테이블의 `region='_MERCHANT'` 행에 merchant refresh_token이 자동 저장됨. 성공 화면 보이면 "머천트 OAuth 끝" 한 마디만 알려주면 나머지는 자동.

## 결정적 발견

### 1) CBSC 락
스토어가 upgraded CBSC (`is_cb: true`, `is_upgraded_cbsc: true`, merchant_id 3922769)라 shop-level `/api/v2/product/add_item` 호출 거절:
```
product.error_check_auth_fail_add_item
"The shop cannot create shop SKU without global SKU because the shop is CBSC shop"
```

→ 반드시 merchant-level `/api/v2/global_product/add_global_item` + `/create_publish_task` 흐름 사용.

### 2) 현재 refresh_token 모두 shop-scope
10개 region 모든 row의 refresh_token이 shop OAuth로 받은 것. merchant_id로 refresh 시도 시 모두 403:
```
"Your refresh token or merchant_id is wrong"
```

Shopee `/auth/access_token/get`는 principal로 `shop_id|merchant_id|supplier_id|user_id`만 허용. `main_account_id`는 거절:
```
"shop_id or merchant_id or supplier_id or user_id is required"
```

### 3) shop_token + merchant_id signing도 거절
v37에서 shop access_token에 merchant_id로 sign한 후 `/global_product/add_global_item` 호출 → `invalid_access_token` 403. CBSC global_product API는 진짜 merchant-scope token 필요.

## 진행 사항 (배포됨)

### shopee-bridge (server v52 = 코드 v37)
- v33: days_to_ship + pre_order + brand + dimension + wholesale 추가
- v36: payload 전면 재작성 — `seller_stock` 최상위, `logistic_info` (with logistic_name/is_free), `original_price` 최상위, `image.image_id_list`, `attribute_list:[]`
- v37: CBSC global_product 엔드포인트 추가 — `/add_global_item`, `/create_publish_task`, `/publish_task_result`, `/global_categories`, `/global_brands`, `/global_attributes`. 디버그 `/raw_call`, `/channels`, `/categories`, `/attributes`, `/brands`

### shopee-refresh-probe (신규 함수)
모든 refresh principal variant 시도 결과 자동 보고. SG 외 TW/TH/MY/PH/BR 모두 동일 결과 (shop_id만 작동).

### shopee-oauth-helper (신규 함수, verify_jwt=false)
- GET `/shopee-oauth-helper` → Shopee 인증 페이지로 redirect (사용자가 CBSC 메인 계정으로 로그인)
- GET `/shopee-oauth-helper?action=callback&code=X[&main_account_id=Y]` → code 교환, merchant refresh_token을 `shopee_tokens(region='_MERCHANT')`로 upsert
- 3가지 body variant 시도 (main_account_id 상수, query 파라미터, shop_id) 자동 fallback

## 검증된 SG 데이터

- 카테고리(K-pop): `101390` (모달의 300740/301390 등은 invalid)
- 브랜드: `{brand_id: 2562101, original_brand_name: "Hybe Labels"}`
- Logistics 채널 IDs: 18036, 18046, 18063, 18114
- shop_id: 1001961186, merchant_id: 3922769, main_account_id: 1842717

## OAuth 후 자동 진행 계획 (사용자가 OAuth 마치면 내가 할 것)

1. shopee-bridge 코드 수정:
   - `getValidToken` / `merchantApiCall`이 `region='_MERCHANT'` row 우선 사용
   - 만료 시 merchant_id 기반 refresh 사용
2. `/add_global_item` 단일 호출 검증 (real test product on SG)
3. `/create_publish_task` → 폴링 → SG shop_id에 publish 확인
4. 성공 시 frontend `_shopeeRegSubmit` 변경:
   - region별 publish_task 호출 대신 단일 add_global_item + 5개 region create_publish_task
   - 모달 카테고리·브랜드 select를 `/global_categories` + `/global_brands` API 결과로 채움
5. variation 포함 등록 1건 테스트

## v39 미리 준비된 변경 사항 (배포 대기)

`merchantApiCall` 수정 pseudo:
```ts
async function merchantApiCall(region, path, opts) {
  // 1. _MERCHANT row의 access_token + merchant_id로 시도
  const merch = await supabase.from('shopee_tokens').select('*').eq('region', '_MERCHANT').single();
  if (merch.data) {
    // expired면 refresh with {refresh_token, partner_id, merchant_id}
    // call with merchant_id sig
  }
  // 2. fallback: shop token + merchant_id sig (현재 동작)
}
```

## 사용한 디버그 변형 (모두 실패)

| Variant | Result |
|---------|--------|
| shop_id refresh | ✓ (shop-scope만) |
| merchant_id refresh | ✗ 403 wrong refresh_token |
| main_account_id refresh | ✗ Shopee가 인식 안 함 |
| main_account_id_as_merchant_id | ✗ 동일 |
| no_principal | ✗ principal required |
| shop_token + merchant_id sig (global API) | ✗ invalid_access_token |

## 사용자 입력 안 받고 추가 시도 가능한 옵션

- (해본 것) main_account_id, shop_id, merchant_id, supplier_id 변형
- (안 해본 것) `supplier_id` 자리에 다른 ID 넣기 — 우리 계정은 CBSC merchant이므로 supplier 개념 없음
- (안 해본 것) sandbox 환경에서 동일 흐름 테스트 — 우리는 LIVE만 사용
- (안 해본 것) Shopee partner API의 `/api/v2/public/get_shops_by_partner` 호출해서 우리 partner_id에 연결된 shops 목록 확인

이 이상은 user OAuth 재인증 없이는 진전 불가.
