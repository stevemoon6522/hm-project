# SD Recurring Incident KPI

First two-week KPI: reduce recurrence of the same SD marketplace failure class.

## Definition

반복 장애 means an already analyzed or patched failure class appears again in the same platform and registration, sync, mapping, image, pricing, deployment, or cleanup flow.

Count each work session as one primary KPI unit. Also record the product, platform, and region so repeated failures around a specific listing can be separated from general process failures.

## 일일 리포트

- Date:
- 신규 장애 수:
- 반복 장애 의심 수:
- 같은 원인 확정 수:
- 원인 미확정 수:
- 배포/라이브 smoke 완료 수:
- 후속 검증 대기 수:
- New recurrence memo links:

## 주간 리포트

- Week:
- 반복 장애 Top 3:
- 새로 추가한 regression/smoke test:
- 새로 만든 Wiki/runbook:
- 다음 주에 제거할 가장 큰 반복 원인:
- API doc gaps found:
- Live-write incidents requiring follow-up:

## Confirmation Rules

- Mark 같은 원인 확정 only when the symptom signature and root cause match a prior memo or patch.
- Mark 반복 장애 의심 when the platform and flow match but root cause has not been confirmed.
- Do not count a new marketplace behavior or new product edge case as recurring until it maps to a known failure class.

## Initial Failure Classes

- Shopee publish region failure recurrence.
- SKU, variant, or model mapping recurrence.
- Partial price sync recurrence.
- Representative, option, or detail image recurrence.
- Joom brand, category, or detail image registration recurrence.
- Vercel deploy or `/v2/` routing recurrence.
