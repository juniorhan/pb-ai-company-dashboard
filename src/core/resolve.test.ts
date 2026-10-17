import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { CEO_ID } from '../types';
import { isKnownActorId, resolveActor } from './resolve';

const org = parseOrg(bundledOrg);
const index = indexOrg(org);
const [first, second] = org.staff;
const [dutyId, holderId] = [...index.dutyHolder.entries()][0]!;
const team = org.teams.find((t) => (index.staffByTeam.get(t.id) ?? []).length > 0)!;
const teamFirst = index.staffByTeam.get(team.id)![0]!;

describe('resolveActor — 문자열', () => {
  it('대표·AI 총괄·조직 직원 id는 그대로(ok)', () => {
    expect(resolveActor(CEO_ID, index)).toEqual({ id: CEO_ID, ok: true });
    for (const h of org.hq) expect(resolveActor(h.id, index)).toEqual({ id: h.id, ok: true });
    expect(resolveActor(first!.id, index)).toEqual({ id: first!.id, ok: true });
  });

  it('모르는 id는 unassigned:<문자열> (ok false). 이미 접두어가 있으면 겹쳐 붙이지 않는다', () => {
    expect(resolveActor('zzz-99-e01', index)).toEqual({ id: 'unassigned:zzz-99-e01', ok: false });
    expect(resolveActor('unassigned:rsc-99-T01', index)).toEqual({ id: 'unassigned:rsc-99-T01', ok: false });
    expect(resolveActor('', index)).toEqual({ id: 'unassigned:', ok: false });
  });
});

describe('resolveActor — 객체', () => {
  it('① 업무를 맡은 직원이 먼저', () => {
    expect(resolveActor({ duty: dutyId }, index)).toEqual({ id: holderId, ok: true });
    expect(resolveActor({ duty: dutyId, staff: second!.id, team: team.id }, index)).toEqual({ id: holderId, ok: true });
  });

  it('② 업무를 못 찾으면 직원, ③ 직원도 없으면 팀의 첫 직원', () => {
    expect(resolveActor({ duty: 'NO-SUCH-DUTY', staff: second!.id, team: team.id }, index)).toEqual({ id: second!.id, ok: true });
    expect(resolveActor({ duty: 'NO-SUCH-DUTY', staff: 'zzz-99-e99', team: team.id }, index)).toEqual({ id: teamFirst.id, ok: true });
    expect(resolveActor({ staff: second!.id }, index)).toEqual({ id: second!.id, ok: true });
    expect(resolveActor({ team: team.id }, index)).toEqual({ id: teamFirst.id, ok: true });
  });

  it('옛 팀 id는 승계 팀으로 바꿔서 그 팀의 첫 직원', () => {
    const withLegacy = indexOrg({ ...org, legacy: { ...org.legacy, teams: { ...org.legacy.teams, 'old-01': 'old-02', 'old-02': team.id } } });
    expect(resolveActor({ team: 'old-01' }, withLegacy)).toEqual({ id: teamFirst.id, ok: true });
    expect(resolveActor({ team: 'old-02' }, withLegacy)).toEqual({ id: teamFirst.id, ok: true });
  });

  it('④ 아무것도 못 찾으면 unassigned:(업무 → 직원 → 팀 순으로 이름을 붙인다)', () => {
    expect(resolveActor({ duty: 'rsc-99-T01', staff: 'zzz-99-e99', team: 'zzz-99' }, index)).toEqual({ id: 'unassigned:rsc-99-T01', ok: false });
    expect(resolveActor({ staff: 'zzz-99-e99', team: 'zzz-99' }, index)).toEqual({ id: 'unassigned:zzz-99-e99', ok: false });
    expect(resolveActor({ team: 'zzz-99' }, index)).toEqual({ id: 'unassigned:zzz-99', ok: false });
    expect(resolveActor({}, index)).toEqual({ id: 'unassigned:?', ok: false });
  });

  it('직원이 없는 팀은 못 찾은 것으로 본다', () => {
    const emptyTeam = { ...org, teams: [...org.teams, { id: `${org.depts[0]!.id}-98`, dept: org.depts[0]!.id, name: '빈 팀', role: '', status: 'planned' as const, phase: null }] };
    emptyTeam.meta = { ...org.meta, counts: { ...org.meta.counts, teams: org.teams.length + 1 } };
    const idx = indexOrg(emptyTeam);
    expect(resolveActor({ team: `${org.depts[0]!.id}-98` }, idx)).toEqual({ id: `unassigned:${org.depts[0]!.id}-98`, ok: false });
  });

  it('직원이 바뀌어도 업무로 지정한 행위자는 따라간다(조직 유연성)', () => {
    const moved = structuredClone(org);
    const from = moved.staff.find((s) => s.id === holderId)!;
    const to = moved.staff.find((s) => s.id !== holderId && s.duties.length >= 0)!;
    const duty = from.duties.find((d) => d.id === dutyId)!;
    from.duties = from.duties.filter((d) => d.id !== dutyId);
    to.duties = [duty, ...to.duties];
    const idx = indexOrg(moved);
    expect(resolveActor({ duty: dutyId }, idx)).toEqual({ id: to.id, ok: true });
  });
});

describe('isKnownActorId', () => {
  it('대표·AI 총괄·직원만 true', () => {
    expect(isKnownActorId(CEO_ID, index)).toBe(true);
    expect(isKnownActorId(org.hq[0]!.id, index)).toBe(true);
    expect(isKnownActorId(first!.id, index)).toBe(true);
    expect(isKnownActorId('unassigned:x', index)).toBe(false);
    expect(isKnownActorId(team.id, index)).toBe(false);
    expect(isKnownActorId('', index)).toBe(false);
  });
});
