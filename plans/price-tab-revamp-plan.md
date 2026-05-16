# 가격 수정 탭 개편 플랜

- **작성:** Opus 4.7
- **날짜:** 2026-05-09
- **대상:** shopee-dashboard 가격 수정 탭 (`C:\dev\shopee-dashboard\index.html`)
- **목적:** UI 단순화 + 상품 검색 기능 안정화로 Shopee/Joom 상품을 SKU 기준으로 빠르게 매칭/동기화

## 컨텍스트

`#tab-price` 패널의 `.toolbar` (line 740~758)에는 현재 11개 컨트롤이 나열되어 있는데, 사용자의 실제 워크플로우(상품 검색 → SKU 매칭 → Shopee 동기화)에 쓰이지 않는 항목이 다수 포함됨. 또한 `🔍 상품 검색` 모달의 키워드 검색이 실패하는 버그가 보고됨 (shopee-bridge v26 배포 후에도 결과 미표시).

## 작업 목록

### Task 1 — 상품 검색 버튼을 툴바 최좌측으로 이동

- **현재 위치:** `index.html:754`, `#keyword-price-open` 버튼이 `.toolbar-right` 안에 위치
- **새 위치:** `.toolbar-left` 영역의 최좌측 (또는 좌측 영역으로 이동)
- **사유:** 사용자 워크플로우의 시작점이므로 시각적 우선순위 부여
- **주의:** 버튼 색상/스타일은 현재 유지(또는 `primary` 강조 적용 검토)

### Task 2 — 미사용 컨트롤 제거

| 대상 | 위치 | 비고 |
|---|---|---|
| `#search` (SKU/옵션명 검색 input) | line 743 | 입력+래퍼 div(`.search-box`) 함께 제거 |
| `#add-row` (+ 상품 추가) | line 748 | |
| `#refresh-all-staronemall` (🔄 전체 재크롤링) | line 749 | |
| `#export-csv` (CSV 내보내기) | line 755 | |
| `#import-csv` (CSV 가져오기) | line 756 | |
| `#csv-file` (hidden file input) | line 757 | |

**유지:** `#tag-filter` (모든 태그 셀렉트), `#shopee-sync-mapping`, `#shopee-bulk-sync`, `#bulk-clear-mapping`, `#bulk-complete-remove`, `#keyword-price-open` (이동), `#add-row-inline` (테이블 하단 행 추가, 명시적 제거 요청 없음).

**JS 정리:** 제거된 컨트롤에 연결된 이벤트 핸들러/바인딩/관련 함수도 함께 삭제 (예: CSV import/export 함수, 검색 input 필터링 코드, 전체 재크롤링 핸들러). 단 함수가 다른 위치에서도 호출되는지 확인 후 제거.

### Task 3 — 상품 검색 모달 키워드 검색 버그 수정 (Codex 검증 필요)

- **증상:** 키워드 입력 후 검색해도 결과가 표시되지 않거나, "전체 0개" 상태로 끝남
- **현재 흐름** (`index.html:4573~4614`):
  1. `_gkpFetchAllGlobalItems()` 호출 → shopee-bridge `/global_items` (v26: shop access_token + merchant_id 서명)
  2. 키워드로 `item_name` 사전 필터
  3. `_gkpEnrichItems()` → `/global_item_info`, `/global_model_list` 호출하여 모델별 정보 조회
  4. `_gkpFilter()` → 키워드로 최종 필터
  5. `_gkpBuildRows()` → 테이블 row 생성
- **가설:**
  1. v26 deploy 후에도 `/global_items`가 여전히 실패 → fallback `_gkpFetchShopItemsFallback()`이 동작하지만 결과 부족
  2. enrichment 시 응답 필드명이 코드와 불일치 (`global_item_list`, `global_model`, `global_model_sku`, `tier_index`)
  3. `_gkpFilter`가 model의 `global_model_sku`만 검사해서 item_name에 키워드가 있는데도 모델에는 없는 경우 누락
- **검증 절차 (Codex 위임):**
  - 실제 `/global_items?region=SG`, `/global_item_info`, `/global_model_list` 호출 응답 JSON을 캡처해 코드의 파싱 경로와 1:1 비교
  - 실패 시 fallback 진입 여부와 fallback 결과 검증
  - 키워드 매칭 로직(`_gkpFilter`)의 누락 케이스 진단
- **제약:** edge function 수정이 필요하면 별도 단계로 분리 (이 플랜은 클라이언트 측 수정 우선)

### Task 4 — `.row-select` 체크박스 크기 확대

- **현재:** `index.html:3007` `<input type="checkbox" class="row-select" ...>` 셀에 `padding:0` 적용, 기본 OS 사이즈
- **변경:** `.row-select`, `#select-all-rows`(line 2934)에 `width:16px; height:16px; cursor:pointer;` (또는 CSS 클래스화) 적용. 셀 padding은 `2px 0` 정도로 미세 조정
- **검증:** 체크박스가 확대되어도 다른 컬럼 정렬을 깨뜨리지 않을 것

## 검증 기준

1. 페이지 로드 후 가격 수정 탭에서 상품 검색 버튼이 최좌측에 노출
2. 제거된 컨트롤이 DOM에 존재하지 않으며 콘솔 에러 없음
3. 키워드 "ENHYPEN" 검색 시 ENHYPEN 관련 상품이 결과에 표시
4. 체크박스 클릭 영역이 16px 이상으로 확대되고 헤더/행 모두 동일하게 적용

## 영향 파일

- `C:\dev\shopee-dashboard\index.html` (단일)
- shopee-bridge edge function은 본 플랜 범위 외 (필요 시 후속 작업)

## Out of Scope

- DB 스키마 변경
- 가격 수정 탭 외 다른 탭 변경
- shopee-bridge edge function 코드 수정 (Task 3 진단 결과 필요 시 분리)

## Revision (Codex)

### Task 3 재진단 (가장 중요)

**기존 진단 WRONG.** `_gkpFilter` (index.html:4412-4418)는 이미 `item_name`, `item_sku`, `models[].global_model_sku` 셋 다 검사하고 있음. "global_model_sku만 체크" 가설은 틀림.

**실제 원인:** enrichment 전의 `preFiltered`가 `item_name`만으로 1차 컷오프함 (index.html:4589-4591). SKU나 옵션명에 키워드가 있어도 `item_name`에 없으면 이 단계에서 이미 잘려나감. Bridge나 edge function 수정 불필요. 클라이언트 5줄 수정으로 해결.

**v26 전제 재검토:** "v26 이후에도 /global_items가 기본 실패한다"는 가설은 오진 위험. v26은 `merchantApiCall`에서 shop token + merchant_id 서명으로 정상 구현됨 (edge-functions/shopee-bridge/index.ts:137-148). 응답 필드명 불일치 가설(`global_item_list`, `global_model`)도 코드와 일치함 — 클라이언트 파싱(index.html:4389, 4398)이 bridge 응답 래퍼와 맞물림.

### 추가 엣지 케이스

- 검색 재실행 시 `#gkp-select-all` 체크 상태가 초기화되지 않음. `_gkpUpdateCheckedCount()`만 갱신되고 select-all 체크박스는 이전 상태가 남아 UX 오염 (index.html:4488, 4606).
- Fallback 모드의 `global_item_id`는 문자열 합성(`${item_id}-${model_id}`)이지만 expand 토글은 `Number(btn.dataset.gid)` 변환 사용 (index.html:4363, 4620). 정상 모드와 fallback 모드에서 expand 동작이 일관되지 않음.

### 작업 재구성

- **Task 1 + Task 2 병합** — 동일 toolbar 블록(`#keyword-price-open`, `#search`, `#add-row`, CSV 버튼)을 같이 건드리므로 한 번에 처리해야 duplicate bind/cleanup 패스 방지. → "Task 1: 툴바 재구성"으로 통합.
- **Task 3 분리:**
  - 3a. `preFiltered` 수정: `item_name` 단일 필터를 제거하거나 `item_sku` OR 조건 추가 (~5줄 변경, index.html:4589-4591)
  - 3b. Fallback 모드 expand-state 일관성 수정 (Number 변환 vs 문자열 ID)
  - 3c. select-all 체크박스 초기화 추가
  - 3d. 회귀 검증 (item_name 매칭, item_sku 매칭, 둘 다 매칭, fallback 케이스)
- Task 4 (체크박스 확대)는 단독 유지.

### 검증 기준 강화

기존 기준 "ENHYPEN 검색 시 ENHYPEN 관련 상품이 결과에 표시"만으로는 SKU 검색 버그가 잔존해도 통과함. 추가:

1. `item_name`에는 없고 `item_sku`에만 키워드가 있는 케이스 → 결과 포함됨
2. `item_name`에는 없고 model의 `global_model_sku`에 키워드가 있는 케이스 → 결과 포함됨 (model_header가 결과에 노출)
3. 검색 재실행 시 select-all 체크박스가 unchecked 상태로 리셋
4. Fallback 모드 진입 조건(허용된 에러 regex, index.html:4595)과 비허용 에러 시 사용자 메시지 노출 동작 검증
5. Fallback 모드에서도 expand/collapse가 정상 동작

### 작업 우선순위

`Task 1 (툴바 재구성)` → `Task 3a (preFiltered 수정)` 두 개가 사용자 워크플로우에 가장 큰 영향. 나머지 (3b, 3c, 3d, Task 4)는 동일 PR에 묶되 별도 커밋으로 분리.
