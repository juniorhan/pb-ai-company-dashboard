// 대시보드 상태 계산(순수). 규칙은 docs/DESIGN.md §2 표와 '공통' 문단이다.
// 같은 이벤트 열을 다시 재생하면 같은 상태가 나온다(Date.now·Math.random을 쓰지 않는다).
//
// 구현 방식: 상태의 '그릇'(staff·tasks·approvals 레코드, feed·handoffs·warnings 배열, metrics)은 제자리에서 고치고,
// 그 안의 '잎'(직원·작업·승인 객체와 그 안의 배열)은 고치지 않고 통째로 새로 만들어 바꿔 끼운다.
// 그래서 그릇만 얕게 복사(cloneShell)하면 이전 상태와 잎을 안전하게 공유하는 스냅숏이 된다.
// 2만 건 규모의 tasks 레코드를 이벤트마다 통째로 복사하면 너무 느리기 때문이다(EventLog는 applyInPlace를 직접 쓴다).
import { CEO_ID, EXECUTORS, STAFF_STATUSES, isReservedId } from '../types';
import type {
  DashboardState, Executor, HandoffKind, OrgIndex, PbEvent, StaffState, StaffStatus, TaskState, TaskStatus,
} from '../types';
import { isKnownActorId } from './resolve';

export const LIMITS = {
  taskHistory: 50,
  staffHistory: 30,
  feed: 300,
  handoffs: 50,
  warnings: 50,
  recentTasks: 10,
  taskPruneAbove: 1500,
  taskPruneTo: 1000,
  decidedApprovals: 100,
} as const;

const KST_OFFSET_MS = 9 * 3600 * 1000;
const PRUNE_RETRY_EVERY = 100;      // 정리해도 줄지 않는 경우 매 생성마다 훑지 않도록 100건마다만 다시 시도한다

// tasks 그릇별 작업 개수(O(1)로 세려고). 그릇을 복사하면 같이 옮기고, 기록이 없으면 한 번 세서 채운다.
const taskCounts = new WeakMap<object, number>();
function taskCount(s: DashboardState): number {
  let n = taskCounts.get(s.tasks);
  if (n === undefined) {
    n = Object.keys(s.tasks).length;
    taskCounts.set(s.tasks, n);
  }
  return n;
}

type Payload = Record<string, unknown> | undefined;
const str = (p: Payload, key: string): string | undefined => {
  const v = p?.[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const num = (p: Payload, key: string): number | undefined => {
  const v = p?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/** ISO 시각의 KST(UTC+9) 날짜 YYYY-MM-DD */
export function kstDay(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts.slice(0, 10);
  return new Date(t + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function later(a: string | null, b: string): string {
  if (a === null) return b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return a;
  if (Number.isNaN(ta)) return b;
  return tb >= ta ? b : a;
}

function pushCap<T>(list: readonly T[], item: T, cap: number): T[] {
  const out = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice();
  out.push(item);
  return out;
}

function emptyExecutorCounts(): Record<Executor, number> {
  return { claude: 0, codex: 0, aside: 0, script: 0, human: 0 };
}

function newStaffState(id: string, known: boolean): StaffState {
  return { id, known, status: 'idle', currentTaskId: null, lastMessage: null, lastTs: null, changeSeq: 0, history: [], recentTaskIds: [] };
}

/** 조직 직원 전원 + 대표 + AI 총괄을 대기 상태로 만든다. */
export function initialState(index: OrgIndex): DashboardState {
  const staff: Record<string, StaffState> = {};
  for (const s of index.org.staff) staff[s.id] = newStaffState(s.id, true);
  staff[CEO_ID] = newStaffState(CEO_ID, true);
  for (const h of index.org.hq) staff[h.id] = newStaffState(h.id, true);
  const tasks: Record<string, TaskState> = {};
  taskCounts.set(tasks, 0);
  return {
    seq: 0,
    lastTs: null,
    staff,
    tasks,
    approvals: {},
    feed: [],
    handoffs: [],
    metrics: { day: null, completed: 0, savedMinutes: 0, createdByExecutor: emptyExecutorCounts() },
    warnings: [],
  };
}

/** 그릇만 얕게 복사한다(잎은 공유). 복사본은 applyInPlace로 고쳐도 원본에 영향이 없다. */
export function cloneShell(s: DashboardState): DashboardState {
  const tasks = { ...s.tasks };
  taskCounts.set(tasks, taskCount(s));
  return {
    seq: s.seq,
    lastTs: s.lastTs,
    staff: { ...s.staff },
    tasks,
    approvals: { ...s.approvals },
    feed: s.feed.slice(),
    handoffs: s.handoffs.slice(),
    metrics: { ...s.metrics, createdByExecutor: { ...s.metrics.createdByExecutor } },
    warnings: s.warnings.slice(),
  };
}

/** 순수 함수: 입력 상태(얼려 있어도 됨)를 바꾸지 않고 새 상태를 돌려준다. */
export function reduce(state: DashboardState, event: PbEvent, index: OrgIndex): DashboardState {
  const next = cloneShell(state);
  applyInPlace(next, event, index);
  return next;
}

/* ───────────── 제자리 적용(내부용) ───────────── */

function warn(s: DashboardState, message: string): void {
  if (s.warnings.includes(message)) return;
  s.warnings.push(message);
  if (s.warnings.length > LIMITS.warnings) s.warnings.splice(0, s.warnings.length - LIMITS.warnings);
}

function ensureStaff(s: DashboardState, id: string, index: OrgIndex): void {
  if (s.staff[id]) return;
  const known = isKnownActorId(id, index);
  s.staff[id] = newStaffState(id, known);
  if (!known) warn(s, `조직에 없는 행위자: ${id}`);
}

interface StaffPatch { status?: StaffStatus; task?: string | null; recent?: string }

function setStaff(s: DashboardState, id: string, patch: StaffPatch, e: PbEvent): void {
  const cur = s.staff[id];
  if (!cur) return;
  const status = patch.status ?? cur.status;
  const currentTaskId = patch.task === undefined ? cur.currentTaskId : patch.task;
  let recent = cur.recentTaskIds;
  if (patch.recent !== undefined && recent[0] !== patch.recent) {
    const rid = patch.recent;
    recent = [rid, ...recent.filter((x) => x !== rid)].slice(0, LIMITS.recentTasks);
  }
  const statusChanged = status !== cur.status;
  if (!statusChanged && currentTaskId === cur.currentTaskId && recent === cur.recentTaskIds) return;
  s.staff[id] = {
    ...cur,
    status,
    currentTaskId,
    recentTaskIds: recent,
    changeSeq: statusChanged ? cur.changeSeq + 1 : cur.changeSeq,
    history: statusChanged ? pushCap(cur.history, { ts: e.ts, status, message: e.message }, LIMITS.staffHistory) : cur.history,
  };
}

/** 그 작업을 들고 있던 직원이면 대기로 돌린다. */
function release(s: DashboardState, id: string, taskId: string, e: PbEvent): void {
  const cur = s.staff[id];
  if (cur && cur.currentTaskId === taskId) setStaff(s, id, { status: 'idle', task: null }, e);
}

function updateTask(s: DashboardState, t: TaskState, patch: Partial<TaskState>, e: PbEvent): TaskState {
  const next: TaskState = {
    ...t,
    ...patch,
    history: pushCap(t.history, { ts: e.ts, type: e.type, staffId: e.staff_id, message: e.message }, LIMITS.taskHistory),
  };
  s.tasks[t.id] = next;
  return next;
}

/** 상태를 바꾸는 패치. 끝난 상태(완료·반려)에서만 endedAt이 있다. */
function statusPatch(status: TaskStatus, e: PbEvent): Pick<TaskState, 'status' | 'endedAt'> {
  return { status, endedAt: status === 'completed' || status === 'rejected' ? e.ts : null };
}

function ensureTask(s: DashboardState, e: PbEvent, id: string): TaskState {
  const cur = s.tasks[id];
  if (cur) return cur;
  warn(s, `모르는 작업: ${id}`);
  const t: TaskState = {
    id, title: id, owner: e.staff_id, executor: e.executor, status: 'created', parentTaskId: null, duty: null,
    createdAt: e.ts, startedAt: null, endedAt: null, manualMinutes: null, humanMinutes: null, history: [],
  };
  s.tasks[id] = t;
  afterTaskAdded(s);
  return t;
}

function rollDay(s: DashboardState, ts: string): void {
  const day = kstDay(ts);
  if (s.metrics.day === day) return;
  s.metrics.day = day;
  s.metrics.completed = 0;
  s.metrics.savedMinutes = 0;
  for (const ex of EXECUTORS) s.metrics.createdByExecutor[ex] = 0;
}

function addHandoff(s: DashboardState, e: PbEvent, taskId: string, from: string, to: string, kind: HandoffKind | 'approval' | 'decision'): void {
  s.handoffs.push({ seq: s.seq, ts: e.ts, taskId, from, to, kind });
  if (s.handoffs.length > LIMITS.handoffs) s.handoffs.splice(0, s.handoffs.length - LIMITS.handoffs);
}

/** 작업이 늘 때마다 불린다. 1500개를 넘으면 끝난 오래된 작업부터 1000개로 줄인다. 어떤 직원이 쥐거나 최근 목록에 둔 작업은 남긴다. */
function afterTaskAdded(s: DashboardState): void {
  // 새 작업은 이미 s.tasks에 들어가 있다. 기록이 없으면 새 작업까지 포함해 세고, 있으면 하나 더한다.
  const known = taskCounts.get(s.tasks);
  const count = known === undefined ? Object.keys(s.tasks).length : known + 1;
  taskCounts.set(s.tasks, count);
  const over = count - LIMITS.taskPruneAbove;
  if (over <= 0 || (over - 1) % PRUNE_RETRY_EVERY !== 0) return;
  const ids = Object.keys(s.tasks);
  const keep = new Set<string>();
  for (const st of Object.values(s.staff)) {
    if (st.currentTaskId) keep.add(st.currentTaskId);
    for (const r of st.recentTaskIds) keep.add(r);
  }
  const candidates: { id: string; order: number; at: number }[] = [];
  ids.forEach((id, order) => {
    const t = s.tasks[id]!;
    if ((t.status === 'completed' || t.status === 'rejected') && !keep.has(id)) {
      candidates.push({ id, order, at: Date.parse(t.endedAt ?? t.createdAt) });
    }
  });
  candidates.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  const removed = candidates.slice(0, ids.length - LIMITS.taskPruneTo);
  for (const c of removed) delete s.tasks[c.id];
  taskCounts.set(s.tasks, ids.length - removed.length);
}

/** 결정된 승인은 최근 100개만 남긴다(대기 중은 전부). */
function pruneApprovals(s: DashboardState): void {
  const decided: { id: string; order: number; at: number }[] = [];
  Object.keys(s.approvals).forEach((id, order) => {
    const a = s.approvals[id]!;
    if (a.status !== 'pending') decided.push({ id, order, at: Date.parse(a.decidedAt ?? a.requestedAt) });
  });
  if (decided.length <= LIMITS.decidedApprovals) return;
  decided.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  for (const d of decided.slice(0, decided.length - LIMITS.decidedApprovals)) delete s.approvals[d.id];
}

const KEY_PAYLOAD_FIELDS = ['to', 'reviewer', 'approval_id'] as const;
/** 상태 레코드의 키로 쓰이는 칸(staff_id·task_id·payload의 to·reviewer·approval_id) 중 예약된 이름이 있는가 */
function usesReservedId(e: PbEvent): boolean {
  if (isReservedId(e.staff_id) || (typeof e.task_id === 'string' && isReservedId(e.task_id))) return true;
  const p = e.payload;
  if (!p) return false;
  for (const k of KEY_PAYLOAD_FIELDS) {
    const v = p[k];
    if (typeof v === 'string' && isReservedId(v)) return true;
  }
  return false;
}

const isStaffStatus = (v: unknown): v is StaffStatus => typeof v === 'string' && (STAFF_STATUSES as string[]).includes(v);
const HANDOFF_KINDS: readonly string[] = ['work', 'review', 'revision', 'publish'];

/**
 * 이벤트 1건을 제자리에서 적용한다. 반드시 cloneShell로 만든(소유한) 상태에만 쓴다. 공개 API는 reduce다.
 */
export function applyInPlace(s: DashboardState, e: PbEvent, index: OrgIndex): void {
  const p = e.payload;
  // 상태 레코드의 키가 될 id에 예약된 이름(__proto__ 등)이 있으면 적용하지 않는다. 이벤트 검사가 먼저 거절하므로 이중 안전장치다.
  if (usesReservedId(e)) {
    warn(s, `예약된 이름을 id로 쓴 이벤트를 건너뜀: ${e.event_id}`);
    return;
  }
  s.seq += 1;
  s.lastTs = later(s.lastTs, e.ts);
  rollDay(s, e.ts);
  ensureStaff(s, e.staff_id, index);

  const taskId = e.task_id;
  if (e.type === 'staff_status_changed') {
    const status = p?.status;
    if (isStaffStatus(status)) {
      setStaff(s, e.staff_id, { status, task: status === 'idle' || status === 'offline' ? null : undefined }, e);
    } else {
      warn(s, `알 수 없는 상태 값: ${String(status)}`);
    }
    const t = taskId ? s.tasks[taskId] : undefined;
    if (t) updateTask(s, t, {}, e);
  } else if (!taskId) {
    warn(s, `작업 번호가 없는 이벤트: ${e.type}`);
  } else {
    applyTaskEvent(s, e, index, taskId);
  }

  const actor = s.staff[e.staff_id];
  if (actor) s.staff[e.staff_id] = { ...actor, lastTs: e.ts, lastMessage: e.message };
  s.feed.push({ seq: s.seq, event: e });
  if (s.feed.length > LIMITS.feed) s.feed.splice(0, s.feed.length - LIMITS.feed);
}

function applyTaskEvent(s: DashboardState, e: PbEvent, index: OrgIndex, taskId: string): void {
  const p = e.payload;
  const actorId = e.staff_id;

  switch (e.type) {
    case 'task_created': {
      const title = str(p, 'title') ?? taskId;
      const parent = str(p, 'parent_task_id');
      const duty = str(p, 'duty');
      const manual = num(p, 'manual_minutes');
      const prev = s.tasks[taskId];
      if (prev) {
        warn(s, `이미 있는 작업을 다시 만듦: ${taskId}`);
        updateTask(s, prev, {
          title,
          parentTaskId: parent ?? prev.parentTaskId,
          duty: duty ?? prev.duty,
          manualMinutes: manual ?? prev.manualMinutes,
        }, e);
      } else {
        s.tasks[taskId] = {
          id: taskId, title, owner: actorId, executor: e.executor, status: 'created', parentTaskId: parent ?? null, duty: duty ?? null,
          createdAt: e.ts, startedAt: null, endedAt: null, manualMinutes: manual ?? null, humanMinutes: null,
          history: [{ ts: e.ts, type: e.type, staffId: actorId, message: e.message }],
        };
        const counts = s.metrics.createdByExecutor;
        counts[e.executor] = (counts[e.executor] ?? 0) + 1;
        afterTaskAdded(s);
      }
      setStaff(s, actorId, { recent: taskId }, e);
      return;
    }

    case 'task_started': {
      const t = ensureTask(s, e, taskId);
      updateTask(s, t, { ...statusPatch('in_progress', e), startedAt: t.startedAt ?? e.ts, owner: actorId, executor: e.executor }, e);
      setStaff(s, actorId, { status: 'working', task: taskId, recent: taskId }, e);
      return;
    }

    case 'task_handoff': {
      let to = str(p, 'to');
      if (!to) {
        warn(s, `전달 이벤트에 받는 쪽이 없음: ${e.event_id}`);
        to = actorId;
      }
      const kindRaw = p?.kind;
      const kind: HandoffKind = typeof kindRaw === 'string' && HANDOFF_KINDS.includes(kindRaw) ? (kindRaw as HandoffKind) : 'work';
      ensureStaff(s, to, index);
      const t = ensureTask(s, e, taskId);
      updateTask(s, t, { ...statusPatch(kind === 'review' ? 'in_review' : 'in_progress', e), owner: to, executor: e.executor }, e);
      release(s, actorId, taskId, e);
      setStaff(s, to, { status: kind === 'review' ? 'reviewing' : 'working', task: taskId, recent: taskId }, e);
      addHandoff(s, e, taskId, actorId, to, kind);
      return;
    }

    case 'task_review_requested': {
      let reviewer = str(p, 'reviewer');
      if (!reviewer) {
        warn(s, `검토 요청 이벤트에 검토자가 없음: ${e.event_id}`);
        reviewer = actorId;
      }
      ensureStaff(s, reviewer, index);
      const t = ensureTask(s, e, taskId);
      updateTask(s, t, { ...statusPatch('in_review', e), owner: reviewer, executor: e.executor }, e);
      release(s, actorId, taskId, e);
      setStaff(s, reviewer, { status: 'reviewing', task: taskId, recent: taskId }, e);
      addHandoff(s, e, taskId, actorId, reviewer, 'review');
      return;
    }

    case 'approval_requested': {
      const approvalId = str(p, 'approval_id') ?? `${taskId}:approval`;
      const summary = p?.summary;
      const t = ensureTask(s, e, taskId);
      updateTask(s, t, statusPatch('waiting_approval', e), e);            // 승인 요청은 작업의 실행 주체를 바꾸지 않는다
      setStaff(s, actorId, { status: 'waiting_approval', task: taskId }, e);
      s.approvals[approvalId] = {
        id: approvalId, taskId, requestedBy: actorId, summary: typeof summary === 'string' ? summary : '',
        status: 'pending', requestedAt: e.ts, decidedAt: null, auto: false,
      };
      addHandoff(s, e, taskId, actorId, CEO_ID, 'approval');
      return;
    }

    case 'approval_decided': {
      const approvalId = str(p, 'approval_id') ?? `${taskId}:approval`;
      const decision = p?.decision === 'reject' ? 'reject' : 'approve';
      const t = ensureTask(s, e, taskId);
      let approval = s.approvals[approvalId];
      if (!approval) {
        warn(s, `모르는 승인 번호: ${approvalId}`);
        approval = { id: approvalId, taskId, requestedBy: t.owner, summary: '', status: 'pending', requestedAt: e.ts, decidedAt: null, auto: false };
      }
      s.approvals[approvalId] = { ...approval, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: e.ts, auto: p?.auto === true };
      if (actorId !== CEO_ID) warn(s, `승인 결정 행위자가 대표가 아님: ${actorId}`);
      if (e.executor !== 'human') warn(s, `승인 결정 실행 주체가 사람(human)이 아님: ${e.executor}`);
      updateTask(s, t, statusPatch('in_progress', e), e);                 // 승인 결정도 실행 주체를 바꾸지 않는다. 이어지는 이벤트가 정한다
      ensureStaff(s, approval.requestedBy, index);
      const requester = s.staff[approval.requestedBy];
      if (requester && requester.status === 'waiting_approval') setStaff(s, approval.requestedBy, { status: 'idle', task: null }, e);
      addHandoff(s, e, taskId, actorId, approval.requestedBy, 'decision');
      pruneApprovals(s);
      return;
    }

    case 'task_blocked': {
      const t = ensureTask(s, e, taskId);
      updateTask(s, t, { ...statusPatch('blocked', e), executor: e.executor }, e);
      setStaff(s, actorId, { status: 'blocked', task: taskId }, e);
      return;
    }

    case 'task_completed': {
      const t = ensureTask(s, e, taskId);
      const rejected = p?.outcome === 'rejected';
      const wasEnded = t.status === 'completed' || t.status === 'rejected';
      const humanMinutes = num(p, 'human_minutes');
      const done = updateTask(s, t, {
        ...statusPatch(rejected ? 'rejected' : 'completed', e),
        executor: e.executor,
        humanMinutes: humanMinutes ?? t.humanMinutes,
      }, e);
      release(s, actorId, taskId, e);
      if (t.owner !== actorId) release(s, t.owner, taskId, e);
      if (!wasEnded && !rejected && done.executor !== 'human' && done.owner !== CEO_ID) {
        s.metrics.completed += 1;
        if (done.manualMinutes !== null) s.metrics.savedMinutes += Math.max(0, done.manualMinutes - (done.humanMinutes ?? 0));
      }
      return;
    }

    default:
      warn(s, `알 수 없는 이벤트 종류: ${String(e.type)}`);
  }
}
