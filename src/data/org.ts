// 조직 사본 읽기·검사·색인. 사본은 Wiki 정본에서 만든 생성물(scripts/sync-org.mjs)이고,
// 개발 서버는 /__pbai/org로 정본을 바로 준다. 숫자(본부·팀·직원 수)는 고정하지 않는다(docs/DECISIONS.md D-3).
import { z } from 'zod';
import bundledOrg from './org.json';
import { CEO_ID, DEPT_COLOR_SLOTS, UNASSIGNED_PREFIX } from '../types';
import type { Org, OrgDept, OrgExpansion, OrgIndex, OrgStaff, OrgTeam } from '../types';

const executor = z.enum(['claude', 'codex', 'aside', 'script', 'human']);
const opStatus = z.enum(['active', 'building', 'planned', 'paused']);
const phase = z.enum(['P0', 'P1', 'P2']).nullable();
const risk = z.enum(['R0', 'R1', 'R2']).nullable();
const text = z.string();

export const OrgSchema = z.object({
  format: z.literal(1),
  meta: z.object({
    generated_at: text,
    source: z.enum(['wiki', 'fixture']),
    source_hash: text,
    counts: z.object({ depts: z.number().int(), teams: z.number().int(), staff: z.number().int(), expansion: z.number().int() }),
  }),
  ceo: z.object({ title: text, holds: z.array(text), owner_only: z.array(z.object({ task: text, title: text })) }),
  hq: z.array(z.object({ id: text, name: text, executor, role: text })),
  depts: z.array(z.object({ id: text, name: text, head: text, role: text })),
  teams: z.array(z.object({ id: text, dept: text, name: text, role: text, status: opStatus, phase })),
  staff: z.array(
    z.object({
      id: text, team: text, dept: text, name: text, role: text, status: opStatus, phase, risk,
      executors: z.array(executor), checkers: z.array(executor), checker_staff: z.array(text),
      duties: z.array(z.object({ id: text, title: text })),
    }),
  ),
  expansion: z.array(z.object({ team: text, role: text, trigger: text })),
  legacy: z.object({ teams: z.record(text, text), depts: z.record(text, text) }),
});

export class OrgError extends Error {}

/** 무결성 검사: 표시 개수 = 실제 개수, id 중복 없음, 모든 참조가 맞음. 문제 목록(비면 통과). */
export function checkOrg(org: Org): string[] {
  const problems: string[] = [];
  const actual = { depts: org.depts.length, teams: org.teams.length, staff: org.staff.length, expansion: org.expansion.length };
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    if (org.meta.counts[key] !== actual[key]) problems.push(`개수 불일치: ${key} 표시 ${org.meta.counts[key]} / 실제 ${actual[key]}`);
  }
  const seen = new Set<string>();
  for (const id of [CEO_ID, ...org.hq.map((h) => h.id), ...org.depts.map((d) => d.id), ...org.teams.map((t) => t.id), ...org.staff.map((s) => s.id)]) {
    if (seen.has(id)) problems.push(`id 중복: ${id}`);
    seen.add(id);
  }
  const depts = new Set(org.depts.map((d) => d.id));
  const teams = new Map(org.teams.map((t) => [t.id, t]));
  const staff = new Set(org.staff.map((s) => s.id));
  for (const t of org.teams) if (!depts.has(t.dept)) problems.push(`팀 ${t.id}: 없는 본부 ${t.dept}`);
  for (const s of org.staff) {
    const team = teams.get(s.team);
    if (!team) problems.push(`직원 ${s.id}: 없는 팀 ${s.team}`);
    else if (team.dept !== s.dept) problems.push(`직원 ${s.id}: 본부 ${s.dept}가 팀의 본부 ${team.dept}와 다름`);
    for (const c of s.checker_staff) if (!staff.has(c)) problems.push(`직원 ${s.id}: 없는 검증자 ${c}`);
  }
  for (const e of org.expansion) if (!teams.has(e.team)) problems.push(`확장 대기 '${e.role}': 없는 팀 ${e.team}`);
  return problems;
}

/** 형식(zod) + 무결성 검사. 어긋나면 OrgError. */
export function parseOrg(input: unknown): Org {
  const result = OrgSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new OrgError(`조직 사본 형식 오류 — ${where}`);
  }
  const org = result.data as Org;
  const problems = checkOrg(org);
  if (problems.length) throw new OrgError(`조직 사본 검사 실패(${problems.length}건) — ${problems.slice(0, 5).join('; ')}`);
  return org;
}

/** 본부 색 슬롯: 정해 둔 슬롯(DEPT_COLOR_SLOTS) → 새 본부는 빈 슬롯(7, 8, 그다음 1~6) 순. 다 차면 0(무채색). */
export function assignDeptSlots(depts: OrgDept[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const d of depts) {
    const slot = DEPT_COLOR_SLOTS[d.id];
    if (slot && !used.has(slot)) { out.set(d.id, slot); used.add(slot); }
  }
  for (const d of depts) {
    if (out.has(d.id)) continue;
    const slot = [7, 8, 1, 2, 3, 4, 5, 6].find((s) => !used.has(s)) ?? 0;
    out.set(d.id, slot);
    if (slot) used.add(slot);
  }
  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function indexOrg(org: Org): OrgIndex {
  const staff = new Map<string, OrgStaff>(org.staff.map((s) => [s.id, s]));
  const teams = new Map<string, OrgTeam>(org.teams.map((t) => [t.id, t]));
  const depts = new Map<string, OrgDept>(org.depts.map((d) => [d.id, d]));
  const hq = new Map(org.hq.map((h) => [h.id, h]));
  const dutyHolder = new Map<string, string>();
  for (const s of org.staff) for (const d of s.duties) if (!dutyHolder.has(d.id)) dutyHolder.set(d.id, s.id);
  return {
    org,
    staff,
    teams,
    depts,
    teamsByDept: groupBy<OrgTeam>(org.teams, (t) => t.dept),
    staffByTeam: groupBy<OrgStaff>(org.staff, (s) => s.team),
    expansionByTeam: groupBy<OrgExpansion>(org.expansion, (e) => e.team),
    dutyHolder,
    deptSlot: assignDeptSlots(org.depts),
    actorName(id) {
      const s = staff.get(id);
      if (s) return s.name;
      if (id === CEO_ID) return org.ceo.title;
      const h = hq.get(id);
      if (h) return h.name;
      if (id.startsWith(UNASSIGNED_PREFIX)) return `미배정: ${id.slice(UNASSIGNED_PREFIX.length)}`;
      return `조직에 없는 id(${id})`;
    },
    actorDept(id) {
      return staff.get(id)?.dept ?? null;
    },
    resolveTeam(id) {
      let cur: string | undefined = id;
      for (let hop = 0; cur && hop < 5; hop++) {
        if (teams.has(cur)) return cur;
        cur = org.legacy.teams[cur];
      }
      return null;
    },
  };
}

export interface LoadedOrg { org: Org; origin: 'live' | 'bundled'; note: string | null }

/** 개발 서버(npm run dev)면 Wiki 정본을 바로 읽고(/__pbai/org), 없거나 실패하면 저장소 사본을 쓴다. 배포 사이트는 사본만. */
export async function loadOrg(): Promise<LoadedOrg> {
  let note: string | null = null;
  if (import.meta.env.DEV) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}__pbai/org`, { cache: 'no-store' });
      if (res.ok) return { org: parseOrg(await res.json()), origin: 'live', note: null };
      if (res.status !== 404) note = `Wiki 실시간 조직을 읽지 못해 저장된 사본을 씁니다(HTTP ${res.status})`;
    } catch (e) {
      note = `Wiki 실시간 조직 오류로 저장된 사본을 씁니다: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { org: parseOrg(bundledOrg), origin: 'bundled', note };
}
