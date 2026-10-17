// 조직 사본(org.json) 검사. 본부·팀·직원 수를 코드에 박지 않는다 — 사본의 표시 개수가 실제 개수와 같고 모든 참조가 맞는지만 본다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import bundledOrg from './org.json';
import { OrgError, assignDeptSlots, checkOrg, indexOrg, loadOrg, parseOrg } from './org';
import { CEO_ID, DEPT_COLOR_SLOTS } from '../types';
import type { Org, OrgDept } from '../types';

const fresh = (): Org => structuredClone(bundledOrg) as unknown as Org;
const dept = (id: string): OrgDept => ({ id, name: id, head: '본부장', role: '' });

describe('번들 조직 사본', () => {
  it('parseOrg를 통과한다', () => {
    const org = parseOrg(bundledOrg);
    expect(org.format).toBe(1);
    expect(org.depts.length).toBeGreaterThan(0);
    expect(org.teams.length).toBeGreaterThan(0);
    expect(org.staff.length).toBeGreaterThan(0);
  });

  it('meta.counts는 실제 개수와 같다', () => {
    const org = parseOrg(bundledOrg);
    expect(org.meta.counts).toEqual({ depts: org.depts.length, teams: org.teams.length, staff: org.staff.length, expansion: org.expansion.length });
    expect(checkOrg(org)).toEqual([]);
  });

  it('id가 겹치지 않고 모든 참조(팀→본부, 직원→팀·본부, 검증자→직원, 확장 대기→팀)가 맞는다', () => {
    const org = parseOrg(bundledOrg);
    const ids = [CEO_ID, ...org.hq.map((h) => h.id), ...org.depts.map((d) => d.id), ...org.teams.map((t) => t.id), ...org.staff.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const deptIds = new Set(org.depts.map((d) => d.id));
    const teamById = new Map(org.teams.map((t) => [t.id, t]));
    const staffIds = new Set(org.staff.map((s) => s.id));
    for (const t of org.teams) expect(deptIds.has(t.dept), `팀 ${t.id}`).toBe(true);
    for (const s of org.staff) {
      expect(teamById.get(s.team)?.dept, `직원 ${s.id}`).toBe(s.dept);
      for (const c of s.checker_staff) expect(staffIds.has(c), `직원 ${s.id}의 검증자 ${c}`).toBe(true);
    }
    for (const e of org.expansion) expect(teamById.has(e.team), `확장 대기 ${e.role}`).toBe(true);
  });

  it('모든 팀에 본부가 있고 직원이 없는 팀은 없다(조직 구성 점검)', () => {
    const org = parseOrg(bundledOrg);
    for (const t of org.teams) expect(org.staff.some((s) => s.team === t.id), `팀 ${t.id}`).toBe(true);
  });
});

describe('깨진 사본은 OrgError', () => {
  const bad = (mutate: (org: Org) => void): OrgError => {
    const org = fresh();
    mutate(org);
    try {
      parseOrg(org);
    } catch (e) {
      expect(e).toBeInstanceOf(OrgError);
      return e as OrgError;
    }
    throw new Error('OrgError가 나지 않았습니다');
  };

  it('개수 조작', () => {
    expect(bad((o) => { o.meta.counts.staff += 1; }).message).toContain('개수 불일치');
    expect(bad((o) => { o.meta.counts.depts -= 1; }).message).toContain('개수 불일치');
    expect(bad((o) => { o.meta.counts.teams = 0; }).message).toContain('개수 불일치');
    expect(bad((o) => { o.meta.counts.expansion += 3; }).message).toContain('개수 불일치');
  });

  it('없는 팀 참조(직원→팀)', () => {
    const e = bad((o) => { o.staff[0]!.team = 'zzz-99'; });
    expect(e.message).toContain('없는 팀');
  });

  it('없는 본부 참조(팀→본부)', () => {
    const e = bad((o) => { o.teams[0]!.dept = 'zzz'; });
    expect(e.message).toContain('없는 본부');
  });

  it('직원의 본부가 팀의 본부와 다름', () => {
    const e = bad((o) => {
      const other = o.depts.find((d) => d.id !== o.staff[0]!.dept)!;
      o.staff[0]!.dept = other.id;
    });
    expect(e.message).toContain('본부');
  });

  it('없는 검증자 참조', () => {
    const e = bad((o) => { o.staff[0]!.checker_staff = ['zzz-99-e99']; });
    expect(e.message).toContain('없는 검증자');
  });

  it('없는 팀을 가리키는 확장 대기 직책', () => {
    const e = bad((o) => { o.expansion.push({ team: 'zzz-99', role: '가상 직책', trigger: '없음' }); o.meta.counts.expansion += 1; });
    expect(e.message).toContain('없는 팀');
  });

  it('id 중복(직원끼리, 직원과 팀)', () => {
    expect(bad((o) => { o.staff[1]!.id = o.staff[0]!.id; }).message).toContain('id 중복');
    expect(bad((o) => { o.staff[0]!.id = o.teams[0]!.id; }).message).toContain('id 중복');
    expect(bad((o) => { o.hq[0]!.id = CEO_ID; }).message).toContain('id 중복');
  });

  it('형식 오류(zod)', () => {
    expect(() => parseOrg({ ...fresh(), format: 2 })).toThrow(OrgError);
    expect(() => parseOrg({})).toThrow(OrgError);
    expect(() => parseOrg(null)).toThrow(OrgError);
    const noStaff = fresh() as unknown as Record<string, unknown>;
    delete noStaff.staff;
    expect(() => parseOrg(noStaff)).toThrow(/형식 오류/);
    const badStatus = fresh();
    (badStatus.staff[0] as unknown as { status: string }).status = 'retired';
    expect(() => parseOrg(badStatus)).toThrow(OrgError);
  });
});

describe('indexOrg', () => {
  const org = parseOrg(bundledOrg);
  const index = indexOrg(org);

  it('색인의 크기가 사본과 같다', () => {
    expect(index.staff.size).toBe(org.staff.length);
    expect(index.teams.size).toBe(org.teams.length);
    expect(index.depts.size).toBe(org.depts.length);
    expect([...index.teamsByDept.values()].flat()).toHaveLength(org.teams.length);
    expect([...index.staffByTeam.values()].flat()).toHaveLength(org.staff.length);
    expect([...index.expansionByTeam.values()].flat()).toHaveLength(org.expansion.length);
  });

  it('업무 id → 직원 id: 담당 직원이 그 업무를 가진다', () => {
    expect(index.dutyHolder.size).toBeGreaterThan(0);
    for (const [duty, staffId] of index.dutyHolder) {
      expect(index.staff.get(staffId)!.duties.some((d) => d.id === duty), duty).toBe(true);
    }
  });

  it('본부 색 슬롯은 모든 본부에 하나씩, 겹치지 않는다', () => {
    const slots = org.depts.map((d) => index.deptSlot.get(d.id));
    expect(slots.every((s) => typeof s === 'number')).toBe(true);
    const real = slots.filter((s) => s !== 0);
    expect(new Set(real).size).toBe(real.length);
  });

  it('actorName: 대표·AI 총괄·직원·미배정·모르는 id', () => {
    expect(index.actorName(CEO_ID)).toBe(org.ceo.title);
    expect(index.actorName(org.hq[0]!.id)).toBe(org.hq[0]!.name);
    expect(index.actorName(org.staff[0]!.id)).toBe(org.staff[0]!.name);
    expect(index.actorName('unassigned:rsc-99-T01')).toBe('미배정: rsc-99-T01');
    expect(index.actorName('zzz-99')).toBe('조직에 없는 id(zzz-99)');
  });

  it('actorDept: 직원은 본부, 그 밖은 null', () => {
    expect(index.actorDept(org.staff[0]!.id)).toBe(org.staff[0]!.dept);
    expect(index.actorDept(CEO_ID)).toBeNull();
    expect(index.actorDept(org.hq[0]!.id)).toBeNull();
    expect(index.actorDept('zzz')).toBeNull();
  });

  it('resolveTeam: 현재 팀은 그대로, 옛 팀은 승계 팀으로(여러 단계도), 모르면 null', () => {
    const team = org.teams[0]!.id;
    const withLegacy = indexOrg({ ...org, legacy: { ...org.legacy, teams: { 'old-01': team, 'old-02': 'old-01', 'loop-a': 'loop-b', 'loop-b': 'loop-a' } } });
    expect(withLegacy.resolveTeam(team)).toBe(team);
    expect(withLegacy.resolveTeam('old-01')).toBe(team);
    expect(withLegacy.resolveTeam('old-02')).toBe(team);
    expect(withLegacy.resolveTeam('nobody')).toBeNull();
    expect(withLegacy.resolveTeam('loop-a')).toBeNull();     // 돌고 도는 승계 표도 멈춘다
  });
});

describe('assignDeptSlots', () => {
  it('정해 둔 본부는 정해 둔 슬롯', () => {
    const out = assignDeptSlots(Object.keys(DEPT_COLOR_SLOTS).map(dept));
    for (const [id, slot] of Object.entries(DEPT_COLOR_SLOTS)) expect(out.get(id)).toBe(slot);
  });

  it('새 본부는 빈 슬롯 7, 8 순서로 받고, 다 차면 남은 슬롯, 그래도 모자라면 0', () => {
    const known = Object.keys(DEPT_COLOR_SLOTS).map(dept);
    const extra = ['n1', 'n2', 'n3'].map(dept);
    const out = assignDeptSlots([...known, ...extra]);
    expect(out.get('n1')).toBe(7);
    expect(out.get('n2')).toBe(8);
    expect(out.get('n3')).toBe(0);                           // 정해 둔 슬롯이 이미 다 쓰이고 있다
    const fewer = assignDeptSlots([dept('ops'), ...['n1', 'n2', 'n3'].map(dept)]);
    expect(fewer.get('ops')).toBe(DEPT_COLOR_SLOTS.ops);
    expect(fewer.get('n1')).toBe(7);
    expect(fewer.get('n2')).toBe(8);
    expect(fewer.get('n3')).toBe(2);                         // 7, 8 다음은 1부터 빈 슬롯(1은 ops)
  });
});

describe('loadOrg (개발 서버의 실시간 조직 → 없으면 사본)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const reply = (status: number, body: unknown = {}): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  it('이 시험은 개발 모드(import.meta.env.DEV)에서 돈다', () => {
    expect(import.meta.env.DEV).toBe(true);
  });

  it('404면 조용히 사본', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404)));
    const r = await loadOrg();
    expect(r.origin).toBe('bundled');
    expect(r.note).toBeNull();
  });

  it('서버 오류·네트워크 오류면 사본 + 이유', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(500)));
    const a = await loadOrg();
    expect(a.origin).toBe('bundled');
    expect(a.note).toContain('HTTP 500');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    const b = await loadOrg();
    expect(b.origin).toBe('bundled');
    expect(b.note).toContain('network down');
  });

  it('정상 응답이면 실시간 조직', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, bundledOrg)));
    const r = await loadOrg();
    expect(r.origin).toBe('live');
    expect(r.org.staff.length).toBe(bundledOrg.staff.length);
  });

  it('응답이 깨져 있으면 사본 + 이유', async () => {
    const broken = fresh();
    broken.meta.counts.staff += 1;
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, broken)));
    const r = await loadOrg();
    expect(r.origin).toBe('bundled');
    expect(r.note).toContain('개수 불일치');
  });
});
