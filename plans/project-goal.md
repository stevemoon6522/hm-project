# [SD] Project Goal

## 1. Goal

`shopee-dashboard`의 목표는 K-POP 앨범과 굿즈 상품의 원천 데이터를 빠르고 정확하게 수집하고, 정규화하고, 장기적으로 신뢰 가능한 master data로 보존하는 것이다. 이 master data는 Shopee 하나를 위한 입력 폼이 아니라 Joom, Qoo10, eBay, Alibaba까지 같은 기준으로 상품 등록, 가격 수정, 판매 상태 운영을 반복 실행하기 위한 중심 데이터가 된다.

성공 기준은 플랫폼별 화면이나 API에 같은 정보를 다시 입력하는 시간을 줄이는 데서 끝나지 않는다. 새 상품을 한 번 master data로 정비하면 플랫폼별 payload preview, validation, dry-run diff, batch 실행, 실패 재처리, rollback 대상 확인까지 이어져야 한다. 따라서 전략의 출발점은 항상 master-data-first이며, 특정 플랫폼을 먼저 완성한 뒤 나머지를 끼워 맞추는 Shopee-first 구조로 가지 않는다.

K-POP 상품 운영에서는 신보 속도와 정보 정확도가 동시에 중요하다. 빠르게 등록하더라도 가격, 발매일, 버전, 특전, 필수 이미지, 무게/크기 같은 핵심 정보가 틀리면 손실과 클레임으로 이어진다. 이 프로젝트는 빠른 수집과 배포를 지원하되, 잘못된 가격이나 필수 정보 누락을 막는 validation, approval gate, guardrail을 반드시 통과하게 만든다.

가격은 특히 민감한 운영 영역으로 본다. 매입가, 환율, 플랫폼 수수료, 배송/포장비, rounding, minimum margin이 바뀌면 계산 결과와 근거를 `PriceSnapshot`에 남기고, 실제 플랫폼 반영은 batch 단위로 추적한다. 가격 변경은 되돌릴 수 있어야 하며, rollback은 계산식을 다시 돌리는 방식이 아니라 last known good platform price를 복원하는 방식으로 설계한다.

반복 입력값은 fixed preset으로 관리한다. 앨범 카테고리 기본값, `condition = NEW`, 설명 템플릿, 이미지 정렬 규칙, 배송/profile 기본값처럼 반복되는 운영 결정을 preset으로 고정하고, 플랫폼별 예외는 adapter layer에서만 처리한다. core master schema는 플랫폼별 사정을 직접 알지 않는 구조를 유지한다.

## 2. Non-Goals

이 프로젝트는 `kpop-wms`의 주문, 재고 차감, 출고, 정산 기능을 대체하지 않는다. `shopee-dashboard`는 상품 원천 데이터, 가격, listing payload, 플랫폼 sync 실행을 다루는 도구이고, 주문 처리와 재고 차감의 source of truth는 계속 `kpop-wms` 쪽에 둔다.

광고 운영, CS 답변, 리뷰 관리, 플랫폼 정산 자동화는 현 단계의 목표가 아니다. 이 기능들은 나중에 운영 효율을 높일 수 있지만, master data와 adapter 기반 listing 실행 구조가 안정화되기 전에는 범위를 넓히지 않는다.

검수 없는 완전 자동 등록도 목표가 아니다. 신보, 예약판매, 가격 변동이 큰 상품, source confidence가 낮은 상품은 review queue와 approval gate를 거쳐야 한다. 자동화는 운영자의 판단을 생략하는 방식이 아니라, 판단이 필요한 지점을 더 빨리 드러내는 방식으로 설계한다.

특정 플랫폼 API 제약을 master data schema에 직접 섞지 않는다. Shopee, Joom, Qoo10, eBay, Alibaba가 요구하는 필드, 카테고리, 이미지 규칙, 가격 제한은 adapter mapping과 platform capability matrix에서 처리한다. master data는 상품의 canonical 사실을 담고, 플랫폼별 표현은 adapter가 책임진다.

모든 국가와 모든 상점을 동시에 지원하려고 하지 않는다. 운영 가능한 채널을 feature flag로 좁혀 안정화하고, banned/paused/delisted 채널에는 자동 sync나 가격 업데이트를 보내지 않는다. 특히 Shopee BR의 banned shop처럼 상태가 명확한 채널은 sync 경로에서 제외한다.

## 3. Phased Roadmap

### Phase 0 - Master Data Foundation

Phase 0의 목표는 Shopee 기능을 더 붙이기 전에 원천 데이터, 상품 식별자, 변경 이력의 기준을 고정하는 것이다. 이 단계에서는 canonical product, variant/SKU, platform listing, price snapshot, source record, preset, audit log의 역할을 명확히 나누고, 내부 immutable key와 외부 source/platform key의 매핑 규칙을 정한다.

구현 산출물은 required field matrix에서 master 공통 필드와 플랫폼별 필수 필드를 분리하는 것, raw source를 수집 원문과 수집 시각, hash, confidence score와 함께 보존하는 것, actor와 before/after, reason, batch_id, rollback target을 남기는 audit log를 갖추는 것이다. validation은 중복 SKU, 필수 이미지, 가격과 통화, 무게/크기, 발매일, 카테고리, variant 구조를 확인할 수 있어야 한다.

이 단계의 종료 기준은 새 상품 1개를 master data로 만들고, 최소 2개 플랫폼에 대한 payload preview를 생성할 수 있는 상태다. 또한 가격 변경 전후의 snapshot과 rollback 대상이 DB에서 확인되어야 한다.

### Phase 1 - Multi-Platform Listing MVP

Phase 1의 목표는 master data 기반의 공통 등록/가격수정 실행 엔진을 완성하는 것이다. 구현 순서는 특정 플랫폼 화면을 먼저 맞추는 방식이 아니라 `validate`, `transform`, `createListing`, `updatePrice`, `updateStatus`, `fetchRemote`, `reconcile`로 이어지는 adapter contract를 먼저 고정하는 방식이어야 한다.

이 단계에서는 플랫폼별 category, condition, description template, image rule preset을 만들고, 국가/상점/플랫폼별 price rule을 적용한다. price rule에는 수수료, 배송/포장비, 환율, rounding, minimum margin이 포함된다. master data와 remote listing의 차이는 dry-run diff로 보여주고, batch 실행 로그에는 success/fail, request_id, platform_item_id, retry state를 남긴다. rate limit, token expiry, API error는 원인별로 분류하고 재시도 정책을 붙인다.

종료 기준은 같은 master product를 최소 2개 플랫폼에서 listing 또는 price update dry-run으로 검증한 뒤 실제 실행할 수 있는 것이다. 실패한 listing update는 원인별로 재처리하거나 보류 처리할 수 있어야 한다.

### Phase 2 - Ingestion And Pricing Automation

Phase 2의 목표는 신보와 가격 변동을 빠르게 감지하되, 위험한 자동 반영은 guardrail로 막는 것이다. source ingestion pipeline은 raw ingest, normalize, validate, review queue, publish to master, enqueue sync 순서로 흐른다. 자동화는 source confidence와 validation 결과를 기준으로 auto update, approval required, blocked 상태를 나눠야 한다.

source reliability는 Tier 1 공식/공급처/운영자 확인 원천, Tier 2 marketplace 참고/보조 source, Tier 3 manual override로 나눈다. Tier 1은 자동 반영 후보가 될 수 있지만, Tier 2는 cross-check나 review가 필요하고, Tier 3는 reason과 만료일을 필수로 기록해야 한다.

freshness SLA는 운영 속도를 위한 기준으로 둔다. 신보와 예약 판매 후보는 4시간 이내 source refresh 또는 수동 확인이 필요하고, critical item의 가격 변동은 1시간 이내 alert를 목표로 한다. 일반 catalog는 하루 1회 health check를 기본으로 한다.

pricing engine은 cost delta threshold, margin floor, channel fee, FX, rounding, approval rule을 기준으로 batch를 만든다. Telegram `[sd]` alert는 source stale, negative margin, API auth failure, sync failure spike, price anomaly를 알려야 한다. 가격 batch는 `batch_id` 기준으로 last known good price로 되돌릴 수 있어야 한다.

이 단계의 종료 기준은 cost 변경이 자동 감지되고 threshold에 따라 auto update, approval required, blocked로 분기되는 것이다. 또한 이미 실행된 가격 update batch를 이전 snapshot 기준으로 rollback할 수 있어야 한다.

### Phase 3 - Platform Scale-Out

Phase 3의 목표는 검증된 master data와 adapter contract를 기준으로 플랫폼 커버리지를 단계적으로 확장하는 것이다. 확장 순서는 데이터 완성도, API 안정성, 운영 임팩트를 점수화해 주간 단위로 결정하고, 각 플랫폼은 feature flag와 dry-run/reconcile을 갖춘 뒤 켠다.

Joom adapter는 listing payload mapping과 logistics, combined-shipping 관련 필드를 adapter 설정으로 분리한다. Qoo10 adapter는 KSE API 승인 이후 category/item field mapping과 price update MVP부터 시작한다. eBay adapter는 title length, item specifics, condition, category mapping을 별도 matrix로 관리한다. Alibaba adapter는 B2B bulk-buy, MOQ, tiered price, campaign/group-order data와 일반 listing 모델의 경계를 먼저 문서화한 뒤 범위를 넓힌다.

종료 기준은 Shopee 외 최소 1개 플랫폼에서 같은 master product를 platform-specific listing으로 변환할 수 있는 것이다. 신규 플랫폼을 붙일 때 core schema를 바꾸지 않고 adapter mapping만 추가하면 되는 상태가 되어야 한다.

## 4. Master Data Model Requirements

master data model은 상품의 canonical 사실과 플랫폼별 실행 상태를 분리해야 한다. `Product`는 artist/group, title, category, release_date, status, default locale fields를 가진 canonical product다. `Variant/SKU`는 version, option, barcode/UPC, internal_sku, supplier_sku, weight, dimensions, components, cost를 관리하며, K-POP 앨범의 버전, 세트, 랜덤 구성, 특전 구성이 자주 바뀌기 때문에 `Product`와 분리한다.

`SourceRecord`는 source_type, source_url 또는 file_id, fetched_at, raw_payload_hash, observed values, confidence, parser_version을 남긴다. `PriceSnapshot`은 cost, currency, FX, fee model, margin, computed platform price, manual override, effective_at을 기록한다. `PlatformListing`은 platform, shop/country, platform_item_id, listing_status, payload_version, last_sync_at, last_remote_check_at을 가진다. `Preset`은 category default, `condition = NEW`, description template, image ordering rule, shipping/profile defaults를 고정한다. `AuditLog`는 entity_type, entity_id, actor, action, before_json, after_json, reason, batch_id를 남긴다. DB 저장/이력 관리와 가격 snapshot의 최소 실행 설계는 `plans/db-storage-history-and-price-snapshot-plan.md`를 기준으로 한다.

내부 key는 immutable로 둔다. title, barcode, source URL은 운영 중 바뀔 수 있으므로 primary key로 쓰지 않는다. 외부 key는 `(platform, shop_id, platform_item_id)`와 `(source_type, source_external_id)`처럼 composite unique로 관리한다. 모든 가격과 listing 변경은 append-only snapshot과 audit log로 남겨야 하며, 변경 후 현재값만 보존하는 방식은 허용하지 않는다.

platform-specific field는 adapter mapping table에 둔다. Shopee 전용 필드가 필요하다는 이유로 master schema를 Shopee 중심으로 늘리지 않는다. 이 원칙이 Joom, Qoo10, eBay, Alibaba 확장 비용을 낮추는 핵심 제약이다.

## 5. Ingestion Pipeline Requirements

ingestion pipeline은 원천 보존을 첫 단계로 둔다. raw ingest에서는 HTML, JSON, CSV, 수동 입력을 가능한 한 원문 그대로 저장한다. normalize 단계에서는 title, artist, release_date, option/version, cost, currency, image URL, weight를 canonical format으로 변환한다. validate 단계에서는 필수 필드, 가격 범위, 통화, 중복 후보, 이미지 접근성, 날짜 형식, variant 구조를 검사한다.

validation을 통과하지 못했거나 confidence가 낮은 데이터는 review queue로 보낸다. source 간 충돌, 가격 급변, 필수 필드 누락, 발매일 변경처럼 운영 판단이 필요한 경우도 자동 publish하지 않는다. 승인된 변경만 master data와 price snapshot에 반영하고, 그 다음 adapter별 dry-run diff를 생성해 실행 batch에 넣는다.

source reliability는 운영 판단의 기준이 된다. Tier 1은 공식/공급처/운영자가 확인한 원천으로 자동 반영 후보가 될 수 있다. Tier 2는 marketplace 참고나 보조 source로 cross-check 또는 review가 필요하다. Tier 3 manual override는 reason과 만료일을 반드시 기록하고, 만료 후 미정리 상태가 남지 않도록 alert 대상에 포함한다.

특히 조심해야 할 blind spot은 같은 앨범의 일반판, 특전판, 세트판을 같은 SKU로 합치는 오류다. 통화 단위, 부가세나 배송비 포함 여부, 이미지 hotlink 만료, 플랫폼별 이미지 규격, 발매일 변경, 예약판매 종료, 품절/재입고 상태도 자주 문제가 된다. 한글/영문/현지어 title 불일치와 mojibake는 상품명과 설명 품질을 크게 떨어뜨리므로 UTF-8 저장, locale별 field, preview validation으로 잡아야 한다.

## 6. Pricing Engine Rules

pricing engine은 매입가, 환율, 플랫폼 수수료, 배송비, 프로모션 정책, manual override, margin floor, platform min/max price rule의 변경을 trigger로 삼는다. trigger가 발생하면 새 계산 결과를 snapshot으로 남기고, 실제 플랫폼 반영 여부는 threshold policy와 guardrail이 결정한다.

초기 threshold policy는 config로 관리하며 다음 네 가지 상태를 기본값으로 둔다.

- `ignore/log`: cost delta가 `max(1%, KRW 100)` 미만이면 snapshot만 남기고 자동 반영하지 않는다.
- `auto-update`: cost delta가 1-5%이고 margin floor를 지키면 platform price update batch를 생성한다.
- `approval-required`: cost delta가 5-15%이거나 margin이 threshold 근처이거나 source confidence가 낮으면 운영자 승인을 요구한다.
- `blocked`: cost delta가 15%를 초과하거나 판매가가 원가 이하이거나 음수 margin, 비정상 FX, 플랫폼 min/max 위반이 있으면 실행을 막는다.

guardrail은 국가/상점별 minimum margin, maximum daily price move, rounding rule을 포함한다. sold-out, delisted, banned, paused channel에는 자동 가격 업데이트를 보내지 않는다. manual override가 있는 SKU는 override 만료 전까지 자동 계산값으로 덮어쓰지 않는다. 가격 batch는 실행 전에 dry-run diff, 예상 margin, 변경 사유를 보여줘야 한다.

rollback은 가격 운영의 필수 기능이다. 모든 price update는 `batch_id`와 이전 `PriceSnapshot`을 가져야 한다. rollback은 이전 계산식을 재실행하는 것이 아니라 last known good platform price를 복원하는 방식으로 처리한다. rollback 이후에도 audit log에 rollback actor, reason, restored_snapshot_id를 남긴다.

## 7. Platform Adapter Strategy

adapter strategy는 platform-agnostic execution을 지키기 위한 핵심 구조다. core master data는 플랫폼을 모르고, adapter가 플랫폼별 필수 필드, 카테고리, 이미지 규칙, 가격 제한, API 예외를 책임진다. 공통 contract는 `validate(masterProduct, platformContext)`, `transform(masterProduct, platformContext)`, `createListing(payload)`, `updatePrice(platformListing, priceSnapshot)`, `updateStatus(platformListing, status)`, `fetchRemote(platformListing)`, `reconcile(masterProduct, remoteListing)`로 둔다.

각 adapter는 dry-run, idempotency key, retry/backoff, rate limit, error taxonomy를 반드시 가져야 한다. 같은 요청이 중복 실행되어도 listing이나 가격이 꼬이지 않아야 하며, 실패는 token expiry, validation failure, rate limit, remote business rule violation처럼 재처리 가능성이 다른 원인으로 분류되어야 한다.

플랫폼 확장은 준비도 기준으로 진행한다. 매주 데이터 완성도, API 안정성, 운영 임팩트를 점수화해 타깃 플랫폼을 정한다. Joom은 물류와 combined-shipping 필드를 adapter 설정으로 분리하고, Qoo10은 KSE API 승인 이후 category/item field mapping부터 MVP로 시작한다. eBay는 item specifics, title length, condition, category mapping을 matrix로 관리하고, Alibaba는 B2B bulk-buy, MOQ, tiered price, group-order 경계를 먼저 정의한다.

remote listing과 local master data의 drift는 주기적으로 reconcile한다. drift가 반복되는 플랫폼이나 필드는 adapter mapping, preset, 또는 source reliability 중 어느 쪽이 문제인지 확인해 backlog나 hotfix로 연결한다.

## 8. Ops Metrics, KPIs, Alerting

운영 KPI는 데이터 신선도, 데이터 품질, 가격 반영 속도, 플랫폼 sync 안정성을 함께 봐야 한다. source freshness age는 신보와 critical source의 마지막 성공 refresh 시간을 보여준다. ingestion success rate와 validation failure rate는 수집 파이프라인의 품질을 나타내고, master data completeness는 플랫폼별 필수 필드 충족률을 보여준다.

review queue age는 승인 대기 상품과 가격 변경이 얼마나 오래 멈춰 있는지 확인하는 지표다. price update latency는 cost change 감지부터 플랫폼 반영까지 걸린 시간을 측정한다. listing sync success rate, retry exhaustion count, platform drift count는 adapter와 remote 상태의 안정성을 보여준다. margin leakage는 계산상 margin floor 미만인데 판매 중인 listing 수를 잡아내고, rollback count와 rollback reason은 가격 운영 위험이 반복되는 지점을 보여준다.

alert는 운영자가 바로 행동해야 하는 상황에 집중한다. source refresh SLA 초과, negative margin, cost보다 낮은 computed price, Shopee/Joom/Qoo10/eBay/Alibaba API auth failure, batch 내 sync failure spike, 같은 SKU의 중복 listing 후보, 반복 drift, manual override 만료 예정 또는 만료 후 미정리는 Telegram `[sd]` 알림으로 보낸다.

weekly report는 KPI trend, 실패 batch, 위험 가격 변경, adapter별 health를 요약한다. 보고서는 단순 현황 공유가 아니라 다음 주 backlog, hotfix, preset/mapping 수정, adapter 우선순위 결정을 위한 입력이어야 한다.

## 9. Risk Register And Mitigations

가장 큰 위험은 원천 가격이나 상품 정보가 틀린 상태로 master data에 들어가는 것이다. 이를 줄이기 위해 raw source를 보존하고, confidence score와 source tier를 기록하며, 충돌이나 급변은 review queue로 보낸다. source가 나중에 바뀌더라도 어떤 원문을 기준으로 가격과 listing을 만들었는지 추적 가능해야 한다.

K-POP variant 혼동은 중복 SKU, 누락 SKU, 고객 클레임으로 이어진다. Product와 Variant/SKU를 분리하고, 세트/특전/랜덤 구성 필드를 명시하며, 중복 후보 탐지를 validation에 넣는다. 일반판과 특전판을 title 유사도만으로 같은 SKU로 합치지 않도록 source와 option 구조를 함께 확인한다.

과도한 자동 가격 반영은 margin 손실과 플랫폼 제재로 이어질 수 있다. threshold policy, approval gate, margin floor, maximum daily price move, rollback workflow를 통해 자동 실행 범위를 제한한다. 가격 batch는 dry-run diff와 예상 margin을 먼저 보여주고, blocked 상태는 운영자가 사유를 확인하기 전까지 실행하지 않는다.

플랫폼 API 제한이나 변경은 sync 실패와 운영 중단을 만들 수 있다. adapter contract, feature flag, retry/backoff, error taxonomy를 통해 플랫폼별 장애가 core schema나 다른 플랫폼 sync로 번지지 않게 한다. token과 권한 만료는 auth health check, 만료 alert, secret rotation 절차로 관리한다.

데이터 모델이 Shopee에 종속되는 것은 장기 확장 비용을 키우는 구조적 위험이다. master schema와 adapter mapping을 분리하고, Shopee 전용 필드는 adapter 쪽에만 둔다. Joom, Qoo10, eBay, Alibaba에서 같은 master product를 변환할 수 있는지를 설계 검증 기준으로 삼는다.

mojibake와 localization 오류는 상품명과 설명 품질을 떨어뜨리고 등록 실패를 만들 수 있다. 모든 문서는 UTF-8로 저장하고, locale별 field를 분리하며, payload preview에서 한글/영문/현지어 title과 description을 확인한다. 이미지 URL 만료와 규격 불일치는 image fetch check, platform별 image rule, source tracking으로 줄인다.

Qoo10 API 승인 지연은 Phase 3 일정에 영향을 줄 수 있다. 승인 전에는 adapter 설계와 mapping 초안만 선행하고 feature flag는 off로 둔다. Alibaba는 B2B bulk-buy, MOQ, tiered price, group-order 흐름이 일반 listing 모델과 충돌할 수 있으므로 경계를 문서화한 뒤 점진적으로 붙인다.

## 10. Weekly Execution

매주 운영은 source health, master data hygiene, pricing review, platform sync review를 기본 루틴으로 둔다. source health에서는 신보와 critical source freshness, 실패 원인, 수동 확인 필요 여부를 본다. master data hygiene에서는 필수 필드 누락, 중복 SKU 후보, 깨진 이미지, locale별 title 불일치를 정리한다.

pricing review에서는 cost delta, margin floor 위반, manual override 만료, blocked price batch를 확인한다. platform sync review에서는 실패 batch, retry exhaustion, remote drift, auth failure를 처리한다. Preset과 mapping은 category, description template, condition, shipping/profile default가 현재 운영 방식과 맞는지 매주 확인한다.

Telegram `[sd]` alert 중 반복 발생하는 항목은 backlog 또는 hotfix로 분류한다. 최근 price batch 1개를 기준으로 rollback drill을 수행해 실제 복원 가능 여부를 점검한다. roadmap review에서는 Phase exit criteria 충족 여부를 확인하고 다음 주 deliverables를 확정한다.

책임 기준은 명확히 나눈다. Product/Ops는 source 신뢰도 판단, review queue 승인, preset 정책 결정을 맡는다. Engineering은 schema, adapter, pricing engine, validation, alerting 구현을 책임진다. Weekly owner는 그 주의 실패 batch와 blocked item을 닫는 단일 책임자로 지정한다.

---

Last updated: 2026-05-15
