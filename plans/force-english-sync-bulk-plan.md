# Plan — Force English (Global → All Shops) Bulk Sync

작성: Opus 4.7 / 2026-05-17  
대상 저장소: `C:\dev\shopee-dashboard`  
배경 메모리: [[project_shopee_krsc_facts]], [[project_shopee_krsc_stock_block]]

## User goal (literal)

> "현재 각 region 의 언어로 상품명 및 옵션명이 번역되는 특정 국가들이 있는데, 이 국가들의 상품을 Global product 기준으로 상품명 및 옵션명을 영어로 일괄로 변경할 수 있는 기능이 있을까?"

= 일부 매장의 상품명/옵션명이 현지 언어로 표시되는 상태를 → Global Product 의 영문으로 일괄 통일.

## Shopee API capability

- **유일한 공식 경로**: `POST /api/v2/global_product/set_sync_field` (merchant 서명, KRSC 차단 우회).
- Body shape:
  ```json
  {
    "shop_sync_list": [
      {
        "shop_id": <int>,
        "shop_region": "<SG|TW|TH|MY|PH|BR>",
        "name_and_description": true,
        "tier_variation_name_and_option": true,
        "media_information": <bool>,
        "price": <bool>,
        "days_to_ship": <bool>
      },
      ...
    ]
  }
  ```
- 5개 flag 모두 required. `name_and_description` + `tier_variation_name_and_option` 두 개가 사용자 목표 직접 대응.
- **`get_sync_field` 같은 read 엔드포인트가 공개 docs 에 없음** → 현재 정책 상태를 모르는 채 set 만 가능. 즉, 호출 시 5 flag 모두 명시해야 함.
- `set_sync_field` 는 **per-shop** 정책 (NOT per-item). 한 번 호출이 해당 shop 의 모든 global-published item 에 적용.
- 별도 translation API 는 Shopee 공개 endpoint 에 존재 X (buyer-facing 자동 번역은 storefront 레이어).

## LIVE probe result (2026-05-17)

- 대상: SG shop_id 1001961186, 모든 5 flag = true
- 호출: bridge action `set_dts_sync` (이미 deployed, set_sync_field wrapper)
- 결과: **HTTP 200, error="", request_id 발급** ✅
- 즉시 검증 가능한 sample 부족: starphotocard 의 5개 active shop (SG/TW/TH/MY/PH) 모두 첫 3개 item 의 name 이 이미 영문 (`[READY STOCK] ILLIT ...` 등). 즉, 현재 데이터에 localized 한 item 이 거의 없을 수도 있음.
- 따라서 즉시-효과 vs 정책-only 효과 (즉, sync_field ON 했을 때 즉시 모든 item re-sync 가 일어나는지 vs 다음 update_global_item 호출 때까지 대기인지) 는 **이 probe 하나로 결정 못함** — 후속 검증 필요.

## Design

### UX
shopee-dashboard 메인 상단 툴바에 신규 버튼:
```
🌐 매장 영문 sync (Global → 매장)
```
클릭 시 confirm modal:
- "이 작업은 활성 매장 5곳(SG/TW/TH/MY/PH)의 sync 정책을 켭니다."
- "각 매장의 상품명/옵션명은 Global Product 의 영문으로 통일됩니다."
- "(매장별 customize 한 이름이 있다면 덮어쓰임)"
- 진행 / 취소

### 처리 흐름
1. 5개 매장 hardcoded 리스트 (BR 은 banned 제외):
   ```
   SG: 1001961186, TW: 1002269092, TH: 1002269088,
   MY: 1002269081, PH: 1002269083
   ```
   (`EXPECTED_REGION_SHOP_IDS` 상수에서 가져오거나 db.from('shopee_tokens') 에서 fresh 조회)
2. 단 1번의 fetch 로 `set_dts_sync` 호출 (한 body 에 5 shop entry 다 넣음):
   ```js
   {shops: [
     {shop_id, shop_region, name_and_description: true, tier_variation_name_and_option: true,
      media_information: true, price: true, days_to_ship: true},
     ...
   ]}
   ```
   ※ 5 flag default = true 정책 (= 단순화, 모든 영역 Global 기준). 사용자가 가격/배송일 별도로 관리하고 싶다면 후속 옵션으로 분리 가능.
3. 응답 받으면 토스트로 결과 표시.

### 안전성
- 한 번 ON 하면 SG/TW/TH/MY/PH 의 향후 모든 global update 가 매장에 push 됨. 그 자체로 사용자가 원하는 동작.
- 매장별로 의도된 customize 가 있었다면 다음 sync 시 영문으로 덮어쓰임. starphotocard 현재 패턴상 매장별 customize 거의 없을 것 (5 sample 검사로 추정).
- **롤백 경로**: 같은 endpoint 에 `name_and_description: false` 로 다시 호출하면 sync OFF. 단, 이미 덮어쓴 이름은 안 돌아옴 (직접 update_global_item 또는 매장별 편집 필요).
- BR shop 은 banned 라 sync_list 에서 제외 (이미 메모리에 기록).

### Codebase 변경 범위
- `index.html` 만:
  - 신규 button 마크업 + handler 함수
  - 기존 `shopee-bridge/set_dts_sync` 액션 그대로 활용 (재용)
  - 새 Edge Function 불필요
- 신규 마이그레이션 불필요

## 검증 기준 (Codex 리뷰 통과 + 사용자 LIVE 확인 까지)

1. 코드 review (Codex):
   - shop_id 하드코딩 vs DB 조회 — 어느 쪽이 안전한가
   - 모든 flag=true 가 의도와 일치하는가, 일부 셀러는 가격/배송일 sync 끄고 싶을 수도 있어 분리해야 하는가
   - 한 매장 호출 실패 시 다른 매장으로 어떻게 진행할지 (per-shop 호출 vs 한 번에 5)
   - confirm modal copy 가 충분히 설명적인지
2. LIVE 동작:
   - 버튼 클릭 → HTTP 200 응답 → 토스트 성공 메시지
   - 1-2일 후 사용자가 매장 페이지에서 영문 name 확인 (Shopee storefront cache 갱신 주기 의존)

## 미해결 / 후속

- **즉시 vs 지연 sync**: set_sync_field ON 만으로 기존 item 이 즉시 영문으로 바뀌는지 불확실. 만약 안 바뀌면 후속 옵션 B (1600+개 item 에 update_global_item 으로 trigger) 필요. 사용자 1-2일 관찰 후 결정.
- **get_sync_field 부재**: 현재 sync 정책 상태를 알 수 없음. 향후 Shopee 가 추가하면 UI 에 현재 상태 표시 가능.
- **flag 세분화**: 일부 셀러는 가격을 region 별로 다르게 두고 싶을 수 있음. v2 에서 각 flag 를 별도 토글 추가 검토.

## 한 줄 결론

`set_sync_field` 5개 매장 per-shop 호출 + 사용자 모달로 5 flag 명시 → 영문 통일. 위험은 sync 켠 후 매장별 customize 손실인데 starphotocard 패턴에서는 거의 0. 즉시-효과 여부만 사용자 LIVE 확인 후 v2 로 확장 가능.

---

## Revision (Codex 어드버서리얼 리뷰 반영, 2026-05-17)

Codex 가 4개 critical concern + 1개 REJECT 지적. 다음과 같이 플랜 갱신:

### CHANGES vs 초안

1. **Per-shop independent calls** (was: single body with 5 shop entries)
   - 5번 분리 호출. 한 매장 실패가 다른 매장 진행을 막지 않음.
   - 각 매장별 결과(성공/실패+사유)를 표 형태로 노출. 실패만 재시도 가능.

2. **DB 에서 shop 리스트 fresh resolve** (was: hardcoded)
   - `shopee_tokens` 에서 status != 'banned' AND region IN (SG,TW,TH,MY,PH) 조회.
   - 기대 5개와 resolve 결과가 다르면 fail-fast (예: 새 매장 추가됐는데 BR 포함 등).

3. **5 flag 모두 명시 모달** (was: all-true 하드코딩)
   - 사용자가 5 checkbox 로 명시적으로 선택. 기본값: `name_and_description=true, tier_variation_name_and_option=true`, 나머지 3개 = false.
   - 각 flag 옆에 짧은 설명 + 경고 ("가격 ON 하면 Global 가격이 매장 가격을 덮어씀" 등).
   - "현재 매장의 sync 정책은 Shopee API 로 읽을 수 없어 (`get_sync_field` 없음) 항상 모든 flag 를 명시적으로 set 합니다" 라는 안내 추가.

4. **Rollback 문구 정정**
   - 이전: "false 로 다시 호출하면 sync OFF" → 잘못된 부분: 이미 덮어쓴 이름은 안 돌아옴.
   - 정정: "롤백 ≠ 데이터 복원". `name_and_description=false` 로 끄면 향후 sync 만 안 됨. 이미 매장에 sync 된 영문명을 다시 현지화하려면:
     - (a) 매장별로 수동 편집, 또는
     - (b) global item 의 name 을 현지화로 바꾸고 sync false 로 끈 뒤 매장에 sync 되기 전 끊기, 또는
     - (c) 받아들이고 영문 유지

5. **즉시 vs 지연 sync 검증 step**
   - 사용자가 버튼 클릭 후 1개 매장 1개 item 의 name 변경 여부 확인 가이드 추가.
   - 만약 즉시 안 바뀌면 v2 에서 `update_global_item` per-item trigger 옵션 추가.

### 갱신된 검증 기준

1. 5 flag 모달 동작 (체크 / 해제 / submit)
2. Per-shop 호출 결과 표시 (성공/실패+사유, 실패만 재시도 버튼)
3. 호출 후 1 매장 1 item 의 name 즉시 변경 여부 사용자 LIVE 확인
4. Codex 코드 리뷰 통과

