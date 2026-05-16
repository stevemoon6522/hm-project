# Spreadsheet 백업 아키텍처 조사 보고

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-16 |
| Target | shopee-dashboard — 상품 DB 의 외부 스프레드시트 미러 |
| Trigger | User: "이러한 모든 상품 DB를 스프레드시트에 먼저 저장해놔야 장기적으로 안정될 것 같다" |
| Status | 보고만 (구현은 별도 승인 후) |
| Related | [[shopee-price-sync-perf-plan]] (#2c — 결론: perf 목적은 효과 미미, 백업 목적은 유의미) |

---

## 0. TL;DR

스프레드시트는 **perf 단축에는 효과 없음** (Shopee API roundtrip 자체가 병목), 하지만 **장기 안정성/audit/manual review/disaster recovery 측면에서는 매우 유의미**.

**추천 아키텍처**: Supabase 가 source of truth + Google Sheets 가 read-only mirror (1-day cron). 양방향 sync 는 conflict 처리 복잡 → 단방향만.

---

## 1. 사용자 요구 명확화 (가설 정리)

사용자가 원하는 시나리오 후보:
- **A. Audit log / disaster recovery**: DB 가 망가져도 sheet 보면 데이터 확인 가능
- **B. Manual review / bulk edit**: sheet 에서 가격/SKU 일괄 편집 → DB 반영
- **C. 비기술자 협업**: 영업/운영팀이 sheet 에서 직접 보고 수정
- **D. Perf 단축**: dashboard 가 sheet 에서 빠르게 로드 (사용자 가설, 실제로는 효과 없음)

(D) 는 §0 에서 기각. (A)/(B)/(C) 모두 단방향 read-only mirror 로 80% 효용 달성 가능. 양방향은 추가 복잡도 큼.

---

## 2. 옵션 비교

### Option A: Google Sheets API (read-only mirror, cron 갱신)

**구현**:
- 신규 edge function `db-to-sheets-sync` (cron 1일 1회 또는 hourly)
- 핵심 테이블 (`products`, `product_shopee_listings`, `country_settings`, `inventory`) 을 sheet 의 시트별 탭으로 dump
- Service Account 키 사용 (Google Cloud Console 발급)

**비용**:
- Google Sheets API: Free tier (60 read req/min, 300 write req/min) — 충분
- 우리 데이터량 17 products + 55 listings = 1KB 미만 → trivial
- 개발: ~1-2일

**장점**:
- 비기술자 친화 (Google Workspace 환경)
- 무료
- 수정 이력 자동 (revision history)

**단점**:
- Service account 인증 셋업 필요 (Cloud Console)
- 대용량 (10k+ rows) 시 batchUpdate 필요

### Option B: Excel/CSV in Supabase Storage

**구현**:
- 신규 edge function `db-to-csv-export` (cron)
- `products.csv`, `listings.csv` 를 Supabase Storage bucket 에 저장
- 사용자가 직접 다운로드해서 Excel 로 열어봄

**장점**:
- Supabase 외부 의존성 없음
- 매우 단순 (텍스트 파일만 다루면 됨)

**단점**:
- 실시간 협업 불가
- 사용자가 다운로드 매번 해야 함
- revision history 없음 (file versioning 가능하지만 별도 설계)

### Option C: 양방향 sync (Google Sheets → Supabase, Sheets 가 source)

**구현**:
- Sheets 가 source of truth
- Webhook 또는 cron 으로 Supabase 갱신
- 또는 Apps Script onEdit trigger

**장점**:
- 사용자가 sheet 에서 직접 편집 가능
- DB schema 변경 없이도 칼럼 추가 가능

**단점**:
- Conflict 처리 매우 복잡 (Sheets 와 dashboard UI 양쪽에서 동시 편집 가능)
- Sheets 가 데이터 형식/유효성 보장 못 함 (사용자가 number 셀에 텍스트 입력 등)
- Trigger 지연/실패 시 데이터 손실 위험
- **반드시 audit log 필요**, 롤백 시나리오 설계 복잡
- 추천 안함 (단방향이 안정성/속도 모두 우수)

---

## 3. 추천 아키텍처 (Option A 단방향)

```
[Supabase products]                        [Google Sheet: shopee-dashboard-mirror]
       |                                                         ^
       v                                                         |
  [Edge function db-to-sheets-sync] -----cron 1h----> [Sheets API write batch]
       
       (read-only export, sheet 는 절대 source-of-truth 아님)
       
       (사용자가 sheet 편집 시 → 다음 cron 에 덮어쓰여짐. 명시적 warn 셀에 표시)
```

### Sheet 구조
- 탭 1: `products` (id, sku, product_name, cost_krw, weight_g, lifecycle_state, ...)
- 탭 2: `product_shopee_listings` (product_id, region, shop_item_id, shop_model_id, status, last_synced_price, last_synced_at, last_error)
- 탭 3: `inventory` (sku, on_hand, bundle_components, ...)
- 탭 4: `country_settings` (region, cost_factors, ...)
- 탭 5: `audit-log` (cron run 시각, row counts, errors)
- 탭 6: `meta` (last sync, source DB ref, "READ ONLY — edits will be overwritten")

### Cron 설정
- Frequency: 1 hour (또는 daily)
- Implementation: Supabase Edge Function + `pg_cron` extension trigger (`schedule_at = '0 * * * *'`)
- 또는 cron-job.org 같은 외부 cron → bridge endpoint 호출

### 인증
- Google Cloud Service Account
- Service Account email 을 sheet 의 editor 로 invite
- Service Account JSON key 를 Supabase Edge Function env var 에 저장 (현재 다른 secrets 와 동일 방식)

---

## 4. 구현 단계 (Option A 기준)

### Phase 1 (셋업, 0.5일)
- Google Cloud Console 에서 새 project 또는 기존 활용
- Sheets API enable
- Service Account 생성, JSON key 다운로드
- Sheet 생성, Service Account 를 editor 권한으로 invite
- Sheet ID 확보

### Phase 2 (Edge function, 1일)
- `supabase/functions/db-to-sheets-sync/index.ts` 신규
- `googleapis` Deno 호환 라이브러리 검토 (또는 직접 JWT + REST 호출)
- `supabase.from('products').select('*')` → JSON → Sheets `values.batchUpdate` 호출
- 각 탭 별 schema-aware mapping
- audit log 탭에 cron run 결과 append

### Phase 3 (cron 설정, 0.5일)
- `pg_cron` extension enable (Supabase Dashboard 에서 토글)
- `cron.schedule('sheets-sync-hourly', '0 * * * *', 'select extensions.http_post(...edge function url...)')`
- 또는 cron-job.org 등록

### Phase 4 (모니터링, 0.5일)
- 실패 시 Telegram 알림 (기존 `[sd]` channel 사용)
- 첫 24시간 sync 결과 확인

**총 추정**: ~2.5일

---

## 5. 비용

- Google Sheets API: Free (per-project quota 60 read/min, 300 write/min — 우리 규모 무관)
- Google Cloud project: Free tier
- Supabase Edge Function: 이미 사용 중인 plan 안에 포함
- pg_cron: Supabase Pro+ 필요 (현재 plan 확인 필요)

→ 사실상 추가 비용 0

---

## 6. 위험과 mitigation

| 리스크 | 완화 |
|--------|------|
| 사용자가 sheet 에서 편집 → cron 이 덮어씀 → 작업 손실 | meta 탭에 큰 글씨 warning + 편집 시도 시 audit log 에 기록. 양방향 sync 원하면 별도 design (§2 Option C 추천 안함) |
| Service Account 권한 leakage → DB 외부 노출 | Service Account 는 특정 sheet 만 editor 권한. DB 직접 접근 불가. |
| Sheets API rate limit | 우리 규모 무관. 10k+ rows 가 되어도 batchUpdate 로 안전. |
| Schema drift (DB 컬럼 추가 시 sheet 미반영) | edge function 이 `*` 로 select → JSON.keys() 동적 추출하면 자동 대응 |
| Cron 실패 | audit log + telegram 알림 |
| 민감 데이터 sheet 노출 | cost_krw 같은 민감 데이터 sheet 에 들어가는 것을 사용자가 의도하는지 확인 필요 |

---

## 7. 사용자 답변 필요

1. **사용 목적**: A (audit/DR) vs B (bulk edit) vs C (비기술자 협업)?
2. **양방향 sync 필요?** (단방향 추천이지만 사용자 요구 확인)
3. **sync 주기**: hourly / daily / on-demand?
4. **민감 데이터** (cost_krw, sourcing_price 등) 도 sheet 에 포함? 또는 selling price + IDs 만?
5. **Google Workspace 계정 사용 권한** 확인 (Service Account 생성 + Sheet 만들기 권한)
6. **Phase 1 (Google Cloud 셋업) 권한**: 진행 승인?

---

## 8. Out of scope (이번 plan 아님)

- 양방향 sync (별도 plan 필요)
- 자동 데이터 시각화 (Looker Studio 등은 별도 검토)
- 다중 sheet 분할 (테이블 별 sheet vs 1 sheet 다 탭)
- 권한 별 view (개별 사용자 별 다른 sheet 표시 등)
