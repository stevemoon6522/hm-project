# Qoo10 예약발송 DateTime 오류 대응

## 요약

2026-06-22에 `[PRE ORDER] BOYNEXTDOOR 1st Studio Album [HOME] (POCKET HOME ver.)` 상품을 Qoo10에 등록할 때 아래 오류가 발생했다.

```text
String was not recognized as a valid DateTime.
```

문제 필드는 Qoo10 `ItemsBasic.SetNewGoods`에 전달되는 예약발송 출시일(`AvailableDateValue`)이었다.

## 원인

로컬 공식 API 문서의 예약발송 예시는 `2025/09/26`처럼 슬래시 날짜를 보여준다.

참고 문서:

- `C:/dev/api-refs/marketplaces/qoo10/api-pages/상품-등록/10009-SetNewGoods.md`
- `C:/dev/api-refs/marketplaces/qoo10/api-pages/상품-수정/10010-UpdateGoods.md`

하지만 Qoo10 실서버는 `AvailableDateType=2`에서 슬래시 형식(`YYYY/MM/DD`)의 `AvailableDateValue`를 DateTime 파싱 오류로 거부했다. 같은 요청을 대시 형식(`YYYY-MM-DD`)으로 보내면 정상 등록됐다.

## 수정 내용

Qoo10 예약발송 출시일은 publish 경로 전체에서 `YYYY-MM-DD` 형식을 유지한다.

수정 파일:

- `supabase/functions/qoo10-bridge/index.ts`
- `supabase/functions/platform-publish/_shared/fulfillment.ts`
- `tests/qoo10-mapping-regression.test.mjs`

커밋:

- `13f5005 Send Qoo10 release dates as dash format`

배포한 Supabase Edge Functions:

- `qoo10-bridge`
- `platform-publish`

## 실등록 검증 결과

상품:

- `[PRE ORDER] BOYNEXTDOOR 1st Studio Album [HOME] (POCKET HOME ver.)`

Qoo10 등록 결과:

- `goods_no` / `itemCode`: `1209638166`
- `AvailableDateType`: `2`
- `AvailableDateValue`: `2026-07-10`
- `listing_status`: `listed`
- `mapping_status`: `mapped`

등록 옵션 SKU:

- `PO-BOYNEXTD-HOME-POCKETHOME-SUNGHO`
- `PO-BOYNEXTD-HOME-POCKETHOME-LEEHAN`
- `PO-BOYNEXTD-HOME-POCKETHOME-JAEHYUN`
- `PO-BOYNEXTD-HOME-POCKETHOME-RIWOO`
- `PO-BOYNEXTD-HOME-POCKETHOME-WOONHAK`
- `PO-BOYNEXTD-HOME-POCKETHOME-TAESAN`

6개 옵션 SKU 모두 `qoo10-bridge/lookup-sku`로 item `1209638166`에 대해 역조회 성공했다. 매칭 타입은 `option_item_type_code`였다.

## 이미지 배치 규칙

Qoo10 등록 UI와 payload는 아래 규칙을 따른다.

- 마스터 상품 대표 이미지는 `1. Representative image`로 보내며 Qoo10 `StandardImage`에 업로드한다.
- 상세 이미지는 `2. Detail images`로 보내며 Qoo10 상품 설명 템플릿 하단의 `ItemDescription`에 append한다.

이번 상품 검증 결과:

- 대표 이미지가 publish payload의 `main_image`에 존재했다.
- 상세 이미지 1장이 Qoo10 description HTML 하단에 포함됐다.

## 테스트

통과한 테스트:

```powershell
node tests/qoo10-mapping-regression.test.mjs
node scripts/test-platform-fulfillment-rules.mjs
node scripts/test-platform-publish-group-registration.mjs
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-qoo10-option-price-guard.mjs
node scripts/test-v2-marketplace-layered-image.mjs
```

배포 후 smoke:

- dry-run payload에 `available_date_value: "2026-07-10"` 포함 확인.
- dry-run payload에 `2026/07/10` 미포함 확인.
- 배포 후 Qoo10 item `1209638166`에서 옵션 SKU 조회 성공 확인.

## 운영 규칙

Qoo10 예약발송 상품은 항상 아래 형태로 전송한다.

```text
AvailableDateType=2
AvailableDateValue=YYYY-MM-DD
```

로컬 공식 API 문서 예시에 슬래시 날짜가 있어도 예약발송 출시일을 `YYYY/MM/DD`로 변환하지 않는다.
