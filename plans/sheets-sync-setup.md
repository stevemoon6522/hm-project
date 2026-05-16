# Spreadsheet Sync 셋업 가이드

| | |
|---|---|
| Author | Opus 4.7 |
| Date | 2026-05-16 |
| Related | [[spreadsheet-backup-plan]] — 설계 |
| Status | Edge function `sheets-sync` 배포 완료 (v1), credentials 없으면 동작 안 함 |

---

## 0. 한눈에 보기

1. Google Cloud Project 생성 + Sheets API enable
2. Service Account 생성 + JSON key 다운로드
3. **새 Google Spreadsheet 생성** (이 sync 전용)
4. Spreadsheet 의 Editor 권한을 Service Account email 에 부여
5. Supabase 에 두 secret 설정: `GOOGLE_SERVICE_ACCOUNT_JSON`, `SHEETS_SPREADSHEET_ID`
6. Dashboard 의 "📤 Sheet 내보내기" 버튼 클릭 → 첫 push 동작 확인

---

## 1. Google Cloud Project 생성

1. https://console.cloud.google.com 접속
2. 상단 project 선택 dropdown → **NEW PROJECT**
3. Name: `starphotocard-sheets-sync` (또는 원하는 이름)
4. Create

## 2. Sheets API enable

1. APIs & Services → Library
2. "Google Sheets API" 검색
3. **Enable**

## 3. Service Account 생성

1. IAM & Admin → Service Accounts → **+ CREATE SERVICE ACCOUNT**
2. Name: `sheets-sync-bot`
3. Description: "shopee-dashboard 양방향 sync"
4. Create and Continue (skip optional steps)
5. 생성된 SA 클릭 → **Keys** 탭
6. **ADD KEY → Create new key → JSON** → 다운로드
   - 파일명 예: `starphotocard-sheets-sync-abc12345.json`
   - **이 파일은 비밀 — 절대 git 에 commit 금지**

7. SA email 복사 (예: `sheets-sync-bot@starphotocard-sheets-sync.iam.gserviceaccount.com`)

## 4. 새 Spreadsheet 생성

1. https://sheets.google.com 에서 **+ Blank** 클릭
2. 이름: `shopee-dashboard-sync` (또는 원하는 이름)
3. **공유** 버튼 클릭 → 위에서 복사한 SA email 입력 → **편집자(Editor)** 권한 → 보내기
   - "Notify people" 체크박스는 해제해도 됨
4. URL 에서 spreadsheet ID 복사
   - URL: `https://docs.google.com/spreadsheets/d/`**`<HERE>`**`/edit`
   - 예: `1aBcD2eFgHiJk3LmNoPqRsTuVwXyZ4-fGhIjKlMnOpQ`

## 5. Supabase secrets 설정

PowerShell 에서:

```powershell
cd C:\dev\shopee-dashboard

# JSON key 를 환경변수로 직접 set
$key = Get-Content -Raw "C:\path\to\starphotocard-sheets-sync-abc12345.json"
npx supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$key" --project-ref bpdafetvjyvvwbksvowu

# Spreadsheet ID set
npx supabase secrets set SHEETS_SPREADSHEET_ID="1aBcD2eFgHiJk3LmNoPqRsTuVwXyZ4-fGhIjKlMnOpQ" --project-ref bpdafetvjyvvwbksvowu
```

확인:

```powershell
npx supabase secrets list --project-ref bpdafetvjyvvwbksvowu
```
→ `GOOGLE_SERVICE_ACCOUNT_JSON` 과 `SHEETS_SPREADSHEET_ID` 둘 다 보이면 OK.

## 6. Health check

```powershell
$h = @{ Authorization = "Bearer $($env:SUPABASE_ANON)"; apikey = "$($env:SUPABASE_ANON)" }
Invoke-RestMethod -Uri "https://bpdafetvjyvvwbksvowu.supabase.co/functions/v1/sheets-sync/health" -Headers $h
```

응답이:
```json
{
  "ok": true,
  "service": "sheets-sync",
  "version": 1,
  "env": {
    "has_GOOGLE_SERVICE_ACCOUNT_JSON": true,
    "has_SHEETS_SPREADSHEET_ID": true
  },
  "whitelisted_tables": ["products", "product_shopee_listings", "country_settings"]
}
```

→ 두 env 가 `true` 면 셋업 완료.

---

## 7. 사용법

### Dashboard 버튼:
- **📤 Sheet 내보내기**: DB → Sheet (모든 row 덮어쓰기)
- **📥 Sheet → DB**: Sheet 에서 변경 사항 미리보기 → 확인 → 적용 (전 자동 백업)

### Sheet 구조 (자동 생성):
- 탭 `products` — 모든 컬럼. 일부만 편집 가능 (Editable column: sku, product_name, option_name, cost_krw, weight_g, sourcing_price, lifecycle_state, purpose, tags, description, main_image, staronemall_url). 나머지 컬럼은 헤더에 ` (read-only)` 라고 표시되고 편집해도 무시됨.
- 탭 `product_shopee_listings` — Editable: shop_item_id, shop_model_id, status, days_to_ship, title_state.
- 탭 `country_settings` — Editable: 거의 모든 fee 필드.
- 탭 `_backup_<table>_<timestamp>` — Pull 직전 DB snapshot 자동 백업. 잘못된 변경 시 이 탭 보고 복원.

### 양방향 동작 흐름:
1. 사용자가 "📤 Sheet 내보내기" 클릭 → 현재 DB 상태가 Sheet 에 dump
2. 사용자가 Sheet 에서 cost_krw, price 등 편집
3. 사용자가 "📥 Sheet → DB" 클릭
4. Edge function 이 변경 사항 계산 → "총 N개 셀 변경, 적용할까요?" prompt
5. OK → DB snapshot 백업 (`_backup_*` 탭) → 변경 사항 DB 적용
6. Cancel → 아무것도 안 함

---

## 8. 주의 사항

- **Sheet 편집은 push 후에만 의미 있음**. Push 안 한 상태에서 Sheet 에 수동 행 추가하면 PK 매칭 안 돼서 적용 안 됨.
- **양방향 운영 중 데이터 손상 방지**:
  - 한 사람만 Sheet 편집
  - 편집 끝나면 즉시 Pull (다른 사람이 dashboard 에서 동시 편집 → conflict 위험)
  - 매번 백업 탭 생성됨 — 복원 가능
- **민감 데이터**: `cost_krw`, `sourcing_price` 도 Sheet 에 들어감. 사용자가 "모두 포함" 결정함.
- **Auto-create new Spreadsheet**: 현재 미지원 (사용자가 수동으로 생성). 필요시 Drive API 추가 가능.

---

## 9. Out of scope (현재 v1 에 없음)

- Cron 자동 sync (사용자가 "수동만" 선택)
- 한 row 변경 단위로 즉시 sync
- 사용자별 권한 분리
- Sheet 에서 row 신규 추가 (PK 가 없는 row → 무시됨)
- Sheet 에서 row 삭제 → DB delete (안전상 unsupported, 백업 탭에 보존만)
