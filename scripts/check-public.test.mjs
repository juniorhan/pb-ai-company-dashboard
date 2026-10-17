// check-public.mjs 시험: 규칙(경로·메일·비밀값 모양 + 승인 가정·주장 문구), 예외 4가지, 대상 목록(git·일반 폴더), .env 거부, 명령줄 실행을 본다.
// 위반 글자는 시험 파일에 그대로 쓰지 않고 실행할 때 이어 붙여 만든다(이 파일도 공개 검사 대상이다).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXTRA_RULES, TEXT_EXTENSIONS, checkPublic, listTargets, scanText } from './check-public.mjs';

const j = (...parts) => parts.join('');
const nl = (...lines) => `${lines.join('\n')}\n`;                       // 줄 목록 → 줄바꿈으로 끝나는 글자
const HERE = path.dirname(fileURLToPath(import.meta.url));

const DRIVE = j('C', ':', '\\', 'Users', '\\', 'x');                    // 드라이브 경로 + 홈 폴더 경로
const MAIL = j('a', '@', 'b.co');                                       // 메일 주소
const ASSUME = j('모든', ' 기능은 승인된 것으로 본다');                    // 승인 가정 문구
const CLAIM = j('금융', '당국이 승인을 받았다');                           // 승인 주장 문구
const CLAIM2 = j('준', '법감시가 승인을 완료했다');
const CLAIM3 = j('준', '법 승인을 받았습니다');
const CLAIMS_MORE = [j('금감', '원 승인 받지만 공개할 수 없습니다'), j('금융', '당국이 승인했습니다'), j('금융', '위원회가 승인하였다')];   // 활용형(독립 검사 2회차 재현)
const TRADES = [
  j('삼성전자 10주 매', '수'), j('지금 매', '수하세요'), j('적극 매', '도'), j('비중 확대 추', '천'), j('목표', '가 85000원'),
  j('이 종목 매', '수를 추천합니다'), j('이 종', '목을 추천합니다'),
];   // 매매 지시·추천 문구

const dirs = [];
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-public-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/* ───────────── scanText ───────────── */

describe('scanText', () => {
  it('깨끗한 글자는 위반이 없다', () => {
    expect(scanText('src/a.ts', 'const x = 1;\n// 시황 자료 수집\nhttps://example.com/path?q=1')).toEqual([]);
    expect(scanText('docs/a.md', '')).toEqual([]);
  });

  it('위반 줄 번호(1부터)와 규칙 이름을 돌려준다. 한 줄에 규칙이 여럿이면 여러 건', () => {
    const hits = scanText('src/a.ts', ['정상', `경로 ${DRIVE}`, '정상', MAIL].join('\n'));
    expect(hits.filter((h) => h.line === 2).map((h) => h.rule).sort()).toEqual(['드라이브 경로', '홈 폴더 경로']);
    expect(hits.filter((h) => h.line === 4)).toEqual([{ line: 4, rule: '메일 주소' }]);
    expect(hits).toHaveLength(3);
  });

  it('CRLF 줄바꿈도 줄 번호가 맞다', () => {
    expect(scanText('a.md', `정상\r\n정상\r\n${MAIL}\r\n`)).toEqual([{ line: 3, rule: '메일 주소' }]);
  });

  it('주소의 `://` 는 드라이브 경로로 오해하지 않지만 그 뒤의 진짜 드라이브 경로는 잡는다', () => {
    expect(scanText('a.md', 'https://example.com ftp://host/x git+ssh://host/repo file:///tmp/z')).toEqual([]);
    const rules = scanText('a.md', `file:///${j('C', ':', '/', 'Users', '/x')}`).map((h) => h.rule);
    expect(rules).toContain('드라이브 경로');
    expect(scanText('a.md', j('D', ':', '//x')).map((h) => h.rule)).toContain('드라이브 경로');   // 한 글자 앞은 주소 방식이 아니다
  });

  it('승인 가정·승인 주장 문구도 잡는다', () => {
    expect(scanText('a.md', ASSUME)).toEqual([{ line: 1, rule: '승인 가정 문구' }]);
    expect(scanText('a.md', CLAIM)).toEqual([{ line: 1, rule: '승인 주장 문구' }]);
    expect(scanText('a.md', CLAIM2)).toEqual([{ line: 1, rule: '승인 주장 문구' }]);
    expect(scanText('a.md', CLAIM3)).toEqual([{ line: 1, rule: '승인 주장 문구' }]);
    for (const c of CLAIMS_MORE) expect(scanText('a.md', c), c).toEqual([{ line: 1, rule: '승인 주장 문구' }]);
    expect(scanText('a.md', '준법 검사를 통과했다(내부 검사 통과)')).toEqual([]);
    // 부정 문장은 잡지 않는다
    expect(scanText('a.md', '내부 검사이며 실제 준법 승인이 아님')).toEqual([]);
    expect(scanText('a.md', '준법 승인을 받지 않은 시연 화면')).toEqual([]);
    expect(scanText('a.md', '금융당국 승인을 받지 못한 기능은 끈다')).toEqual([]);
    expect(scanText('a.md', '준법감시가 승인하지 않았다')).toEqual([]);
    expect(EXTRA_RULES.map(([, why]) => why)).toEqual(['승인 가정 문구', '승인 주장 문구', '매매 지시·추천 문구']);
  });

  it('매매 지시·종목 추천 문구를 잡고, 매수·매도라는 낱말만으로는 잡지 않는다', () => {
    for (const t of TRADES) expect(scanText('a.md', t), t).toEqual([{ line: 1, rule: '매매 지시·추천 문구' }]);
    expect(scanText('a.md', '매수·매도 구분 칸')).toEqual([]);
    expect(scanText('a.md', '3주 동안 수집')).toEqual([]);
    expect(scanText('a.md', '종목을 추천하지 않는다')).toEqual([]);
    expect(scanText('a.md', '매수를 추천하지 않는다')).toEqual([]);
    expect(scanText('a.md', '종목 추천 문구는 쓰지 않는다')).toEqual([]);
  });

  it('시험 파일에서만 줄 끝의 허용 표시가 그 줄을 면제한다', () => {
    const mark = j('// public-check', ': allow');
    const text = `${MAIL} ${mark}\n${MAIL}`;
    expect(scanText('src/a.test.ts', text)).toEqual([{ line: 2, rule: '메일 주소' }]);
    expect(scanText('scripts/a.test.mjs', text)).toEqual([{ line: 2, rule: '메일 주소' }]);
    expect(scanText('src/a.ts', text)).toEqual([{ line: 1, rule: '메일 주소' }, { line: 2, rule: '메일 주소' }]);
    expect(scanText('src/a.spec.ts', text)).toHaveLength(2);
  });

  it('src/data/org.json 의 source_hash 줄만 긴 16진 문자열을 봐준다', () => {
    const line = `    "source_hash": "${'a'.repeat(64)}",`;
    expect(scanText('src/data/org.json', `{\n${line}\n}`)).toEqual([]);
    expect(scanText('other/org.json', `{\n${line}\n}`)).toEqual([{ line: 2, rule: '긴 16진 문자열' }]);
    expect(scanText('src/data/org.json', `{\n    "other": "${'a'.repeat(64)}"\n}`)).toEqual([{ line: 2, rule: '긴 16진 문자열' }]);
  });
});

/* ───────────── listTargets ───────────── */

describe('listTargets', () => {
  it('git 저장소가 아니면 node_modules·dist·.git 을 뺀 전체(정렬, `/` 구분)', () => {
    const root = makeProject({
      'b.ts': '1', 'a/z.md': '1', 'a/b/c.json': '1', 'node_modules/x/index.js': '1', 'dist/app.js': '1', '.git/config': '1', 'src/node_modules/y.js': '1',
    });
    expect(listTargets(root)).toEqual(['a/b/c.json', 'a/z.md', 'b.ts']);
  });

  it.skipIf(!hasGit)('git 저장소면 추적 중인 파일과 무시되지 않은 새 파일만', () => {
    const root = makeProject({
      '.gitignore': nl('ignored.txt', 'secret/'), 'a.ts': '1', 'ignored.txt': '1', 'secret/b.md': '1', 'dir/c.md': '1', 'node_modules/n.js': '1',
    });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    expect(listTargets(root)).toEqual(['.gitignore', 'a.ts', 'dir/c.md', 'node_modules/n.js']);   // node_modules는 .gitignore에 없으면 git이 아는 대로
    fs.writeFileSync(path.join(root, '.gitignore'), nl('ignored.txt', 'secret/', 'node_modules/'), 'utf8');
    expect(listTargets(root)).toEqual(['.gitignore', 'a.ts', 'dir/c.md']);
  });
});

/* ───────────── checkPublic ───────────── */

describe('checkPublic', () => {
  it('깨끗한 프로젝트: 위반 0, 검사한 글자 파일 수만 센다', () => {
    const root = makeProject({
      'src/a.ts': 'export const a = 1;\n', 'docs/b.md': '# 제목\n', 'data/c.jsonl': '{"a":1}\n', 'img/d.png': `이진 파일이라 안 봄 ${MAIL}`,
      'notes.docx': MAIL, 'package-lock.json': `{"x": "${MAIL}"}`, '.env.example': 'PBAI_EVENTS_PATHS=\n',
    });
    expect(checkPublic(root)).toEqual({ violations: [], scanned: 4 });     // a.ts, b.md, c.jsonl, .env.example
  });

  it('위반 목록은 파일(정렬)·줄 순서로 `{file, line, rule}`', () => {
    const root = makeProject({ 'z.ts': nl('ok', MAIL), 'a.md': nl(ASSUME, 'ok'), 'm/n.json': JSON.stringify({ p: DRIVE }) });
    const { violations, scanned } = checkPublic(root);
    expect(scanned).toBe(3);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual(['a.md:1', 'm/n.json:1', 'm/n.json:1', 'z.ts:2']);
    expect(violations.map((v) => v.rule)).toEqual(['승인 가정 문구', '드라이브 경로', '홈 폴더 경로', '메일 주소']);
  });

  it('.env 와 .env.* 는 있기만 해도 위반(.env.example 은 제외), 내용은 보지 않는다', () => {
    const root = makeProject({ '.env': 'A=1', '.env.local': 'B=2', '.env.production': 'C=3', '.env.example': 'D=4', 'sub/.env': 'E=5' });
    const { violations } = checkPublic(root);
    expect(violations.map((v) => v.file)).toEqual(['.env', '.env.local', '.env.production', 'sub/.env']);
    for (const v of violations) expect(v).toMatchObject({ line: 0, rule: '.env 파일은 저장소에 올릴 수 없습니다' });
  });

  it('예외: package-lock.json, 규칙 정의 파일 두 개', () => {
    const root = makeProject({
      'package-lock.json': MAIL, 'scripts/org-lib.mjs': MAIL, 'scripts/check-public.mjs': MAIL, 'scripts/other.mjs': MAIL,
      'src/package-lock.json': MAIL,
    });
    expect(checkPublic(root).violations.map((v) => v.file)).toEqual(['scripts/other.mjs', 'src/package-lock.json']);
  });

  it('시험 파일의 허용 표시 줄은 면제, 나머지 줄은 그대로 검사', () => {
    const mark = j('// public-check', ': allow');
    const root = makeProject({ 'src/x.test.ts': `const a = '${MAIL}'; ${mark}\nconst b = '${MAIL}';\n` });
    expect(checkPublic(root).violations).toEqual([{ file: 'src/x.test.ts', line: 2, rule: '메일 주소' }]);
  });

  it('텍스트로 보는 확장자 목록', () => {
    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.json', '.jsonl', '.md', '.html', '.css', '.yml', '.yaml', '.svg', '.txt', '.example']) {
      expect(TEXT_EXTENSIONS.has(ext), ext).toBe(true);
    }
    for (const ext of ['.png', '.ico', '.woff2', '.docx', '.lock']) expect(TEXT_EXTENSIONS.has(ext), ext).toBe(false);
  });

  it.skipIf(!hasGit)('git 목록에는 있지만 디스크에서 사라진 파일은 건너뛴다. 무시된 파일은 검사하지 않는다', () => {
    const root = makeProject({ '.gitignore': nl('ignored.md'), 'gone.ts': MAIL, 'ok.ts': '1', 'ignored.md': MAIL });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'gone.ts', 'ok.ts'], { cwd: root, stdio: 'ignore' });
    fs.rmSync(path.join(root, 'gone.ts'));
    const { violations, scanned } = checkPublic(root);
    expect(violations).toEqual([]);
    expect(scanned).toBe(1);                                              // ok.ts 하나(.gitignore는 글자 확장자가 아니라 보지 않는다)
  });
});

/* ───────────── 명령줄 ───────────── */

describe('node scripts/check-public.mjs', () => {
  /** 임시 프로젝트에 스크립트 두 개를 복사하고 node_modules 를 연결해 실제로 실행한다 */
  function runIn(files) {
    const root = makeProject({ ...files });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const name of ['check-public.mjs', 'org-lib.mjs']) fs.copyFileSync(path.join(HERE, name), path.join(root, 'scripts', name));
    fs.symlinkSync(path.resolve(HERE, '..', 'node_modules'), path.join(root, 'node_modules'), 'junction');
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-public.mjs')], { cwd: root, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('통과하면 `공개 검사 통과: 파일 n개` 와 종료 코드 0', () => {
    const r = runIn({ 'src/a.ts': 'export const a = 1;\n', 'docs/b.md': '# 제목\n' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('공개 검사 통과: 파일 2개');                // 스크립트 두 개(규칙 정의 파일)는 세지 않는다
    expect(r.status).toBe(0);
  });

  it('위반이 있으면 `파일:줄: 규칙` 목록과 `공개 검사 실패: 위반 n건`, 종료 코드 1', () => {
    const r = runIn({ 'src/bad.ts': nl('ok', DRIVE), 'docs/b.md': nl(MAIL) });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    const lines = r.stderr.trim().split(/\r?\n/);
    expect(lines).toContain('src/bad.ts:2: 드라이브 경로');
    expect(lines).toContain('src/bad.ts:2: 홈 폴더 경로');
    expect(lines).toContain('docs/b.md:1: 메일 주소');
    expect(lines.at(-1)).toBe('공개 검사 실패: 위반 3건');
  });

  it('.env 가 있으면 실패', () => {
    const r = runIn({ 'src/a.ts': '1', '.env': 'X=1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.env:0: .env 파일은 저장소에 올릴 수 없습니다');
  });
});
