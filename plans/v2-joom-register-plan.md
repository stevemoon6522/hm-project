# Plan: v2/ Joom 상품 등록 (옵션 묶음 + 별도 발행 버튼)

- 작성일: 2026-05-22
- 작성자: Opus (Claude Code)
- 트리거: 운영자 메시지 #861 "Joom 상품 등록 구현하자" + #863 (SKU immutable, 정사각형 강제) + #866 (5 결정) + #868 (B 별도 발행 흐름)
- 선행: `plans/v2-register-variants-plan.md` (Shopee 옵션 묶음, completed)
- Codex 적대적 리뷰: 미실시 (이 plan 작성 후)

---

## 0. 운영자 결정 요약

1. **카테고리 default**: `music_albums_cd` (운영자 카드 헤더 select 로 변경 가능, 다른 후보 fan_attributes / trading_cards / memorabilia / music_albums).
2. **통화**: USD 고정. 가격 = `cost_krw / 1380 / (1 - 0.15)` = cost_krw × 0.000853 (15% 마진).
3. **Brand**: artist 이름 자동 채움. **승인 brand list endpoint 없음** (Joom API 부재) → artist 그대로 전달 + Joom 사후 infraction 모니터링.
4. **Variant size**: 옵션명 그대로 (예: "셔누", "A ver."). 단독 상품은 "ONE SIZE".
5. **Immutable**: Shopee 와 동일 정책 — 발행 후 옵션 수정은 Joom 셀러센터 직접. fallback 호출 코드 미구현.
6. **발행 트리거 시점 (msg #868)**: **B 선호** — Joom 별도 발행 버튼 (Shopee 와 분리). 몇 번 운영 후 A (자동 동시) 로 점진 전환.

---

## 1. 핵심 정책 (운영자 #863)

### 1-1. SKU immutable 강제 (Joom)
- Joom 의 variant.sku 가 한 번 등록 후 절대 수정 불가.
- **운영자 마스터 products.sku 와 Joom variant.sku 가 정확히 일치해야**.
- joom-bridge 의 publish 흐름 (line 261) 이 이미 `cfg.sku` 우선 사용 → variantsConfig 의 각 sku 에 운영자 products.sku 그대로 전달하면 자동 충족.
- safeSku 함수 (line 143) 는 dead code (publish 흐름에서 미사용) — 그대로 두거나 제거.

### 1-2. 정사각형 이미지 강제 (Joom)
- Joom 은 정사각형 이미지만 등록 가능.
- joom-bridge 의 `processDetailImage` (line 207-230) 가 portrait 이미지 (height > width × 1.5) 를 정사각형 4 타일로 분할 + Cloudinary 업로드. 마지막 짧은 타일은 흰색 padding.
- **메인 이미지**: staronemall 원본이 정사각형이면 그대로 사용. 정사각형 아니면 검증 차단 + 운영자 통보 (메인 이미지 분할은 의미 없음 — 단일 대표 이미지 필요).
- **상세 이미지 (extra_images + detail_images)**: 기존 분할 로직 그대로 사용.
- 운영자 starphotocard 레이어 합성은 Joom 미적용 ([[project_starphotocard_layer_overlay_rule]] memory).

---

## 2. 데이터 모델 (변경 최소)

기존 products 테이블의 컬럼 그대로 활용:
- `sku` (Joom variant.sku 와 1:1)
- `variation_tier_index`, `variation_tier_names`, `variation_option_names`, `product_group_id` (Shopee 작업으로 도입, Joom 도 동일 활용)
- `joom_product_id`, `joom_variant_id`, `joom_currency`, `joom_status`, `joom_published_at`, `joom_mapping_status`, `joom_mapping_error`, `joom_last_synced_price`, `joom_last_synced_at` (cutover 시점에 이미 schema 에 있음)

**신규 컬럼 없음**.

---

## 3. v2/index.html UI 변경

### 3-1. 카드 헤더에 Joom 발행 영역 추가
Shopee 발행 버튼 옆 또는 아래에 Joom 별도 발행 영역:
- **Joom 카테고리 select**: music_albums_cd (default) / music_albums / trading_cards / memorabilia / fan_attributes 다섯 후보 드롭다운.
- **Brand input**: 카드 진입 시 artist 자동 채움 + 운영자 수정 가능. 빈값 허용 (No Brand).
- **"Joom 발행" 버튼**: 클릭 시 mrPromoteJoom() 호출.
- **발행 상태 표시**: pending / publishing / published / failed. publish 후 joom_product_id + Joom 셀러센터 link.

### 3-2. 옵션 행 데이터
Shopee 와 동일 옵션 행 (sku/cost/weight/main_image/extra_images) 그대로 활용. Joom 만 추가 입력 X.

### 3-3. mrPromoteJoom 함수 (신규)
```
async function mrPromoteJoom(group) {
  // 1. Pre-validation
  - 옵션 행 모두 sku/cost/weight/main_image 입력 확인
  - 메인 이미지 정사각형 검증 (image natural width === height) — 운영자 burnable URL 가능 한 검증, fail 시 사전 차단
  
  // 2. variantsConfig 구성 — 옵션마다 운영자 products.sku 그대로
  const variantsConfig = group.rows.map(row => ({
    name: row._optionNames.join(' / '),  // 옵션명 또는 'DEFAULT'
    sku: row._sku,  // 운영자 마스터 SKU 그대로 (Joom variant.sku immutable)
    price: String((row._costKrw / 1380 / 0.85).toFixed(2)),  // USD 계산
    currency: 'USD',
    inventory: 0,  // pre_order
    enabled: true,
  }));
  
  // 3. joom-bridge /publish 호출
  const resp = await fetch(SHOPEE_BRIDGE_BASE + '/joom-bridge/publish', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      row: { sku: parentSku, cost: firstRow._costKrw, weight: firstRow._weightG },
      scrapedAssets: { mainImage: firstRow._mainImage, extraImages: firstRow._extraImages, detailImages: [...] },
      variantsConfig,
      categoryId: group._joomCategory,  // 'music_albums_cd' 등
      enabled: true,
      namePrefix: '',  // 또는 [PRE ORDER]
      artist: group._artist,  // brand 자동 채움
      album: group._album,
      contents: '',
      brand: group._joomBrand || group._artist,  // 운영자 수정 가능
    }),
  });
  
  // 4. 응답 처리
  - resp.ok=true: joom_product_id 받음 + variants[].sku 확인 (운영자 sku 와 일치 검증) + DB UPDATE (products.joom_product_id, joom_status='active', joom_published_at=now())
  - resp.ok=false: joom_mapping_status='error', joom_mapping_error=resp.error
  - resp.infractions 있으면: toast 안내 (brand 위반 등) + DB log
}
```

### 3-4. 메인 이미지 정사각형 검증
mrPromoteJoom 호출 직전 메인 이미지 URL 다운로드 → natural width/height 비교 → 정사각형 (1:1 비율, ±2px 허용) 만 통과.

비정사각형이면 운영자에게 toast "Joom 은 정사각형 이미지만 허용. 메인 이미지를 정사각형 사진으로 바꾸세요" + 발행 차단. 운영자가 staronemall 원본이 정사각형이 아니면 다른 이미지 URL 입력.

---

## 4. joom-bridge 변경 (최소)

기존 joom-bridge 의 publish 흐름은 이미 충분. 다음 작은 변경만:

### 4-1. variant.sku 그대로 사용 검증 보강
- 현재 line 261: `cfg.sku || (vName.toUpperCase() === "DEFAULT" ? productSku : "")`
- → cfg.sku 빈값일 때 productSku fallback 인데 운영자 정책상 cfg.sku 가 반드시 운영자 마스터 sku 여야 함. 빈 cfg.sku 는 오류 raise.
- 변경: `if (!cfg.sku) throw new Error("variantsConfig[].sku required (Joom immutable policy)")`.

### 4-2. infraction 모니터링 강화 (P1, 옵션)
- 응답의 `infractions[]` 에 brand 위반 (예: code='unauthorized_brand') 있을 때 명시적으로 별도 필드로 분리.
- 현재는 그냥 일반 infractions 로 반환. UI 가 brand 위반 별도 toast 표시할 수 있게.

### 4-3. PUBLIC_JOOM_ACTIONS 검토
- 현재 health/categories/lookup-sku 만 public. publish/update-price/delete 는 인증 필수. OK.

---

## 5. 검증 시나리오 (운영자 burnable)

1. burnable URL (운영자 #784 의 izna POSTCARD URL 또는 별도 burnable Album).
2. 옵션 행 2개 (A ver. / B ver.) — 각자 다른 SKU (운영자 마스터 형식, 예: TEST-JOOM-A / TEST-JOOM-B), cost_krw, weight_g.
3. 카드 헤더: 카테고리 music_albums_cd, brand="Claude Burnable" (임의 — 운영자 승인 brand 아닐 가능성, infraction 트리거 검증 용).
4. 메인 이미지: 정사각형 staronemall 이미지 (운영자 burnable URL 의 자켓 정사각형 확인됨).
5. "Joom 발행" 클릭 → mrPromoteJoom() → joom-bridge /publish → /products/create.
6. 응답:
   - joom_product_id 받음 ✓
   - variants[].sku 가 우리 마스터 sku 와 정확히 일치 ✓
   - infractions 에 brand 관련 출력 (운영자 승인 brand 아니라면) — toast 표시
7. DB: products.joom_product_id, joom_variant_id, joom_status='active', joom_published_at, joom_currency='USD' 채움.
8. Joom 셀러센터 → burnable 상품 확인 → 정사각형 이미지 + 옵션 두 개 + 운영자 마스터 SKU + brand 적용 여부.

---

## 6. 구현 순서 (commit 분할)

| # | 작업 | 영향 파일 | 검증 |
|---|------|----------|------|
| 1 | joom-bridge variants[].sku 강제 검증 (4-1) | `supabase/functions/joom-bridge/index.ts` line 261 | unit: 빈 cfg.sku → 에러 raise |
| 2 | v2/index.html UI — 카드 헤더 Joom 영역 (카테고리 select + brand input + 발행 버튼) | `v2/index.html` view-register 카드 영역 | UI 렌더링 확인 + 카드별 _joomCategory / _joomBrand state |
| 3 | mrPromoteJoom 함수 + 메인 이미지 정사각형 검증 | `v2/index.html` | burnable 시도 → 정사각형이면 통과, 아니면 차단 |
| 4 | 응답 매핑 + DB UPDATE (products.joom_*) | `v2/index.html` mrPromoteJoom 후속 | 발행 후 products.joom_product_id 확인 |
| 5 | infraction toast 표시 | `v2/index.html` | brand 위반 시도 → toast 출력 |
| 6 | Codex 코드 리뷰 + 운영자 burnable 검증 + 배포 | — | end-to-end 통과 |

---

## 7. 검증 기준

- **SKU immutable 일치**: Joom 응답 variants[].sku == 운영자 마스터 products.sku (100% 일치).
- **정사각형 이미지**: Joom 셀러센터에 분홍 레이어 없는 원본 정사각형 이미지 (Shopee 와 다름).
- **옵션 묶음**: Joom 1 product + N variants (운영자 옵션 묶음 그대로).
- **가격 USD**: cost_krw → USD 계산 적용. 옵션별 cost 다르면 옵션별 USD 가격도 다름.
- **brand 처리**: artist 자동 채움. 승인 X 시 infraction 표시.
- **B 별도 발행**: Shopee 발행과 분리. 운영자가 별도 Joom 발행 버튼 클릭.

---

## 8. 리스크 & 미해결

1. **메인 이미지 정사각형 검증**: 운영자 burnable URL 의 자켓은 정사각형 확인됨. 그러나 향후 운영자가 비정사각형 staronemall 상품 등록 시도하면 사전 차단됨. fallback: 운영자가 직접 자른 정사각형 이미지 URL 별도 입력.
2. **Joom infraction 정책**: brand 위반 외에 어떤 infraction 코드가 있는지 불명. 운영 후 실 케이스 모니터링 + memory 갱신.
3. **A 자동 동시 발행 (#868 후속)**: 몇 번 운영 후 A 로 전환. plan 갱신 필요.
4. **product_joom_listings 테이블 미사용**: Shopee 의 product_shopee_listings (region × variant) 같은 정규화 테이블 없음. Joom 은 region 없어서 products.joom_* 컬럼으로 충분. 다중 listing (재발행) 추적 위해 product_joom_listings 신설 검토 (후속).
5. **변경 이력 추적**: shopee_mutation_log 에 joom action 도 기록할지. 현재 joom-bridge 의 log 메커니즘 별도 — 통합 검토.

---

## 9. Revision (Codex)

2026-05-22 `/codex:rescue` 적대적 리뷰. 판정: **REVISE**.

### [P0] v2/ UI 구현 시 반드시 반영

1. **Cross-card SKU duplicate guard**: §3.3 의 variantsConfig 빌더에 Shopee 의 CROSS_SKU_INACTIVE 같은 카드 간 SKU 충돌 검증 추가. Joom 도 동일 SKU 두 카드 동시 발행 시 immutable 위반.
2. **Partial publish recovery (lookup-sku 활용)**: §3.3 의 `resp.ok` 체크 외에 발행 도중 클라이언트 사망 또는 응답 미수신 시 lookup-sku 로 fall-through 조회. `joom-bridge /lookup-sku?sku=<sku>` 가 이미 구현됨. 발행 직후 lookup-sku 확인 + variants[].sku 100% 매칭 검증 + DB UPDATE 가 atomic block 안에서.
3. **Square main image UX**: §3.4 의 "운영자가 별도 URL 입력" 흐름을 구체화. 카드 헤더에 "정사각형 메인 이미지 URL (Joom 필수)" 필드 신설 + 입력값이 1:1 이미지 자동 검증 (실패 시 빨강 border + 발행 차단).

### [P1] 첫 commit 직후 보강

4. **CORS-safe 정사각형 검증**: 클라이언트 `<img>` cross-origin fail 위험. shopee-bridge `/proxy_image?url=<>` 우회 또는 image dimensions 만 Server-side 받는 endpoint 신설.
5. **Variant size 도메인 적합성**: Joom 의 Variant.Size max 25 char + UTF-8/latin. 한글 멤버명 ("셔누", "주헌") 정합성 확인. K-pop 멤버명은 영문 표기 (SHN/HYW 등) 사용 권장 (UI 가이드).
6. **가격 floor 검증**: Joom 의 카테고리별 최저가 미문서화. cost_krw 가 매우 낮은 옵션 (예: 1000 KRW = 0.85 USD) 일 때 Joom 거부 가능성. 발행 사전 검증에 최저가 1 USD 가드.
7. **Infraction code 처리 강화**: J1131/J1194 같은 코드 외에 permanent kind (immutable infraction) 발견 시 escalation path. permanent 발견 시 카드 status='blocked' + 운영자 명시 통보.

### [P2] 후속 작업

8. **Immutability matrix**: SKU 외 다른 immutable 필드 (예: category, brand) 운영 가이드 정리. /products/update 의 허용 필드 docs cross-check.
9. **shopee_mutation_log 통합 또는 joom_mutation_log 별도**: §5 의 audit_log 통합 디자인. 운영 변경 이력 추적.
10. **Burnable test 비결정성**: brand="Claude Burnable" 이 J1131 warning 트리거인지 우연인지 불명. 운영자 실 burnable 로 재검증 필요.

### Codex point-by-point

| # | 항목 | Risk | 본 plan 반영 위치 |
|---|------|------|-------------------|
| 1 | Cross-card SKU duplicate | HIGH | §3.3 UI 빌더 |
| 2 | Partial publish recovery (lookup-sku) | HIGH | §3.3 응답 처리 |
| 3 | Square main image UX | HIGH | §3.4 |
| 4 | CORS-safe image dim 검증 | MEDIUM | §3.4 (proxy_image 활용) |
| 5 | Variant size domain | MEDIUM | §0-4 (영문 코드 권장) |
| 6 | Price floor | MEDIUM | 사전 검증에 최저가 가드 |
| 7 | Infraction permanent escalation | MEDIUM | §3.3 응답 처리 |
| 8 | Immutability matrix | LOW | follow-up |
| 9 | Mutation log 통합 | LOW | follow-up |
| 10 | Burnable test 비결정성 | LOW | 운영자 실 burnable 재검증 |

### 실제 직접 검증 결과 (2026-05-22 burnable A/B 발행 성공)

Codex 리뷰와 별개로 plan §5 시나리오 실행해서 Joom 발행 자체는 성공:
- joom_product_id `6a10793fa4ce270191cf6759` (state=pending, Joom 모더이션 대기)
- variants[].sku 가 운영자 마스터 sku 와 100% 일치 (TEST-JOOM-A-20260522, TEST-JOOM-B-20260522)
- per-option 다른 USD 가격 (A 11.94, B 15.35, cost_krw 14000/18000 환산)
- brand "Claude Burnable" 적용 (brand_assigned=true)
- category music_albums_cd 자동 매핑 (Joom internal ID 1736947929385297579-20-2-9814-1701080485)
- 메인 이미지 정사각형 600×600 (Joom 모더이션 pending)
- infractions: J1194 (pending review, 정상), J1131 (warning, 코드 의미 docs 확인 후속)

**결론**: Backend flow 검증 통과. Codex P0/P1 권고는 v2/ UI 작업 시 적용. 본 plan 의 핵심 가설 (joom-bridge 의 cfg.sku 그대로 활용 + processDetailImage portrait 분할) 모두 확인.
