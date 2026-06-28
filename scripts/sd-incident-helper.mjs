function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    const value = !next || next.startsWith('--') ? 'yes' : next;
    if (args[key]) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
    if (next && !next.startsWith('--')) i += 1;
  }
  return args;
}

function valueOrUnknown(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('; ') || '(미확인)';
  const text = String(value || '').trim();
  return text || '(미확인)';
}

function renderIncident(args) {
  const docs = valueOrUnknown(args.doc || args.docs || args.localDocs);
  const errorMessage = valueOrUnknown(args.errorMessage || args.error || args.message);
  return [
    '# SD Incident Intake',
    '',
    `- 상품 또는 주문: ${valueOrUnknown(args.product || args.order)}`,
    `- 플랫폼: ${valueOrUnknown(args.platform)}`,
    `- 지역: ${valueOrUnknown(args.region)}`,
    `- 작업 유형: ${valueOrUnknown(args.type || args.workType)}`,
    `- 증상: ${valueOrUnknown(args.symptom)}`,
    `- 기대 결과: ${valueOrUnknown(args.expected)}`,
    `- 현재 결과: ${valueOrUnknown(args.actual)}`,
    `- 관련 탭/버튼/오류 메시지: ${errorMessage}`,
    `- 실마켓 write 영향 여부: ${valueOrUnknown(args.marketWrite)}`,
    `- 관련 local docs/logs/API 응답: ${docs}`,
    '',
    '## Next Checks',
    '',
    '- Read the local API docs before changing marketplace integration behavior.',
    '- Compare failing and known-success payloads when a matching success case exists.',
    '- Run the narrowest regression or smoke command before commit.',
  ].join('\n');
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'Usage:',
      'node scripts/sd-incident-helper.mjs --product "NAME" --platform shopee --region SG --type registration --symptom "publish failed" --market-write no',
    ].join('\n'));
    return;
  }
  console.log(renderIncident(args));
}

run();
