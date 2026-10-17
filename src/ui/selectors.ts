// 화면용 파생값(요약·필터·표시 문구). 전부 순수 함수 — 같은 상태를 넣으면 같은 값이 나온다.
import { EVENT_LABEL, EXECUTORS, HANDOFF_LABEL, OP_STATUS_LABEL, STAFF_STATUS_LABEL, STAFF_STATUSES, UNASSIGNED_PREFIX } from '../types';
import type {
  ApprovalState, DashboardState, Executor, FeedItem, HandoffKind, OpStatus, OrgIndex, OrgStaff, PbEvent, StaffStatus, TaskState, TaskStatus,
} from '../types';
import { parseTs } from './format';

/** 요약 띠·AI 총괄에 보여 주는 실행 주체(대표는 사람이라 제외). */
export const AI_EXECUTORS: Executor[] = EXECUTORS.filter((e) => e !== 'human');
export const FEED_LIMIT = 200;

/* ───────────── 요약 ───────────── */

export function emptyStatusCounts(): Record<StaffStatus, number> {
  const out = {} as Record<StaffStatus, number>;
  for (const s of STAFF_STATUSES) out[s] = 0;
  return out;
}

/** 상태별 인원 — 조직 직원 전원 기준(상태 기록이 없는 직원은 대기). 대표·AI 총괄·미배정은 세지 않는다. */
export function staffStatusCounts(index: OrgIndex, state: DashboardState, deptId?: string): Record<StaffStatus, number> {
  const out = emptyStatusCounts();
  for (const s of index.org.staff) {
    if (deptId !== undefined && s.dept !== deptId) continue;
    out[state.staff[s.id]?.status ?? 'idle'] += 1;
  }
  return out;
}

export function isOpenTask(task: TaskState): boolean {
  return task.status !== 'completed' && task.status !== 'rejected';
}

/** 진행 중 작업 수 — 완료·반려 종료를 뺀 전부(막힘·승인 대기 포함). */
export function openTaskCount(state: DashboardState): number {
  let n = 0;
  for (const id in state.tasks) if (isOpenTask(state.tasks[id]!)) n += 1;
  return n;
}

/** 승인 대기 목록 — 요청 시각 순(같으면 id 순). */
export function pendingApprovals(state: DashboardState): ApprovalState[] {
  const list: ApprovalState[] = [];
  for (const id in state.approvals) if (state.approvals[id]!.status === 'pending') list.push(state.approvals[id]!);
  return list.sort((a, b) => (parseTs(a.requestedAt) ?? 0) - (parseTs(b.requestedAt) ?? 0) || a.id.localeCompare(b.id));
}

/** 최근 결정 — 결정 시각이 늦은 것부터. */
export function recentDecisions(state: DashboardState, limit = 3): ApprovalState[] {
  const list: ApprovalState[] = [];
  for (const id in state.approvals) if (state.approvals[id]!.status !== 'pending') list.push(state.approvals[id]!);
  return list
    .sort((a, b) => (parseTs(b.decidedAt) ?? 0) - (parseTs(a.decidedAt) ?? 0) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

/** 막힘 수 — 막힌 작업(건). */
export function blockedTaskCount(state: DashboardState): number {
  let n = 0;
  for (const id in state.tasks) if (state.tasks[id]!.status === 'blocked') n += 1;
  return n;
}

/** 실행 주체별 지금 진행 중인 작업 수(진행 중 작업의 내역이라 합이 openTaskCount와 같다). */
export function runningByExecutor(state: DashboardState): Record<Executor, number> {
  const out = {} as Record<Executor, number>;
  for (const e of EXECUTORS) out[e] = 0;
  for (const id in state.tasks) {
    const t = state.tasks[id]!;
    if (isOpenTask(t)) out[t.executor] += 1;
  }
  return out;
}

export interface ExecutorStat { executor: Executor; created: number; running: number }

/** 실행 주체별 오늘 생성 수와 지금 진행 수(AI_EXECUTORS 순서). */
export function executorStats(state: DashboardState): ExecutorStat[] {
  const running = runningByExecutor(state);
  return AI_EXECUTORS.map((executor) => ({ executor, created: state.metrics.createdByExecutor[executor] ?? 0, running: running[executor] }));
}

/** 행위자를 못 찾은 이벤트가 있는지: 조직에 없는 id(known=false) 또는 미배정 id. */
export function unassignedActors(state: DashboardState): string[] {
  const out: string[] = [];
  for (const id in state.staff) {
    if (!state.staff[id]!.known || id.startsWith(UNASSIGNED_PREFIX)) out.push(id);
  }
  return out.sort();
}

/* ───────────── 직원 ───────────── */

export function statusOf(state: DashboardState, id: string): StaffStatus {
  return state.staff[id]?.status ?? 'idle';
}

/** 직원별 현재 작업. */
export function currentTaskOf(state: DashboardState, id: string): TaskState | null {
  const taskId = state.staff[id]?.currentTaskId;
  return taskId ? state.tasks[taskId] ?? null : null;
}

/** 최근 작업(최신이 앞). 사라진 작업 id는 건너뛴다. */
export function recentTasksOf(state: DashboardState, id: string, limit = 10): TaskState[] {
  const out: TaskState[] = [];
  for (const taskId of state.staff[id]?.recentTaskIds ?? []) {
    const t = state.tasks[taskId];
    if (t) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** 지금 이 실행 주체가 맡고 있는 열린 작업 — 늦게 만든 것부터 최대 limit건(AI 총괄 상세에 쓴다). */
export function openTasksOfExecutor(state: DashboardState, executor: Executor, limit = 8): TaskState[] {
  const list: TaskState[] = [];
  for (const id in state.tasks) {
    const t = state.tasks[id]!;
    if (isOpenTask(t) && t.executor === executor) list.push(t);
  }
  return list.sort((a, b) => (parseTs(b.createdAt) ?? 0) - (parseTs(a.createdAt) ?? 0) || a.id.localeCompare(b.id)).slice(0, limit);
}

/** 작업의 마지막 움직임 시각(끝 → 시작 → 생성 순). */
export function taskLastTs(task: TaskState): string {
  return task.endedAt ?? task.startedAt ?? task.createdAt;
}

/** 작업 상태 → 칩 아이콘 종류. */
export function taskIconKind(status: TaskStatus): FeedIconKind {
  switch (status) {
    case 'created':
      return 'idle';
    case 'in_progress':
      return 'working';
    case 'in_review':
      return 'reviewing';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'blocked':
      return 'blocked';
    case 'completed':
      return 'done';
    case 'rejected':
      return 'rejected';
  }
}

/** 접근성 이름: '정기 브리핑 작가, 작업 중, 모닝 브리핑 원고, 운영 중'. */
export function staffAriaLabel(staff: OrgStaff, status: StaffStatus, taskTitle: string | null): string {
  const parts = [staff.name, STAFF_STATUS_LABEL[status]];
  if (taskTitle) parts.push(taskTitle);
  parts.push(OP_STATUS_LABEL[staff.status]);
  return parts.join(', ');
}

export function opStatusLabel(status: OpStatus): string {
  return OP_STATUS_LABEL[status];
}

/* ───────────── 활동 피드 ───────────── */

export type FeedKind = 'all' | 'progress' | 'review' | 'approval' | 'blocked' | 'done' | 'status';
export const FEED_KINDS: { id: FeedKind; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'progress', label: '진행' }, { id: 'review', label: '검토' }, { id: 'approval', label: '승인' },
  { id: 'blocked', label: '막힘' }, { id: 'done', label: '완료' }, { id: 'status', label: '상태' },
];

export interface FeedFilter { depts: readonly string[]; kind: FeedKind; executors: readonly Executor[] }
export const EMPTY_FEED_FILTER: FeedFilter = { depts: [], kind: 'all', executors: [] };

export function isFeedFilterActive(f: FeedFilter): boolean {
  return f.depts.length > 0 || f.kind !== 'all' || f.executors.length > 0;
}

function payloadText(event: PbEvent, key: string): string {
  const v = event.payload?.[key];
  return typeof v === 'string' ? v : '';
}

export function feedKindOf(event: PbEvent): Exclude<FeedKind, 'all'> {
  switch (event.type) {
    case 'task_created':
    case 'task_started':
      return 'progress';
    case 'task_handoff':
      return payloadText(event, 'kind') === 'review' ? 'review' : 'progress';
    case 'task_review_requested':
      return 'review';
    case 'approval_requested':
    case 'approval_decided':
      return 'approval';
    case 'task_blocked':
      return 'blocked';
    case 'task_completed':
      return 'done';
    case 'staff_status_changed':
      return 'status';
  }
}

/** 피드 필터 — 최신이 앞, 최대 limit줄. 본부 필터는 행위자의 본부로 거른다(대표·AI 총괄은 본부가 없어 본부 필터가 켜지면 빠진다). */
export function filterFeed(feed: readonly FeedItem[], filter: FeedFilter, index: OrgIndex, limit = FEED_LIMIT): FeedItem[] {
  const depts = filter.depts.length ? new Set(filter.depts) : null;
  const executors = filter.executors.length ? new Set<Executor>(filter.executors) : null;
  const out: FeedItem[] = [];
  for (let i = feed.length - 1; i >= 0 && out.length < limit; i--) {
    const item = feed[i]!;
    const e = item.event;
    if (filter.kind !== 'all' && feedKindOf(e) !== filter.kind) continue;
    if (executors && !executors.has(e.executor)) continue;
    if (depts) {
      const d = index.actorDept(e.staff_id);
      if (!d || !depts.has(d)) continue;
    }
    out.push(item);
  }
  return out;
}

/** 피드 줄의 동작 문구 — 이벤트 종류 + payload로 만든다(예: '→ 편집장에게 전달', '검토 요청 → 독립 검사관'). */
export function describeEvent(event: PbEvent, index: OrgIndex): string {
  switch (event.type) {
    case 'task_created':
      return EVENT_LABEL.task_created;
    case 'task_started':
      return EVENT_LABEL.task_started;
    case 'task_handoff': {
      const to = payloadText(event, 'to');
      const kind = (payloadText(event, 'kind') || 'work') as HandoffKind;
      const label = HANDOFF_LABEL[kind] ?? HANDOFF_LABEL.work;
      if (!to) return label;
      const name = index.actorName(to);
      return kind === 'work' ? `→ ${name}에게 전달` : `${label} → ${name}`;
    }
    case 'task_review_requested': {
      const reviewer = payloadText(event, 'reviewer');
      return reviewer ? `검토 요청 → ${index.actorName(reviewer)}` : EVENT_LABEL.task_review_requested;
    }
    case 'approval_requested':
      return EVENT_LABEL.approval_requested;
    case 'approval_decided': {
      const approved = payloadText(event, 'decision') !== 'reject';
      if (event.payload?.auto === true) return approved ? '자동 승인(시연)' : '자동 반려(시연)';
      return approved ? '승인' : '반려';
    }
    case 'task_blocked': {
      const reason = payloadText(event, 'reason');
      return reason ? `막힘: ${reason}` : EVENT_LABEL.task_blocked;
    }
    case 'task_completed':
      return payloadText(event, 'outcome') === 'rejected' ? '반려로 종료' : EVENT_LABEL.task_completed;
    case 'staff_status_changed': {
      const status = payloadText(event, 'status') as StaffStatus;
      return `상태 변경: ${STAFF_STATUS_LABEL[status] ?? status}`;
    }
  }
}

/** 피드 줄의 둘째 줄: 작업 제목(없으면 이벤트 message). 작업 제목을 모르면 task_id 대신 message를 쓴다. */
export function feedSubtitle(state: DashboardState, event: PbEvent): string {
  const title = event.task_id ? state.tasks[event.task_id]?.title : undefined;
  return title || event.message || '';
}

export type FeedIconKind = StaffStatus | 'done' | 'rejected';

/** 피드 줄 끝의 상태 아이콘 — 이 이벤트로 일감(또는 받는 직원)이 가게 된 상태. 없으면 null. */
export function eventIconKind(event: PbEvent): FeedIconKind | null {
  switch (event.type) {
    case 'task_started':
      return 'working';
    case 'task_handoff':
      return payloadText(event, 'kind') === 'review' ? 'reviewing' : 'working';
    case 'task_review_requested':
      return 'reviewing';
    case 'approval_requested':
      return 'waiting_approval';
    case 'task_blocked':
      return 'blocked';
    case 'task_completed':
      return payloadText(event, 'outcome') === 'rejected' ? 'rejected' : 'done';
    case 'staff_status_changed': {
      const s = payloadText(event, 'status') as StaffStatus;
      return STAFF_STATUSES.includes(s) ? s : null;
    }
    case 'task_created':
    case 'approval_decided':
      return null;
  }
}
