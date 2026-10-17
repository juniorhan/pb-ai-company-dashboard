#!/usr/bin/env node
// npm run check:public — 공개 저장소에 올라가면 안 되는 내용이 있는지 검사한다.
// 대상: git이 아는 파일(추적 중 + 새 파일 중 .gitignore에 걸리지 않은 것). git을 못 쓰면 node_modules·dist·.git을 뺀 전체.
// 규칙: org-lib.mjs의 PUBLIC_RULES(경로·메일·비밀값 모양 등) + 승인 가정·승인 주장 문구 + .env 파일.
// 예외(이 4가지뿐):
//   1. package-lock.json 전체
//   2. src/data/org.json의 "source_hash" 줄(정본 해시)
//   3. 규칙 정의 파일(scripts/org-lib.mjs, scripts/check-public.mjs)
//   4. 시험 파일(*.test.*) 안에서 줄 끝에 `public-check: allow` 표시를 단 줄(의도된 위반 예시)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_RULES } from './org-lib.mjs';

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.json', '.jsonl', '.md', '.html', '.css', '.yml', '.yaml', '.svg', '.txt', '.example',
]);

// 추가 금지 문구(규칙 이름은 위반 보고에 그대로 나온다)
// - 승인 주장: '준법·금융당국 … 승인을 받았다/받지만/완료/획득/됐다/했다'. 부정('승인이 아님', '승인을 받지 않음·못함', '승인하지 않음')은 잡지 않는다.
// - 매매 지시·추천: 수량 붙은 매수·매도, 매수·매도(을·를) 추천/권유/하세요, 종목(을·를) 추천·권유, 강력·적극 매수·매도, 비중 확대·축소 추천, 목표가 숫자.
export const EXTRA_RULES = [
  [/모든 기능.{0,10}승인/, '승인 가정 문구'],
  [/(준법|금융당국|금융감독원|금감원|금융위원회|금융위).{0,10}승인\s?(을|이)?\s?(받(?!지\s?(않|못))|완료|획득|되었|됐|됨|했|하였)/, '승인 주장 문구'],
  [/\d+\s?주\s?(매수|매도)|(매수|매도)\s?(을|를)?\s?(추천|권유|하세요|하십시오)(?!하지)|종목\s?(을|를)\s?(추천|권유)(?!하지)|(강력|적극)\s?(매수|매도)|비중\s?(확대|축소)\s?(추천|권유|하세요|하십시오)|목표\s?주?가\s?[:：]?\s?\d/, '매매 지시·추천 문구'],
];

const ALLOW_MARK = 'public-check: allow';
const RULE_FILES = new Set(['scripts/org-lib.mjs', 'scripts/check-public.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** URL의 `scheme://`는 드라이브 경로(`C:\`·`C:/`)와 헷갈리므로 검사 전에 가린다. */
function maskUrls(line) {
  return line.replace(/\b[a-z][a-z0-9+.-]+:\/\//gi, 'url//');
}

const normalize = (p) => p.split(path.sep).join('/');

function isEnvFile(rel) {
  const name = rel.split('/').pop() ?? rel;
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
}

function isTestFile(rel) {
  return /\.test\.[a-z]+$/i.test(rel);
}

/** git이 아는 파일 목록. 못 쓰면 null. */
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map(normalize);
  } catch {
    return null;
  }
}

function walkFiles(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(root, full));
    else if (entry.isFile()) out.push(normalize(path.relative(root, full)));
  }
  return out;
}

/** 검사 대상 목록(저장소 기준 상대 경로, 정렬) */
export function listTargets(root) {
  const files = gitFiles(root) ?? walkFiles(root);
  return [...new Set(files)].sort();
}

/** 파일 1개의 위반 목록: { line, rule } */
export function scanText(rel, text) {
  const hits = [];
  const test = isTestFile(rel);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (test && raw.includes(ALLOW_MARK)) continue;
    if (rel === 'src/data/org.json' && /"source_hash"\s*:/.test(raw)) continue;
    const line = maskUrls(raw);
    for (const [re, why] of [...PUBLIC_RULES, ...EXTRA_RULES]) {
      if (re.test(line)) hits.push({ line: i + 1, rule: why });
    }
  }
  return hits;
}

/** 저장소 전체 검사. 위반 목록과 검사한 파일 수를 돌려준다. */
export function checkPublic(root) {
  const targets = listTargets(root);
  const violations = [];
  let scanned = 0;
  for (const rel of targets) {
    if (isEnvFile(rel)) {
      violations.push({ file: rel, line: 0, rule: '.env 파일은 저장소에 올릴 수 없습니다' });
      continue;
    }
    if (rel === 'package-lock.json' || RULE_FILES.has(rel)) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;                      // 목록에는 있지만 디스크에 없는 파일(삭제 예정)
    }
    scanned += 1;
    for (const hit of scanText(rel, text)) violations.push({ file: rel, ...hit });
  }
  return { violations, scanned };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { violations, scanned } = checkPublic(root);
  if (violations.length) {
    for (const v of violations) console.error(`${v.file}:${v.line}: ${v.rule}`);
    console.error(`공개 검사 실패: 위반 ${violations.length}건`);
    process.exit(1);
  }
  console.log(`공개 검사 통과: 파일 ${scanned}개`);
}

// 직접 실행했을 때만 검사한다(시험에서 import하면 실행하지 않는다). 연결(junction) 경로로 실행해도 같은 파일로 본다.
function isMain() {
  const self = fileURLToPath(import.meta.url);
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (isMain()) main();
