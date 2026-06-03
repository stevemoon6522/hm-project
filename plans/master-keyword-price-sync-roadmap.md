# Master Keyword Price Sync Roadmap

> 작성일: 2026-05-31
> 현재 우선순위: 단기 목표(Shopee 상품을 마스터 상품으로 불러온 뒤 가격 동기화)를 먼저 완료한다.

## 최종 목표

검색창에서 `BTS`, `CORTIS` 같은 특정 아티스트/키워드를 검색하면, 검색 결과에 해당하는 **마스터 상품**을 기준으로 연동된 각 플랫폼의 상품 가격을 가격 동기화 탭에서 일괄 변경할 수 있게 한다.

운영자가 원하는 최종 흐름은 다음과 같다.

1. 가격 동기화 탭에서 아티스트/키워드 검색
   - 예: `BTS`, `CORTIS`, 특정 앨범명, SKU, 옵션명
2. 검색 결과에서 10~20건 단위로 대상 상품 선택
3. 선택 상품의 cost/무게 확인 또는 수정
4. 마스터 상품에 연결된 플랫폼 listing을 확인
   - Shopee
   - Joom
   - Qoo10
   - eBay
   - Alibaba 등 향후 확장 대상
5. 플랫폼별 가격 계산식과 활성 지역/상점 범위에 맞춰 가격 동기화 실행
6. 실행 결과, 실패 사유, 마지막 동기화 가격/시각을 마스터 상품과 platform listing에 기록

## 단기 목표: Shopee 우선 가격 동기화

현재 단기 목표는 Shopee 상품을 먼저 마스터 상품으로 불러오고, 이 상품들의 가격을 안정적으로 동기화하는 것이다.

### 단기 목표 성공 기준

- Shopee/KRSC/Global Product에서 가져온 상품이 `products` 마스터 상품 행으로 존재한다.
- 해당 마스터 상품은 Shopee global item/model 식별자를 보존한다.
  - `shopee_item_id` 또는 global item id
  - `global_model_id`
  - `shopee_global_model_sku`
- 가격 동기화 탭에서 아티스트/상품명/SKU/옵션명 검색이 가능하다.
  - 예: `BTS`, `CORTIS`, `GREENGREEN`
- 검색 결과에서 특정 상품만 선택할 수 있다.
- 선택된 행의 inline cost, 도매가 기반 cost, weight 입력값이 동기화 버튼 클릭 시 즉시 반영된다.
- 선택된 지역 chip만 대상으로 Shopee `update_price` payload를 만든다.
- Global/KRSC 기반 상품처럼 region별 `shop_item_id`/`shop_model_id`가 비어 있어도, 동기화 직전에 `published_list`와 `shop_model_list`로 shop mapping을 보강한 뒤 payload를 만든다.
- 매핑/cost/무게가 실제로 유효한데도 `Shopee 실호출 대상이 없습니다. 매핑된 행을 선택하고 cost를 확인하세요.` 오류가 뜨지 않는다.

## 단기 목표 이후: SKU 동기화와 플랫폼 공백 메우기

Shopee 가격 동기화가 안정화된 뒤에는 마스터 상품의 SKU를 기준으로 각 플랫폼의 등록 공백을 메운다.

### 목표 흐름

1. 마스터 상품의 SKU/옵션 SKU를 기준으로 플랫폼별 기존 listing을 조회한다.
2. 이미 등록된 상품은 새로 등록하지 않고 mapping만 흡수한다.
3. 등록되지 않은 플랫폼만 publish/register 후보로 표시한다.
4. 운영자가 확인한 뒤 해당 플랫폼 adapter로 상품 등록을 실행한다.
5. 등록 성공 시 platform listing mapping과 실행 로그를 저장한다.

### 주요 원칙

- SKU가 canonical identity인 상품은 임의 suffix나 fallback SKU를 만들지 않는다.
- local mapping 누락은 remote listing 누락과 다르다. 먼저 플랫폼별 SKU lookup/coverage pass를 실행한다.
- 이미 존재하는 remote listing은 absorb/mapping 처리하고, 진짜 없는 경우만 등록 후보로 둔다.
- Shopee에서 시작한 마스터 상품이라도 구조는 master-data-first로 유지한다.
- 플랫폼별 API 제약은 adapter layer에 두고, core master product schema는 특정 플랫폼에 종속시키지 않는다.

## 향후 구현 체크리스트

### 1. 검색/선택 기반 가격 동기화 확장

- [ ] 검색어가 상품명, SKU, 옵션명, 플랫폼 SKU, 아티스트 필드를 모두 커버하는지 확인
- [ ] 선택 상태가 검색/정렬/그룹 접힘 상태에서도 product id 기준으로 유지되는지 확인
- [ ] 10~20건 batch에서 active platform과 active region/shop 범위만 payload에 포함되는지 확인
- [ ] platform tab별로 Shopee/Joom/Qoo10/eBay/Alibaba 컬럼과 실행 버튼이 섞이지 않는지 확인

### 2. 마스터 상품 ↔ 플랫폼 listing coverage

- [ ] Shopee Global → published shop listing hydration 안정화
- [ ] Joom SKU lookup/absorbed mapping 검증
- [ ] Qoo10 상품/옵션 seller code lookup 검증
- [ ] eBay inventory SKU lookup과 published listing 검증 분리
- [ ] Alibaba listing model 범위 정의

### 3. 등록 공백 메우기

- [ ] SKU coverage 결과에서 missing/unsupported/auth-blocked 상태를 명확히 분리
- [ ] missing platform만 등록 후보로 표시
- [ ] 등록 전 payload preview와 validation gate 제공
- [ ] 등록 후 platform listing mapping upsert
- [ ] 실패 원인별 retry/blocked 상태 저장

### 4. 운영 안전장치

- [ ] 가격 변경 batch 로그와 이전 가격 snapshot 저장
- [ ] 부분 실패 시 실패 row만 retry 가능하게 표시
- [ ] banned/paused/delisted 채널은 자동 동기화 제외
- [ ] large cost change는 guardrail 또는 명시 확인 필요
- [ ] live sync 전후 결과를 UI에서 확인 가능하게 유지

## 현재 작업 메모

이번 작업에서는 단기 목표를 우선한다. 즉, Shopee 상품을 가격 동기화 탭에서 검색/선택하고 cost/무게를 입력한 뒤 바로 Shopee 가격 동기화를 실행할 수 있는 상태를 검증/보강한다. 장기 목표와 SKU 기반 플랫폼 공백 메우기는 이 문서에 보관하고, 단기 목표 이후 순차적으로 진행한다.
