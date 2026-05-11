# Plan: Shopee 대시보드 — READY STOCK 전환 마법사 (Phase B)

- 작성일: 2026-05-11
- 작성자: Opus (Claude Code)
- 컨텍스트: 사용자가 정의한 PRE ORDER → READY STOCK 전환 워크플로 자동화

## 사용자 워크플로 요약

1. **PRE ORDER 등록**: 상품명에 `[PRE ORDER]` 접두 + 각 region Days to Ship 50~60일
2. **입고 후 READY STOCK 전환** (전환율 가장 높은 시점):
   - 상품명 `[PRE ORDER]` → `[READY STOCK]` 치환
   - 모든 region Days to Ship → 1
   - 옵션별 앨범 무게 측정 → Global SKU → 모든 region Shop SKU 전파
   - 무게 기반 region별 마진 재계산 → 신규 판매가 push
3. **운영 중**: 매입가 변동 잦음 → 빠르게 판매가 반영

## 데이터 모델 변경 (Phase A 최소 분량)

### `products` (per-option row)

| 컬럼 추가 | 타입 | 설명 |
|----------|------|------|
| `lifecycle_state` | text | `pre_order | arrived | ready_stock | sold_out | archived` (제약 없이 시작) |
| `weight_measured_at` | timestamptz | 실측 무게 등록 시각 |
| `cost_updated_at` | timestamptz | 매입가 마지막 갱신 시각 |

같은 모상품(같은 shopee_item_id)의 옵션들은 같은 lifecycle_state를 공유한다. 전환 시 update 한 번에 묶음.

### `product_shopee_listings` (per-region row)

| 컬럼 추가 | 타입 | 설명 |
|----------|------|------|
| `days_to_ship` | integer | region별 Days to Ship |
| `title_state` | text | `PRE_ORDER | READY_STOCK` — 마지막으로 push한 접두 상태 |
| `last_pushed_name` | text | drift 감지용 — 마지막으로 push한 상품명 |
| `last_pushed_at` | timestamptz | 마지막 push 시각 (last_synced_at은 price-only sync용으로 유지) |

## 마법사 UI (shopee-dashboard index.html)

- 모달 진입점: 메인 toolbar에 신규 버튼 `📦 READY STOCK 전환`
- 1단계: 좌측 상품 검색/멀티 선택 (BOYNEXTDOOR 수정으로 캐시 활용 가능한 modal 재사용)
- 2단계: 우측 패널
  - 옵션별 무게 입력 (10g step, 직접입력 가능)
  - 동일 앨범의 마지막 입력 무게 자동 prefill
  - 자동 액션 체크박스 (기본 모두 ON)
    - ☑ 상품명 `[PRE ORDER]` → `[READY STOCK]` 치환
    - ☑ 모든 region Days to Ship → 1
    - ☑ 옵션별 무게 → Global SKU → Shop SKU 일괄 적용
    - ☑ region별 무게 기반 마진 재계산 → 신규 판매가
- 3단계: 미리보기 매트릭스 (region × 옵션)
  - 현재가 / 신규가 / 마진% 변화 표시
  - 변경 없는 cell은 회색 처리
- 4단계: "Shopee에 일괄 반영" — 백엔드 batch endpoint 호출

## 백엔드 endpoint (shopee-bridge edge function)

| Action | 기능 | Shopee API |
|--------|------|-----------|
| `update_global_item` (확장) | 부모 SKU + `item_name` + `description` | `/api/v2/global_product/update_global_item` |
| `update_global_model` (확장) | variant SKU + `weight_g` per model | `/api/v2/global_product/update_global_model` |
| `update_global_price` (기존) | 신규 판매가 push | `/api/v2/global_product/update_price` |
| `update_shop_days_to_ship` (신규) | region별 DTS 변경 | `/api/v2/product/update_item` (shop level) |

마법사 1회 클릭 → 프론트엔드가 위 endpoint를 (region × 옵션) 매트릭스에 맞춰 chunk 호출. 실패한 row는 미리보기 테이블에 ❌ 표시로 retry 가능.

## 안전장치

- **dry-run** 토글: 실제 호출 없이 페이로드만 콘솔/UI 출력
- **drift 경고**: `last_pushed_name`이 현재 Shopee 측 이름과 다르면 (재조회 시) 사용자에게 알림
- **변경 이력 로그** (`shopee_mutation_log`): action, region, target_id, before, after, request_id, status, when

## 구현 순서 (작은 commit으로 점진 진행)

1. **(이 PR)** Plan 문서 저장 + 스키마 마이그레이션 (`products` + `product_shopee_listings` 컬럼 추가)
2. shopee-bridge: `update_global_item`에 `item_name`/`description` 지원 추가, `update_global_model`에 `weight` 지원 추가, `update_shop_days_to_ship` 신규 추가
3. 마법사 모달 UI skeleton (모달 토글 + 1단계 상품 선택)
4. 마법사 2~3단계 — 무게 입력 + 미리보기 매트릭스
5. 마법사 4단계 — endpoint 일괄 호출 + 결과 표시
6. `shopee_mutation_log` 테이블 + 변경 이력 기록
7. (옵션) drift 감지 + dry-run 토글

## 검증 기준

- 5개 옵션 × 6개 region 묶음을 1클릭으로 일괄 전환 시 1분 이내 완료
- 한 region 실패 시 다른 region은 정상 적용 (atomic은 아님)
- 변경 이력 로그에 모든 mutation 기록
- 사용자 매뉴얼 작업 시간 90% 단축 목표

## 향후 (Phase C 이후) 작업

- 매입가 단일 inline 편집 + region별 신규가 실시간 미리보기
- 칸반 보드 (PRE ORDER / 입고 후 / READY STOCK / SOLD OUT)
- xlsx import — 가격/SKU 일괄 변경
- 매입가 변동 알림 (14일 경과)
- Apps Script onEdit 직결 (선택)

## Revision (Codex)

(다음 단계에서 codex 어드버서리얼 리뷰 받은 후 추가)
