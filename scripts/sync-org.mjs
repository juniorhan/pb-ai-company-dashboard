#!/usr/bin/env node
// npm run sync:org — PB AI 회사 Wiki 정본에서 공개용 src/data/org.json을 만든다.
// 정본 위치: .env.local의 PBAI_WIKI_ORG_DIR 또는 --wiki <폴더>. 정본(과 해석 규칙)이 같으면 파일을 바꾸지 않는다.
// 옵션: --force(같아도 다시 씀), --check(바뀔 것이 있으면 종료 1, 파일은 안 씀)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrg, loadLocalEnv } from './org-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = { ...loadLocalEnv(root), ...process.env };
const wiki = argValue('--wiki') ?? env.PBAI_WIKI_ORG_DIR;
if (!wiki) {
  console.error('정본 폴더를 모릅니다. .env.local에 PBAI_WIKI_ORG_DIR=<PB AI 회사 폴더>를 적거나 --wiki <폴더>를 주세요.');
  process.exit(2);
}

let result;
try {
  result = buildOrg(wiki);
} catch (e) {
  console.error(`실패: ${e.message}`);
  process.exit(1);
}
const { org, warnings, sanitized } = result;
const out = path.join(root, 'src', 'data', 'org.json');
let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  prev = null;
}
const same = prev && prev.format === org.format && prev.meta?.source_hash === org.meta.source_hash;
const c = org.meta.counts;
console.log(`정본: 본부 ${c.depts} · 팀 ${c.teams} · 직원 ${c.staff} · 확장 대기 ${c.expansion} · 승계 표(팀 ${Object.keys(org.legacy.teams).length}, 본부 ${Object.keys(org.legacy.depts).length})`);
for (const w of warnings) console.log(`경고: ${w}`);
for (const s of sanitized) console.log(`공개 검사로 고침: ${s.where} [${s.rules.join(', ')}] → ${s.action}`);

if (args.includes('--check')) {
  console.log(same ? '사본 최신(바뀔 것 없음)' : '사본이 정본과 다름 — npm run sync:org 필요');
  process.exit(same ? 0 : 1);
}
if (same && !args.includes('--force')) {
  console.log('바뀐 것 없음(정본 해시 같음). 파일을 그대로 둡니다.');
  process.exit(0);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(org, null, 2)}\n`, 'utf8');
console.log(`썼습니다: src/data/org.json (정본 해시 ${org.meta.source_hash.slice(0, 12)})`);
