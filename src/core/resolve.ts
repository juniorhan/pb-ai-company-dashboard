// ActorRef(시나리오의 행위자 지정) → 행위자 id. 업무 → 직원 → 팀(옛 팀 id는 승계) 순으로 찾고, 못 찾으면 '미배정'(docs/DESIGN.md §5, D-5).
import { CEO_ID, UNASSIGNED_PREFIX } from '../types';
import type { ActorRef, OrgIndex } from '../types';

export interface ResolvedActor { id: string; ok: boolean }

/** 대표·AI 총괄·조직 직원으로 있는 id인가 */
export function isKnownActorId(id: string, index: OrgIndex): boolean {
  return id === CEO_ID || index.staff.has(id) || index.org.hq.some((h) => h.id === id);
}

export function resolveActor(ref: ActorRef, index: OrgIndex): ResolvedActor {
  if (typeof ref === 'string') {
    if (isKnownActorId(ref, index)) return { id: ref, ok: true };
    return { id: ref.startsWith(UNASSIGNED_PREFIX) ? ref : `${UNASSIGNED_PREFIX}${ref}`, ok: false };
  }
  if (ref.duty) {
    const holder = index.dutyHolder.get(ref.duty);
    if (holder) return { id: holder, ok: true };
  }
  if (ref.staff && index.staff.has(ref.staff)) return { id: ref.staff, ok: true };
  if (ref.team) {
    const team = index.resolveTeam(ref.team);
    const first = team ? index.staffByTeam.get(team)?.[0] : undefined;
    if (first) return { id: first.id, ok: true };
  }
  return { id: `${UNASSIGNED_PREFIX}${ref.duty ?? ref.staff ?? ref.team ?? '?'}`, ok: false };
}
