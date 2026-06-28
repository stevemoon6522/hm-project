import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

function readRelative(path) {
  const fullPath = join(root, path);
  assert.equal(existsSync(fullPath), true, `${path} must exist`);
  return readFileSync(fullPath, 'utf8');
}

function assertIncludes(text, tokens, label) {
  for (const token of tokens) {
    assert(text.includes(token), `${label} missing token: ${token}`);
  }
}

const operatingDoc = readRelative('docs/wiki/sd-operating-efficiency.md');
assertIncludes(operatingDoc, [
  '# SD Operating Efficiency',
  '## Intake Template',
  '상품 또는 주문',
  '플랫폼',
  '지역',
  '작업 유형',
  '증상',
  '기대 결과',
  '현재 결과',
  '관련 탭/버튼/오류 메시지',
  '실마켓 write 영향 여부',
  '관련 local docs/logs/API 응답',
  '## Diagnosis Packs',
  'Shopee 등록 실패',
  '가격 동기화',
  '이미지 반영 오류',
  'Joom 등록 오류',
  '## Verification Matrix',
  'V2 UI 변경',
  'API/Bridge 변경',
  '실마켓 write 변경',
  '배포 변경',
  'Wiki/문서 변경',
  '## Recurrence Memo',
  '증상 signature',
  '재발 방지 규칙',
], 'SD operating efficiency doc');

const apiIndex = readRelative('docs/wiki/sd-api-doc-index.md');
assertIncludes(apiIndex, [
  '# SD Local API Doc Index',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.add_global_item.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.create_publish_task.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.get_publish_task_result.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.delete_global_item.json',
  'C:\\dev\\api-refs\\marketplaces\\joom\\openapi.yaml',
  'C:\\dev\\api-refs\\marketplaces\\ebay\\sell\\inventory.yaml',
  '10009-SetNewGoods.md',
  '10013-EditGoodsStatus.md',
  'Shopify',
], 'SD API doc index');

const kpiDoc = readRelative('docs/wiki/sd-recurring-incident-kpi.md');
assertIncludes(kpiDoc, [
  '# SD Recurring Incident KPI',
  '반복 장애',
  '일일 리포트',
  '주간 리포트',
  '신규 장애 수',
  '반복 장애 의심 수',
  '같은 원인 확정 수',
  '반복 장애 Top 3',
  '새로 추가한 regression/smoke test',
  '다음 주에 제거할 가장 큰 반복 원인',
], 'SD recurring incident KPI doc');

const helper = readRelative('scripts/sd-incident-helper.mjs');
assertIncludes(helper, [
  'parseArgs',
  'renderIncident',
  '실마켓 write 영향 여부',
  '관련 local docs/logs/API 응답',
], 'SD incident helper source');

const helperRun = spawnSync(process.execPath, [
  'scripts/sd-incident-helper.mjs',
  '--product', 'TEST-PRODUCT',
  '--platform', 'shopee',
  '--region', 'SG',
  '--type', 'registration',
  '--symptom', 'publish failed',
  '--expected', 'publish succeeds',
  '--actual', 'publish task failed',
  '--error-message', 'sample error',
  '--market-write', 'no',
  '--doc', 'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.create_publish_task.json',
], { cwd: root, encoding: 'utf8' });

assert.equal(helperRun.status, 0, helperRun.stderr || helperRun.stdout);
assertIncludes(helperRun.stdout, [
  '# SD Incident Intake',
  '- 상품 또는 주문: TEST-PRODUCT',
  '- 플랫폼: shopee',
  '- 지역: SG',
  '- 작업 유형: registration',
  '- 증상: publish failed',
  '- 기대 결과: publish succeeds',
  '- 현재 결과: publish task failed',
  '- 관련 탭/버튼/오류 메시지: sample error',
  '- 실마켓 write 영향 여부: no',
  'v2.global_product.create_publish_task.json',
], 'SD incident helper output');

const packageJson = readRelative('package.json');
assertIncludes(packageJson, [
  '"verify:sd-operating-efficiency": "node scripts/test-sd-operating-efficiency-docs.mjs"',
], 'package scripts');

const platformCycle = readRelative('scripts/platform-test-cycle.mjs');
assertIncludes(platformCycle, [
  'DIAGNOSIS_PACKS',
  'shopee-registration',
  'price-sync',
  'joom-registration',
  'local_api_docs',
  'regression_commands',
], 'platform test cycle diagnosis packs');

const platformDocs = readRelative('docs/platform-test-cycle.md');
assertIncludes(platformDocs, [
  'node scripts/platform-test-cycle.mjs inspect --pack shopee-registration',
  'node scripts/platform-test-cycle.mjs inspect --pack price-sync',
  'node scripts/platform-test-cycle.mjs inspect --pack joom-registration',
], 'platform test cycle docs');

console.log('SD operating efficiency docs and helper checks passed');
