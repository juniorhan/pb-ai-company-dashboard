// org-lib.mjs 시험: 임시 폴더(os.tmpdir)에 가짜 Wiki(본부 2·팀 3·직원 4, 동결 노트, 시험 노트, 부속표)를 만들어
// buildOrg → validateOrgShape가 맞게 도는지, 동결·시험 노트와 공개 검사 위반 문구가 규칙대로 처리되는지 본다.
// 공개 검사에 걸리는 모양의 글자는 시험 파일에 그대로 쓰지 않고 실행할 때 이어 붙여 만든다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORMAT, LIB_VERSION, PUBLIC_RULES, buildOrg, lintPublic, loadLocalEnv, parseExecutors, sanitizeText, sectionBullets,
  sectionTable, splitNote, validateOrgShape,
} from './org-lib.mjs';

const j = (...parts) => parts.join('');
const NOW = new Date('2026-10-17T00:00:00.000Z');

/* ───────────── 가짜 Wiki 만들기 ───────────── */

const yamlValue = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
function note(fm, body = '') {
  const lines = Object.entries(fm).map(([k, v]) => (Array.isArray(v)
    ? (v.length ? `${k}:\n${v.map((x) => `  - ${yamlValue(x)}`).join('\n')}` : `${k}: []`)
    : `${k}: ${yamlValue(v)}`));
  return ['---', lines.join('\n'), '---', body].join('\n');
}

function writeNote(root, folder, name, fm, body = '') {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), note(fm, body), 'utf8');
}

const EXTRA_FM = { ceo_title: '대표이사', dept_order: ['med', 'inv'] };
const EXTRA_BODY = [
  '## 대표 역할',
  '- 투자 판단을 확정한다',
  '- 외부 발행을 승인한다',
  '',
  '## 대표 몫',
  '| 업무 | 내용 |',
  '|---|---|',
  '| own-01 | 최종 판단 |',
  '| own-02 | 계정 만들기 |',
  '',
  '## AI 총괄 체계',
  '| id | 이름 | 실행 | 역할 |',
  '|---|---|---|---|',
  '| hq.claude | Claude 총괄 | claude | 설계·작성 |',
  '| hq.codex | Codex 검사 | codex | 독립 검사 |',
  '',
  '## 확장 대기 직책',
  '| 팀 | 직책 | 조건 |',
  '|---|---|---|',
  '| inv-01 | 보조 수집가 | 업무량이 늘 때 |',
  '| zzz-99 | 없는 팀의 직책 | 조건 |',
  '',
].join('\n');

/** 활성 본부 2(옛 본부 동결 1) · 활성 팀 3(동결 1, 시험 1) · 활성 직원 4(동결 1, 시험 1) · 부속표 */
function baseWiki(root) {
  writeNote(root, '실', 'inv', { type: 'dept', id: 'inv', name: '리서치본부', role: '시장 자료를 모은다', status: 'active' }, '본부장 역할: 리서치 총괄(관리 역할 겸임)\n');
  writeNote(root, '실', 'med', { type: 'dept', id: 'med', name: '미디어본부', role: '원고를 만든다', status: 'active' }, '본부장 역할: 편집장(관리 역할 겸임)\n');
  writeNote(root, '실', 'old', { type: 'dept', id: 'old', name: '옛 본부', status: 'frozen', successor: 'med' });

  writeNote(root, '팀', 'inv-01', { type: 'team', id: 'inv-01', dept: 'inv', name: '자료수집팀', role: '시황 자료 수집', status: 'active', phase: 'P0' });
  writeNote(root, '팀', 'inv-02', { type: 'team', id: 'inv-02', dept: 'inv', name: '분석팀', role: '숫자 대조', status: 'building', phase: 'P1' });
  writeNote(root, '팀', 'med-01', { type: 'team', id: 'med-01', dept: 'med', name: '원고팀', role: '원고 작성', status: 'active', phase: 'P0' });
  writeNote(root, '팀', 'old-01', { type: 'team', id: 'old-01', dept: 'old', name: '옛 팀', status: 'frozen', successor: 'med-01' });
  writeNote(root, '팀', 'tst-01', { type: 'team', id: 'tst-01', dept: 'inv', name: '시험 팀', status: 'active', is_test: true });

  writeNote(root, '직원', 'inv-01-e01', {
    type: 'staff', id: 'inv-01-e01', team: 'inv-01', name: '수집 담당', role: '자료 수집', status: 'active', phase: 'P0', risk_class: 'R0',
    ai_writer: 'Aside + Claude', checker: 'inv-01-e02 (Claude)', duties: ['inv-01-T01', 'inv-01-T02'],
  }, '## 담당 업무\n- `inv-01-T01` 시황 자료 수집\n- `inv-01-T02` 일정 정리\n');
  writeNote(root, '직원', 'inv-01-e02', {
    type: 'staff', id: 'inv-01-e02', team: 'inv-01', name: '대조 담당', role: '숫자 대조', status: 'active', phase: 'P0', risk_class: 'R1',
    ai_writer: 'Claude', checker: 'Codex 독립 검사', duties: ['inv-01-T03'],
  }, '## 담당 업무\n- `inv-01-T03` 숫자 원자료 대조\n');
  writeNote(root, '직원', 'inv-02-e01', {
    type: 'staff', id: 'inv-02-e01', team: 'inv-02', name: '분석 담당', role: '분석', status: 'building', phase: 'P1', risk_class: 'R0',
    ai_writer: '스크립트 + Claude', checker: 'inv-01-e01 + 사람', duties: [],
  });
  writeNote(root, '직원', 'med-01-e01', {
    type: 'staff', id: 'med-01-e01', team: 'med-01', name: '원고 담당', role: '원고', status: 'active', phase: 'P0', risk_class: 'R2',
    ai_writer: 'Claude + Codex', checker: 'inv-01-e02, inv-02-e01', duties: ['med-01-T01'],
  }, '## 담당 업무\n- `med-01-T01` 브리핑 원고 작성\n');
  writeNote(root, '직원', 'inv-01-e09', { type: 'staff', id: 'inv-01-e09', team: 'inv-01', name: '옛 담당', status: 'frozen' });
  writeNote(root, '직원', 'tst-01-e01', { type: 'staff', id: 'tst-01-e01', team: 'inv-01', name: '시험 담당', status: 'active', is_test: true });

  fs.writeFileSync(path.join(root, '04_조직 부속표.md'), note(EXTRA_FM, EXTRA_BODY), 'utf8');
}

const dirs = [];
function freshWiki(tweak) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-wiki-'));
  dirs.push(root);
  baseWiki(root);
  tweak?.(root);
  return root;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const build = (root, opts = { now: NOW }) => buildOrg(root, opts);

/* ───────────── buildOrg ───────────── */

describe('buildOrg: 가짜 Wiki', () => {
  let result;
  let root;
  beforeAll(() => { root = freshWiki(); result = build(root); });

  it('검사를 통과하고 개수가 실제와 맞다(경고·정리 내역 없음)', () => {
    const { org, warnings, sanitized } = result;
    expect(validateOrgShape(org)).toEqual([]);
    expect(org.format).toBe(FORMAT);
    expect(org.meta.counts).toEqual({ depts: 2, teams: 3, staff: 4, expansion: 1 });
    expect(org.depts).toHaveLength(2);
    expect(org.teams).toHaveLength(3);
    expect(org.staff).toHaveLength(4);
    expect(warnings.filter((w) => !w.includes('zzz-99'))).toEqual([]);
    expect(sanitized).toEqual([]);
  });

  it('본부는 부속표의 dept_order 순서, 팀은 본부 순서 뒤 id 순, 직원은 id 순', () => {
    const { org } = result;
    expect(org.depts.map((d) => d.id)).toEqual(['med', 'inv']);
    expect(org.teams.map((t) => t.id)).toEqual(['med-01', 'inv-01', 'inv-02']);
    expect(org.staff.map((s) => s.id)).toEqual(['inv-01-e01', 'inv-01-e02', 'inv-02-e01', 'med-01-e01']);
  });

  it('본부·팀 칸: 이름·역할·본부장 직책·운영 상태·단계', () => {
    const { org } = result;
    expect(org.depts[0]).toEqual({ id: 'med', name: '미디어본부', head: '편집장', role: '원고를 만든다' });
    expect(org.depts[1]).toMatchObject({ id: 'inv', head: '리서치 총괄' });
    expect(org.teams.find((t) => t.id === 'inv-02')).toEqual({ id: 'inv-02', dept: 'inv', name: '분석팀', role: '숫자 대조', status: 'building', phase: 'P1' });
  });

  it('동결된 본부·팀은 목록에서 빼고 승계 관계(legacy)로 남긴다', () => {
    const { org } = result;
    expect(org.legacy).toEqual({ teams: { 'old-01': 'med-01' }, depts: { old: 'med' } });
    expect(org.teams.some((t) => t.id === 'old-01')).toBe(false);
    expect(org.depts.some((d) => d.id === 'old')).toBe(false);
  });

  it('is_test 노트(팀·직원)와 동결 직원은 결과에 없다', () => {
    const ids = [...result.org.teams.map((t) => t.id), ...result.org.staff.map((s) => s.id)];
    expect(ids).not.toContain('tst-01');
    expect(ids).not.toContain('tst-01-e01');
    expect(ids).not.toContain('inv-01-e09');
  });

  it('직원 칸: 실행 주체·검증 주체·검증 직원·담당 업무 제목', () => {
    const byId = Object.fromEntries(result.org.staff.map((s) => [s.id, s]));
    expect(byId['inv-01-e01']).toEqual({
      id: 'inv-01-e01', team: 'inv-01', dept: 'inv', name: '수집 담당', role: '자료 수집', status: 'active', phase: 'P0', risk: 'R0',
      executors: ['claude', 'aside'], checkers: ['claude'], checker_staff: ['inv-01-e02'],
      duties: [{ id: 'inv-01-T01', title: '시황 자료 수집' }, { id: 'inv-01-T02', title: '일정 정리' }],
    });
    expect(byId['inv-01-e02']).toMatchObject({ risk: 'R1', executors: ['claude'], checkers: ['codex'], checker_staff: [] });
    expect(byId['inv-02-e01']).toMatchObject({ status: 'building', phase: 'P1', executors: ['claude', 'script'], checkers: ['human'], checker_staff: ['inv-01-e01'], duties: [] });
    expect(byId['med-01-e01']).toMatchObject({ dept: 'med', risk: 'R2', executors: ['claude', 'codex'], checkers: [], checker_staff: ['inv-01-e02', 'inv-02-e01'] });
  });

  it('부속표: 대표 직책·역할·몫, AI 총괄, 확장 대기(활성 팀만)', () => {
    const { org, warnings } = result;
    expect(org.ceo).toEqual({
      title: '대표이사',
      holds: ['투자 판단을 확정한다', '외부 발행을 승인한다'],
      owner_only: [{ task: 'own-01', title: '최종 판단' }, { task: 'own-02', title: '계정 만들기' }],
    });
    expect(org.hq).toEqual([
      { id: 'hq.claude', name: 'Claude 총괄', executor: 'claude', role: '설계·작성' },
      { id: 'hq.codex', name: 'Codex 검사', executor: 'codex', role: '독립 검사' },
    ]);
    expect(org.expansion).toEqual([{ team: 'inv-01', role: '보조 수집가', trigger: '업무량이 늘 때' }]);
    expect(warnings).toEqual([expect.stringContaining('zzz-99')]);
  });

  it('meta: 만든 시각은 넘긴 now, 출처는 wiki, 해시는 같은 입력이면 같고 내용이 바뀌면 달라진다', () => {
    const { org } = result;
    expect(org.meta.generated_at).toBe('2026-10-17T00:00:00.000Z');
    expect(org.meta.source).toBe('wiki');
    expect(org.meta.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(build(root, { now: new Date('2030-01-01T00:00:00Z') }).org.meta.source_hash).toBe(org.meta.source_hash);

    const changed = freshWiki((r) => writeNote(r, '팀', 'med-01', { type: 'team', id: 'med-01', dept: 'med', name: '원고팀', role: '원고 작성(수정)', status: 'active', phase: 'P0' }));
    expect(build(changed).org.meta.source_hash).not.toBe(org.meta.source_hash);
    expect(LIB_VERSION).toMatch(/^org-lib\//);
  });

  it('now를 안 주면 현재 시각', () => {
    const before = Date.now();
    const { org } = buildOrg(root);
    const at = Date.parse(org.meta.generated_at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe('buildOrg: 경고', () => {
  it('부속표가 없으면 경고하고 대표 몫·AI 총괄·확장 대기를 비워 둔다', () => {
    const root = freshWiki((r) => fs.rmSync(path.join(r, '04_조직 부속표.md')));
    const { org, warnings } = build(root);
    expect(warnings[0]).toContain('04_조직 부속표.md');
    expect(org.ceo).toEqual({ title: '대표이사', holds: [], owner_only: [] });
    expect(org.hq).toEqual([]);
    expect(org.expansion).toEqual([]);
    expect(org.depts.map((d) => d.id)).toEqual(['inv', 'med']);          // dept_order가 없으면 id 순
  });

  it('본부장 직책을 못 찾으면 `본부장`으로 두고 경고', () => {
    const root = freshWiki((r) => writeNote(r, '실', 'med', { type: 'dept', id: 'med', name: '미디어본부', role: '원고를 만든다', status: 'active' }, '본문에 직책이 없다\n'));
    const { org, warnings } = build(root);
    expect(org.depts.find((d) => d.id === 'med').head).toBe('본부장');
    expect(warnings.some((w) => w.includes('med') && w.includes('본부장'))).toBe(true);
  });

  it('알 수 없는 운영 상태는 planned로 두고 경고', () => {
    const root = freshWiki((r) => writeNote(r, '팀', 'inv-02', { type: 'team', id: 'inv-02', dept: 'inv', name: '분석팀', role: '숫자 대조', status: 'unknown-state', phase: 'P9' }));
    const { org, warnings } = build(root);
    expect(org.teams.find((t) => t.id === 'inv-02')).toMatchObject({ status: 'planned', phase: null });
    expect(warnings.some((w) => w.includes('inv-02') && w.includes('unknown-state'))).toBe(true);
  });

  it('활성 본부가 아닌 본부의 팀, 활성 팀이 아닌 팀의 직원은 빼고 경고', () => {
    const root = freshWiki((r) => {
      writeNote(r, '팀', 'ghost-01', { type: 'team', id: 'ghost-01', dept: 'ghost', name: '유령팀', status: 'active', phase: 'P0' });
      writeNote(r, '직원', 'ghost-01-e01', { type: 'staff', id: 'ghost-01-e01', team: 'ghost-01', name: '유령', status: 'active', ai_writer: 'Claude' });
      writeNote(r, '직원', 'inv-09-e01', { type: 'staff', id: 'inv-09-e01', team: 'inv-09', name: '팀 없는 직원', status: 'active', ai_writer: 'Claude' });
    });
    const { org, warnings } = build(root);
    expect(org.teams.map((t) => t.id)).toEqual(['med-01', 'inv-01', 'inv-02']);
    expect(org.staff.map((s) => s.id)).not.toContain('ghost-01-e01');
    expect(org.staff.map((s) => s.id)).not.toContain('inv-09-e01');
    expect(warnings.some((w) => w.includes('ghost-01') && w.includes('ghost'))).toBe(true);
    expect(warnings.some((w) => w.includes('inv-09-e01'))).toBe(true);
  });

  it('직원이 없는 팀·실행 주체를 못 읽은 직원·활성이 아닌 검증 직원을 경고', () => {
    const root = freshWiki((r) => {
      writeNote(r, '팀', 'med-02', { type: 'team', id: 'med-02', dept: 'med', name: '빈 팀', status: 'planned', phase: 'P2' });
      writeNote(r, '직원', 'inv-02-e01', {
        type: 'staff', id: 'inv-02-e01', team: 'inv-02', name: '분석 담당', status: 'building', ai_writer: '미정', checker: 'inv-01-e77', duties: [],
      });
    });
    const { warnings } = build(root);
    expect(warnings.some((w) => w.includes('med-02') && w.includes('0명'))).toBe(true);
    expect(warnings.some((w) => w.includes('inv-02-e01') && w.includes('ai_writer'))).toBe(true);
    expect(warnings.some((w) => w.includes('inv-02-e01') && w.includes('inv-01-e77'))).toBe(true);
  });

  it('검증 직원 목록은 자기 자신을 빼고 중복을 합친다', () => {
    const { org } = build(freshWiki((r) => writeNote(r, '직원', 'inv-01-e02', {
      type: 'staff', id: 'inv-01-e02', team: 'inv-01', name: '대조 담당', status: 'active', ai_writer: 'Claude',
      checker: 'inv-01-e02 inv-01-e01 inv-01-e01 (Codex)', duties: [],
    })));
    const staff = org.staff.find((x) => x.id === 'inv-01-e02');
    expect(staff.checker_staff).toEqual(['inv-01-e01']);
    expect(staff.checkers).toEqual(['codex']);
  });

  it('담당 업무 제목이 본문에 없으면 업무 id를 제목으로 쓴다', () => {
    const { org } = build(freshWiki((r) => writeNote(r, '직원', 'inv-02-e01', {
      type: 'staff', id: 'inv-02-e01', team: 'inv-02', name: '분석 담당', status: 'building', ai_writer: 'Claude', duties: ['inv-02-T01'],
    })));
    expect(org.staff.find((s) => s.id === 'inv-02-e01').duties).toEqual([{ id: 'inv-02-T01', title: 'inv-02-T01' }]);
  });
});

describe('buildOrg: 공개 검사', () => {
  const drivePath = j('C', ':', '\\', 'Users', '\\', 'someone', '\\', 'notes.md');
  const mail = j('someone', '@', 'example.com');

  it('괄호 안의 위반 조각은 지우고, 괄호가 아니면 통째로 `공개 사본에서 생략`', () => {
    const root = freshWiki((r) => {
      writeNote(r, '직원', 'inv-01-e01', {
        type: 'staff', id: 'inv-01-e01', team: 'inv-01', name: '수집 담당', role: `자료 수집 (${drivePath}) 담당`, status: 'active', phase: 'P0', risk_class: 'R0',
        ai_writer: 'Claude', checker: 'Codex', duties: [],
      });
      writeNote(r, '직원', 'inv-01-e02', {
        type: 'staff', id: 'inv-01-e02', team: 'inv-01', name: '대조 담당', role: `문의 ${mail}`, status: 'active', phase: 'P0', risk_class: 'R1',
        ai_writer: 'Claude', checker: 'Codex', duties: [],
      });
    });
    const { org, sanitized } = build(root);
    const byId = Object.fromEntries(org.staff.map((s) => [s.id, s]));
    expect(byId['inv-01-e01'].role).toBe('자료 수집 담당');
    expect(byId['inv-01-e02'].role).toBe('(공개 사본에서 생략)');
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]).toMatchObject({ where: 'staff inv-01-e01.role', action: '괄호 조각 삭제' });
    expect(sanitized[0].rules).toEqual(expect.arrayContaining(['드라이브 경로', '홈 폴더 경로']));
    expect(sanitized[1]).toMatchObject({ where: 'staff inv-01-e02.role', action: '공개 사본에서 생략', rules: ['메일 주소'] });
    expect(JSON.stringify(org)).not.toContain('someone');
    expect(validateOrgShape(org)).toEqual([]);
  });

  it('본부·팀·부속표 글자에도 같은 검사를 건다', () => {
    const root = freshWiki((r) => {
      writeNote(r, '팀', 'med-01', { type: 'team', id: 'med-01', dept: 'med', name: '원고팀', role: `원고 작성 ${mail}`, status: 'active', phase: 'P0' });
      const body = EXTRA_BODY.replace('- 투자 판단을 확정한다', () => `- 판단 확정 ${drivePath}`);
      fs.writeFileSync(path.join(r, '04_조직 부속표.md'), note(EXTRA_FM, body), 'utf8');
    });
    const { org, sanitized } = build(root);
    expect(org.teams.find((t) => t.id === 'med-01').role).toBe('(공개 사본에서 생략)');
    expect(org.ceo.holds[0]).toBe('(공개 사본에서 생략)');
    expect(sanitized.map((s) => s.where)).toEqual(expect.arrayContaining(['team med-01.role', 'ceo.holds[0]']));
  });
});

describe('buildOrg: 오류', () => {
  it('Wiki 폴더가 없거나 비어 있으면 던진다(메시지에 경로가 없다)', () => {
    expect(() => buildOrg('')).toThrow('Wiki 정본 폴더를 찾지 못했습니다');
    expect(() => buildOrg(undefined)).toThrow('Wiki 정본 폴더를 찾지 못했습니다');
    const missing = path.join(os.tmpdir(), 'pbai-no-such-wiki-dir');
    try {
      buildOrg(missing);
      expect.unreachable();
    } catch (e) {
      expect(e.message).toContain('Wiki 정본 폴더를 찾지 못했습니다');
      expect(e.message).not.toContain('pbai-no-such-wiki-dir');
    }
  });

  it('실·팀·직원 폴더가 하나라도 없으면 던진다', () => {
    for (const folder of ['실', '팀', '직원']) {
      const root = freshWiki((r) => fs.rmSync(path.join(r, folder), { recursive: true, force: true }));
      expect(() => build(root), folder).toThrow(`정본 폴더가 없습니다: ${folder}`);
    }
  });

  it('만든 결과가 구조 검사에 걸리면 던진다(예: 정리되지 않은 위반 글자가 id에 있는 경우)', () => {
    const root = freshWiki((r) => writeNote(r, '팀', 'med-01', { type: 'team', id: j('med-01', '@', 'x.co'), dept: 'med', name: '원고팀', status: 'active' }));
    expect(() => build(root)).toThrow('조직 사본 검사 실패');
  });
});

/* ───────────── validateOrgShape ───────────── */

describe('validateOrgShape', () => {
  const bundled = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/data/org.json', import.meta.url)), 'utf8'));
  const clone = () => structuredClone(bundled);

  it('번들된 org.json 사본은 통과한다', () => {
    expect(validateOrgShape(bundled)).toEqual([]);
  });

  it('id 중복·없는 본부/팀 참조·본부 표기 불일치·확장 대기의 없는 팀을 잡는다', () => {
    const org = clone();
    org.depts.push({ ...org.depts[0] });
    org.teams.push({ ...org.teams[0] });
    org.staff.push({ ...org.staff[0] });
    org.hq.push({ ...org.hq[0] });
    org.teams[1].dept = 'no-such-dept';
    org.staff[1].team = 'no-such-team';
    org.staff[2].dept = 'zz';
    org.expansion.push({ team: 'no-such-team', role: 'x', trigger: 'y' });
    const problems = validateOrgShape(org);
    expect(problems.some((p) => p.startsWith('본부 id 중복'))).toBe(true);
    expect(problems.some((p) => p.startsWith('팀 id 중복'))).toBe(true);
    expect(problems.some((p) => p.startsWith('직원 id 중복'))).toBe(true);
    expect(problems.some((p) => p.startsWith('AI 총괄 id 중복'))).toBe(true);
    expect(problems.some((p) => p.includes('본부 no-such-dept 없음'))).toBe(true);
    expect(problems.some((p) => p.includes('팀 no-such-team 없음'))).toBe(true);
    expect(problems.some((p) => p.includes('본부 표기 불일치'))).toBe(true);
    expect(problems.some((p) => p.includes('확장 대기 직책의 팀'))).toBe(true);
  });

  it('meta.counts가 실제 개수와 다르면 잡는다', () => {
    const org = clone();
    org.meta.counts.staff += 1;
    expect(validateOrgShape(org)).toContain('meta.counts가 실제 개수와 다름');
  });

  it('공개 검사에 걸리는 글자가 있으면 잡는다(source_hash 칸은 보지 않는다)', () => {
    const org = clone();
    org.ceo.title = j('연락처 ', 'someone', '@', 'example.com');
    expect(validateOrgShape(org).some((p) => p.startsWith('공개 검사 위반'))).toBe(true);
    const ok = clone();
    ok.meta.source_hash = 'a'.repeat(64);
    expect(validateOrgShape(ok)).toEqual([]);
  });
});

/* ───────────── 공개 검사 규칙·도우미 ───────────── */

describe('lintPublic / PUBLIC_RULES', () => {
  const samples = {
    '드라이브 경로': j('D', ':', '\\', 'tmp'),
    '역슬래시 경로': j('a', '\\', 'b', '\\', 'c.txt'),
    '홈 폴더 경로': j('/', 'home', '/', 'x'),
    '내부 폴더 이름': j('MY', ' ', 'OS'),
    '내부 상대 경로': j(' work', '/', 'cards/1.md'),
    '메일 주소': j('a', '@', 'b.co'),
    '평가 정답 폴더 경로': j('holdout', '/'),
    '비밀값 모양': j('gh', 'p_', 'abcdefghijkl'),
    '개인 키': j('-----BEGIN ', 'PRIVATE KEY-----'),
    '긴 16진 문자열': 'a'.repeat(40),
    '주민등록번호 모양': j('900101', '-', '1234567'),
    '휴대폰 번호 모양': j('010', '-', '1234', '-', '5678'),
  };

  it('규칙마다 이름이 있고, 아래 모든 규칙을 시험한다', () => {
    expect(PUBLIC_RULES.map(([, why]) => why).sort()).toEqual(Object.keys(samples).sort());
  });

  for (const [rule, sample] of Object.entries(samples)) {
    it(`${rule}: 해당 모양을 찾는다`, () => {
      expect(lintPublic(sample)).toContain(rule);
      expect(lintPublic(`앞 문장입니다. ${sample} 뒤 문장입니다.`)).toContain(rule);
    });
  }

  it('보통 글자는 통과한다', () => {
    for (const ok of ['', '시황 자료 수집', 'Claude + Codex 독립 검사', 'inv-01-e01', '2026-10-17T09:00:00+09:00', '업무 3건 · 완료 12건']) {
      expect(lintPublic(ok), ok).toEqual([]);
    }
  });

  it('문자열이 아닌 값도 글자로 바꿔 검사한다', () => {
    expect(lintPublic(null)).toEqual([]);
    expect(lintPublic(12345)).toEqual([]);
  });
});

describe('sanitizeText', () => {
  it('깨끗한 글자는 앞뒤 공백만 지운다. null·undefined는 빈 글자', () => {
    const report = [];
    expect(sanitizeText('  시황 자료  ', 'w', report)).toBe('시황 자료');
    expect(sanitizeText(null, 'w', report)).toBe('');
    expect(sanitizeText(undefined, 'w', report)).toBe('');
    expect(report).toEqual([]);
  });

  it('괄호 조각을 지우고 남은 글자가 깨끗하면 쓴다(공백은 하나로)', () => {
    const report = [];
    expect(sanitizeText(`수집 (${j('a', '@', 'b.co')}) 담당`, 'where-1', report)).toBe('수집 담당');
    expect(report).toEqual([{ where: 'where-1', rules: ['메일 주소'], action: '괄호 조각 삭제' }]);
  });

  it('괄호 밖에 위반이 있거나 지우고 나면 빈 글자면 통째로 생략', () => {
    const report = [];
    expect(sanitizeText(j('x', '@', 'y.co'), 'a', report)).toBe('(공개 사본에서 생략)');
    expect(sanitizeText(`(${j('x', '@', 'y.co')})`, 'b', report)).toBe('(공개 사본에서 생략)');
    expect(report.map((r) => r.action)).toEqual(['공개 사본에서 생략', '공개 사본에서 생략']);
  });

  it('괄호 안이 깨끗하면 그대로 둔다', () => {
    const report = [];
    expect(sanitizeText(`분석 (보조) ${j('x', '@', 'y.co')}`, 'c', report)).toBe('(공개 사본에서 생략)');
    expect(sanitizeText('분석 (보조)', 'd', report)).toBe('분석 (보조)');
  });
});

describe('splitNote', () => {
  it('머리말(YAML)과 본문을 나눈다', () => {
    const text = ['---', 'a: 1', 'b: 글자', '---', '본문 첫 줄', '둘째 줄'].join('\n');
    expect(splitNote(text)).toEqual({ fm: { a: 1, b: '글자' }, body: ['본문 첫 줄', '둘째 줄'].join('\n') });
  });

  it('CRLF도 읽는다. 머리말이 비어 있으면 빈 객체', () => {
    expect(splitNote(['---', 'id: x', '---', '본문'].join('\r\n'))).toEqual({ fm: { id: 'x' }, body: '본문' });
    expect(splitNote(['---', '', '---', '본문'].join('\n')).fm).toEqual({});
  });

  it('머리말이 없으면 fm은 null이고 본문은 전체', () => {
    expect(splitNote('그냥 글')).toEqual({ fm: null, body: '그냥 글' });
  });
});

describe('sectionTable / sectionBullets', () => {
  const body = [
    '앞 글', '', '## 대표 몫 (참고)', '| 업무 | 내용 |', '|---|---|', '| a | 하나 |', '| b | 둘 |', '',
    '## 목록', '- 첫째', '  - 들여쓴 항목', '- 둘째', '글 한 줄', '', '## 마지막', '| x | y |', '|---|---|', '| 1 | 2 |',
  ].join('\n');

  it('표: 제목이 그 글자로 시작하는 절에서 머리줄·구분줄을 빼고 칸을 나눈다', () => {
    expect(sectionTable(body, '대표 몫')).toEqual([['a', '하나'], ['b', '둘']]);
    expect(sectionTable(body, '마지막')).toEqual([['1', '2']]);
  });

  it('없는 절은 null, 표가 없는 절은 빈 배열', () => {
    expect(sectionTable(body, '없는 절')).toBeNull();
    expect(sectionBullets(body, '없는 절')).toBeNull();
    expect(sectionTable(body, '목록')).toEqual([]);
  });

  it('목록: `- ` 줄만(들여쓴 것 포함), 다음 `## ` 절 앞에서 끝난다', () => {
    expect(sectionBullets(body, '목록')).toEqual(['첫째', '들여쓴 항목', '둘째']);
  });
});

describe('parseExecutors', () => {
  it('글자 속 실행 주체 이름을 찾아 고정된 순서로 돌려준다', () => {
    expect(parseExecutors('Aside + Claude')).toEqual(['claude', 'aside']);
    expect(parseExecutors('사람 확인 후 스크립트, Codex')).toEqual(['codex', 'script', 'human']);
    expect(parseExecutors('')).toEqual([]);
    expect(parseExecutors(undefined)).toEqual([]);
    expect(parseExecutors('미정')).toEqual([]);
  });
});

describe('loadLocalEnv', () => {
  it('.env 와 .env.local 을 읽고(뒤 파일이 앞 파일을 덮는다) 주석·이상한 줄은 건너뛰며 따옴표를 벗긴다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-env-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, '.env'), ['# 주석', 'PBAI_A=1', 'PBAI_B = "두 단어"', "PBAI_C='x'", 'lower=no', 'PBAI_D=  뒤공백  ', '이상한 줄', ''].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, '.env.local'), 'PBAI_A=2\r\nPBAI_E=5\r\n', 'utf8');
    expect(loadLocalEnv(root)).toEqual({ PBAI_A: '2', PBAI_B: '두 단어', PBAI_C: 'x', PBAI_D: '뒤공백', PBAI_E: '5' });
  });

  it('파일이 없으면 빈 객체', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-env-'));
    dirs.push(root);
    expect(loadLocalEnv(root)).toEqual({});
  });
});
