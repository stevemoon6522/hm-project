# [SD] Shopee API 활용 추가 기능 제안 — Roadmap

| | |
|---|---|
| Author | Opus 4.7 |
| Date | 2026-05-16 |
| Target | shopee-dashboard 확장 |
| Trigger | User: "내 작업 스타일을 봤을때 [SD] 프로젝트에 Shopee API를 활용해서 더 추가할만한 기능이 있을까?" |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\` |
| Status | 보고만 (사용자 우선순위 결정 후 plan/구현) |

---

## 0. 사용자 작업 스타일 관찰 (오늘 세션 기준)

- **Master-data first**: 모든 상품 정보를 dashboard 에 모으고 한 화면에서 관리
- **자동화 선호**: 매핑/가격/SKU/옵션명 모두 "한 번 클릭하면 일괄 처리" 패턴
- **시각화 + 일괄 작업**: 체크박스 → 일괄 동작 (Ready Stock, 동기화 등)
- **음반 셀러 특성**: 신보 발매 cycle 에 민감 (DTS=1, 가격 조정 빈번)
- **KRSC 제약 안에서 효율 추구**: Global API + Merchant API 우선
- **즉시 검증 요구**: 변경 후 production 에 실제 적용됐는지 확인

---

## 1. 추천 기능 (사용자 스타일 부합도 순)

### 🥇 A. 신보 발매 일괄 promotion 적용

**Why**: 음반 셀러는 신보 발매 직후 1-2주 할인 promotion 으로 매출 견인. 현재는 region/shop 별 수동 작업.

**API**: `discount/` 12개 endpoint
- `add_discount`: promotion 생성 (시작일/종료일/할인%)
- `add_discount_item`: 상품 일괄 추가
- `update_discount`/`delete_discount`: 수정/취소
- `get_discount_list`: 현재 진행중 promotion 조회

**UI**:
- 새 버튼 "🎁 Promotion 만들기 (N)"
- 선택한 상품 → 모달: 시작/종료일 + region 별 할인 % → bridge 호출
- 결과: region 별 promotion ID 표시, products.promotion_id 컬럼 저장

**KRSC 제약**: Discount API 는 shop-level 이지만 KRSC 작동 가능성 큼 (가격은 shop-level 로 가능했음). 시도 가치 있음.

**구현 비용**: 1-2일

---

### 🥈 B. WMS ↔ Shopee 재고 양방향 sync

**Why**: 현재 kpop-wms 와 Shopee 재고가 별도 관리. WMS 출고 → Shopee 재고 차감 안 됨 → 품절 상품이 Shopee 에서 계속 판매됨 = 환불 발생.

**API**: `product/update_stock` (shop-level) 또는 `global_product/update_global_item` 의 stock_info
- WMS 의 `decrement_inventory_stock` RPC 가 호출될 때 cron 또는 webhook 으로 Shopee 도 update
- 신상품 입고 시 WMS 재고 → Shopee 일괄 push

**UI**:
- 새 버튼 "📦 재고 동기화 (선택 N)" → 즉시 push
- 별도 cron 으로 시간당 자동 sync (다음 plan 의 spreadsheet 옵션과 통합 가능)

**KRSC 제약**: stock 은 global_product API 로 가능. 검증 완료된 path.

**구현 비용**: 2-3일

---

### 🥉 C. 매출/주문 통계 dashboard

**Why**: 현재 dashboard 는 상품 마스터/가격 중심. 매출 추세, region 별 비중, 상품별 매출 순위 등 BI 데이터 부재.

**API**:
- `order/get_order_list` (이미 shopee-orders 함수에서 polling 중)
- `order/get_order_detail` (이미 사용)
- `shop/get_shop_performance` (등급/SLA 지표)
- `product/get_top_selling_list` (TOP N 상품)

**UI**:
- 새 view "📊 매출 대시보드" (v2/index.html 의 daily-close 와 통합 가능)
- 일/주/월별 매출 차트 (region 별 색상)
- 상품별 매출 ranking + 재고 잔량 overlay

**구현 비용**: 3-4일

---

### 4️⃣ D. 반품/환불 monitoring + 자동 처리

**Why**: 반품/환불 처리 누락 시 shop rating 하락. 현재 manual.

**API**: `returns/` 15개 endpoint
- `get_return_list`: 진행중 반품 목록
- `accept_offer`/`confirm`: 자동 승인
- `get_available_solutions`: Shopee 제안 솔루션 (refund/return)
- `get_return_dispute_reason`: 분쟁 사유

**UI**:
- 새 view "🔄 반품 관리"
- 진행중 반품 리스트 + 자동 처리 규칙 (소액 자동 환불 등)
- Telegram 알림 (반품 발생 시)

**구현 비용**: 2-3일

---

### 5️⃣ E. 카테고리 속성 검증 (등록 전 사전 체크)

**Why**: 신상품 등록 시 카테고리 필수 attribute 누락 → publish 실패. 현재 사후 발견 → 재등록 손실.

**API**:
- `product/get_attributes` (이미 일부 사용)
- `product/get_attribute_tree` (전체 속성 tree)
- `global_product/get_attribute_tree` (global 버전)

**UI**:
- v2 register wizard 에 attribute completeness 검증
- 카테고리 선택 시 필수 attribute 목록 사전 표시
- 누락 attribute 자동 제안 (기본값 추론)

**구현 비용**: 1-2일

---

### 6️⃣ F. 광고 자동화 (Ads API)

**Why**: 신보 발매 직후 keyword 광고 / boost 로 노출 증가. 현재 manual.

**API**: `ads/` 다수 endpoint + `product/boost_item`
- `boost_item`: 검색 상단 5분간 노출
- ads API: 키워드 광고 캠페인

**UI**:
- 새 버튼 "📢 광고 시작 (N)" → 키워드/예산 설정 → 일괄 캠페인 생성
- Boost button: 신보 발매 직후 일괄 boost

**구현 비용**: 3-5일 (Ads API 가 복잡)

---

### 7️⃣ G. Voucher (쿠폰) 자동 발급

**Why**: "신보 구매 시 N% 쿠폰" 같은 캠페인을 자동화. 마케팅 효과.

**API**: `voucher/` 다수 endpoint
- `add_voucher`, `add_voucher_target_item`
- `update_voucher_lifetime`

**UI**: 가벼운 modal 로 쿠폰 발급 (선택 상품 대상)

**구현 비용**: 1-2일

---

### 8️⃣ H. Live commerce 통합

**Why**: Shopee Live (live streaming sales) 가 K-pop 굿즈 트래픽 큼.

**API**: `livestream/` endpoint
- 라이브 일정 등록, 상품 선택, 라이브 중 가격 변경

**UI**: 별도 view (실시간성 강함)

**구현 비용**: 5+일 (영상 + UI 복잡)

---

## 2. 1차 추천 (사용자 즉시 가치 큰 순)

1. **A. Promotion 일괄 적용** — 음반 셀러 핵심 use case
2. **B. WMS 재고 sync** — 데이터 정합성, 환불 감소
3. **C. 매출 dashboard** — 의사결정 기반
4. **E. 카테고리 속성 검증** — 신상품 등록 효율

A/B/C 가 가장 ROI 높음. E 는 작은 추가 작업.

---

## 3. 사용자 결정 필요

어떤 기능부터 plan/구현 진행할까요?
- A. Promotion 일괄 (1-2일)
- B. 재고 sync (2-3일)
- C. 매출 dashboard (3-4일)
- D. 반품 관리 (2-3일)
- E. 카테고리 검증 (1-2일)
- F. 광고 (3-5일)
- G. 쿠폰 (1-2일)
- H. Live (5+일)

복수 선택 가능, 또는 우선순위만 알려주시면 순차 진행.
