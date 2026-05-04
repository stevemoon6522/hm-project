# shopee-dashboard / kpop-wms 작업 로드맵

마지막 업데이트: 2026-05-04

---

## 1. 진행 중 / 검토 대기

### 1.1 SET (번들) 상품 데이터 모델 설계 — 사용자 검토 대기

**배경**
- Shopee 셀러센터에서 "3 VER SET" 같은 번들 상품은 단일 listing(model_id 1개, 가격 1개, stock 1개)로 등록됨
- 그러나 출고 시에는 컴포넌트 (예: ME + YOU + AND US 3종)를 분리해서 동봉 발송
- 매입가/재고/픽킹/라벨 처리가 단순 SKU와 다름

**제안 데이터 모델**

`products` 테이블에 컬럼 1개 추가:

```sql
ALTER TABLE products ADD COLUMN bundle_components JSONB;
```

값 형태:
```json
[
  { "sku": "L3-IVE-EMPAT-PHO-ME", "qty": 1 },
  { "sku": "L3-IVE-EMPAT-PHO-YOU", "qty": 1 },
  { "sku": "L3-IVE-EMPAT-PHO-AND US", "qty": 1 }
]
```

- `null` 또는 빈 배열 → 일반 상품
- 비어있지 않은 배열 → 번들 상품

별도 테이블 안 만드는 이유: 번들 정의가 자주 안 바뀜 + JSONB 한 컬럼이면 충분. 나중에 정규화 필요해지면 분리.

**행동 규약 제안**

| 항목 | 권장 동작 | 사용자 확인 필요 |
|------|----------|-----------------|
| 매입가 (cost) | 컴포넌트 cost 합으로 derived (read-only + 툴팁) | 할인 적용 케이스 있는지? (Q2) |
| 재고 (stock) | min(컴포넌트 stock) — 자동 산출 | Shopee 쪽 자동 push 여부 (Q4) |
| 가격 (price) | 변경 없음 — model 단위 push 그대로 | — |
| 주문 처리 | /poll 시 SET SKU 그대로 저장 → picking 시 expand | — |
| 라벨 | SET SKU + 컴포넌트 표시 | 표시 형식 (Q5) |
| UI | SET 행에 "📦 번들 편집" 버튼 + 표 셀 뱃지 | — |

**사용자 답변 대기 중인 5가지 질문**

- **Q1.** region별 컴포넌트 차이: SET 의 컴포넌트가 region 마다 다를 수 있나요? (BR 만 4종 SET 등) — 기본 가정: 동일
- **Q2.** cost override 필요: SET 매입가가 컴포넌트 합과 항상 같나요? 할인 들어가는 경우?
- **Q3.** nested bundle: 번들 안에 번들이 또 들어갈 일 있나요? (없으면 단순 구조)
- **Q4.** 재고 푸시: Shopee 의 SET model 재고를 자동으로 min(컴포넌트)로 동기화 push 할까요? 셀러센터에서 수동?
- **Q5.** WMS 라벨 표시: SET 라벨에 컴포넌트 3종을 어떻게 표시? "포함: ME / YOU / AND US" 한 줄? 별도 박스? 안 표시?

→ 답변 주시면 마이그레이션 + UI + WMS 변경 사양 정리해서 phase 별로 진행.

---

## 2. 작업 후보 (사용자가 우선순위 지정)

### 대시보드 (shopee-dashboard)
- [ ] 매핑 동기화 후 미매칭/중복 행 수동 매칭 UI (별도 모달)
- [ ] 가격 산출 식 검증 (region 별 마진 확인 + 일괄 미리보기)
- [ ] 매핑 결과 CSV 내보내기 (백업/감사용)

### WMS (kpop-wms)
- [ ] ship_order 90% 성공률 (v31 적용분) 모니터링 대시보드 — 실패 사례 자동 집계
- [ ] 라벨 PDF 디자인 추가 개선 (사이즈/폰트/QR 등)
- [ ] 주문 검색/필터 기능 강화

### 크롤링/통합
- [ ] Staronemall 크롤러 안정화 (이슈 발견 시)
- [ ] Joom 처리 흐름 개선
- [ ] **Qoo10 + KSE** — KSE API 승인 메일 받으면 즉시 진행 (현재 대기 중)

### 운영 도구
- [ ] 영구정지/휴면 샵 관리 UI (status='banned' 처리를 SQL 없이)
- [ ] 토큰 상태 모니터링 + 만료 알림
- [ ] 활동 로그 / audit trail

---

## 3. 최근 완료 (참고)

### 2026-05-04 작업
- **shopee-orders v30~v33 배포** — 토큰 관리 전면 개편
  - merchant_id 기반 refresh로 토큰 영구 merchant-scope 유지
  - shopee_tokens 자동 동기화 (last_polled_at 우선 → 활성 샵 정확히 선택)
  - status='banned' 샵 영구 격리 (sync/refresh/re-auth 모든 경로에서 보호)
- **shopee-orders v31** — ship_order 90% 성공률 보장
  - arrangeOrders 사전 status 체크 (배치 get_order_detail)
  - shipOrderWithRetry transient 에러 재시도
  - 병렬 동시 호출 5 → 3
- **shopee-bridge v18~v19** — /list_items 추가 + 다중 model 지원
  - 페이지네이션 + base_info + get_model_list 자동 확장
  - has_model=true 인 item 은 model 단위로 펼쳐서 반환 (item_id + model_id + model_sku)
- **shopee-dashboard 다중 model 매핑 지원**
  - product_shopee_listings.shop_model_id 컬럼 추가
  - 매핑 동기화 모달이 model SKU 와 매칭 → model_id 저장
  - 가격 갱신이 model_id 포함하여 push
- **shopee-dashboard SHOPEE_REGIONS 6개로 확정** (SG/TW/TH/MY/PH/BR), VN/MX 제외
- **shopee-dashboard "🔗 Shopee 매핑 동기화" UI** — 6 region 병렬 fetch + 자동 매칭 + 미리보기 + 일괄 적용

### 진행 중단 / 대기
- **Qoo10 + KSE 통합** — KSE API 승인 메일 대기 (이메일 보낸 상태)

---

## 4. 환경 / 인프라 메모

- **GitHub:** https://github.com/stevemoon6522/shopee-dashboard (main 브랜치)
- **Vercel:** moon-jeonghos-projects/shopee-dashboard (자동 배포 미연결 → `vercel deploy --prod --yes` 수동 실행 필요)
- **Supabase:** project_id `bpdafetvjyvvwbksvowu` (slug `starwms`)
- **Edge Functions:** shopee-orders v33, shopee-bridge v19, joom-orders v7
- **Live URL:** https://shopee-dashboard-kohl.vercel.app/
- **kpop-wms:** https://github.com/stevemoon6522/kpop-wms → https://stevemoon6522.github.io/kpop-wms/
