// 개발용 가짜 스토어: DashboardStore + EventSource + SimControl을 코어 없이 흉내 낸다.
// 화면 컴포넌트를 코어와 따로 돌려 보고(?mock=1), 코어가 아직 없을 때의 대체 연결로 쓴다.
// 공개 사이트에 올라가도 되는 가짜 문구만 쓴다(종목·투자 권유 없음). 코어의 reducer를 대신하는 것이 아니다 — 화면 확인용 최소 구현이다.
import { CEO_ID } from '../../types';
import type {
  ApprovalState, DashboardState, DashboardStore, DashboardView, DayMetrics, EventSource, Executor, FeedItem, HandoffKind, OrgIndex,
  PbEvent, ScenarioInfo, SimControl, SourceKind, SourceStatus, StaffState, StaffStatus, TaskState,
} from '../../types';
import { parseTs, toKstIso } from '../format';

/* ───────────── 상태 계산(최소 reducer) ───────────── */

const zeroByExecutor = (): Record<Executor, number> => ({ claude: 0, codex: 0, aside: 0, script: 0, human: 0 });

function newStaff(id: string, known: boolean): StaffState {
  return { id, known, status: 'idle', currentTaskId: null, lastMessage: null, lastTs: null, changeSeq: 0, history: [], recentTaskIds: [] };
}

export function initialMockState(index: OrgIndex): DashboardState {
  const staff: Record<string, StaffState> = {};
  for (const id of [CEO_ID, ...index.org.hq.map((h) => h.id), ...index.org.staff.map((s) => s.id)]) staff[id] = newStaff(id, true);
  const metrics: DayMetrics = { day: null, completed: 0, savedMinutes: 0, createdByExecutor: zeroByExecutor() };
  return { seq: 0, lastTs: null, staff, tasks: {}, approvals: {}, feed: [], handoffs: [], metrics, warnings: [] };
}

function reduceMock(state: DashboardState, ev: PbEvent): DashboardState {
  const seq = state.seq + 1;
  const staff = { ...state.staff };
  const tasks = { ...state.tasks };
  const approvals = { ...state.approvals };
  let handoffs = state.handoffs;
  let warnings = state.warnings;
  const p = ev.payload ?? {};
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const num = (k: string): number | null => (typeof p[k] === 'number' ? (p[k] as number) : null);

  const day = ev.ts.slice(0, 10);
  let metrics = state.metrics;
  if (metrics.day !== day) metrics = { day, completed: 0, savedMinutes: 0, createdByExecutor: zeroByExecutor() };

  if (!staff[ev.staff_id]) warnings = [...warnings, `조직에 없는 행위자: ${ev.staff_id}`].slice(-50);

  const touch = (id: string, patch: { status?: StaffStatus; currentTaskId?: string | null; recentTask?: string }, actor: boolean): void => {
    const prev = staff[id] ?? newStaff(id, false);
    const status = patch.status ?? prev.status;
    const changed = status !== prev.status;
    staff[id] = {
      ...prev,
      status,
      currentTaskId: patch.currentTaskId === undefined ? prev.currentTaskId : patch.currentTaskId,
      lastMessage: actor ? ev.message : prev.lastMessage,
      lastTs: actor ? ev.ts : prev.lastTs,
      changeSeq: prev.changeSeq + (changed ? 1 : 0),
      history: changed ? [...prev.history, { ts: ev.ts, status, message: ev.message }].slice(-30) : prev.history,
      recentTaskIds: patch.recentTask && prev.recentTaskIds[0] !== patch.recentTask ? [patch.recentTask, ...prev.recentTaskIds].slice(0, 10) : prev.recentTaskIds,
    };
  };
  const patchTask = (patch: Partial<TaskState>): void => {
    const id = ev.task_id;
    const prev = id ? tasks[id] : undefined;
    if (!id || !prev) return;
    tasks[id] = { ...prev, ...patch, history: [...prev.history, { ts: ev.ts, type: ev.type, staffId: ev.staff_id, message: ev.message }].slice(-40) };
  };
  const holds = (id: string): boolean => !!ev.task_id && staff[id]?.currentTaskId === ev.task_id;

  switch (ev.type) {
    case 'task_created': {
      if (ev.task_id) {
        tasks[ev.task_id] = {
          id: ev.task_id, title: str('title'), owner: ev.staff_id, executor: ev.executor, status: 'created', parentTaskId: str('parent_task_id') || null,
          duty: str('duty') || null, createdAt: ev.ts, startedAt: null, endedAt: null, manualMinutes: num('manual_minutes'), humanMinutes: null,
          history: [{ ts: ev.ts, type: ev.type, staffId: ev.staff_id, message: ev.message }],
        };
        metrics = { ...metrics, createdByExecutor: { ...metrics.createdByExecutor, [ev.executor]: metrics.createdByExecutor[ev.executor] + 1 } };
        touch(ev.staff_id, { recentTask: ev.task_id }, true);
      }
      break;
    }
    case 'task_started': {
      const prev = ev.task_id ? tasks[ev.task_id] : undefined;
      patchTask({ status: 'in_progress', startedAt: prev?.startedAt ?? ev.ts, owner: ev.staff_id, executor: ev.executor });
      touch(ev.staff_id, { status: 'working', currentTaskId: ev.task_id, recentTask: ev.task_id ?? undefined }, true);
      break;
    }
    case 'task_handoff': {
      const to = str('to');
      const kind = (str('kind') || 'work') as HandoffKind;
      patchTask({ owner: to, executor: ev.executor, status: kind === 'review' ? 'in_review' : 'in_progress' });
      if (holds(ev.staff_id)) touch(ev.staff_id, { status: 'idle', currentTaskId: null }, true);
      else touch(ev.staff_id, {}, true);
      touch(to, { status: kind === 'review' ? 'reviewing' : 'working', currentTaskId: ev.task_id, recentTask: ev.task_id ?? undefined }, false);
      handoffs = [...handoffs, { seq, ts: ev.ts, taskId: ev.task_id ?? '', from: ev.staff_id, to, kind }].slice(-50);
      break;
    }
    case 'task_review_requested': {
      const reviewer = str('reviewer');
      patchTask({ owner: reviewer, executor: ev.executor, status: 'in_review' });
      if (holds(ev.staff_id)) touch(ev.staff_id, { status: 'idle', currentTaskId: null }, true);
      else touch(ev.staff_id, {}, true);
      touch(reviewer, { status: 'reviewing', currentTaskId: ev.task_id, recentTask: ev.task_id ?? undefined }, false);
      handoffs = [...handoffs, { seq, ts: ev.ts, taskId: ev.task_id ?? '', from: ev.staff_id, to: reviewer, kind: 'review' as const }].slice(-50);
      break;
    }
    case 'approval_requested': {
      patchTask({ status: 'waiting_approval' });
      touch(ev.staff_id, { status: 'waiting_approval' }, true);
      const id = str('approval_id');
      approvals[id] = { id, taskId: ev.task_id ?? '', requestedBy: ev.staff_id, summary: str('summary'), status: 'pending', requestedAt: ev.ts, decidedAt: null, auto: false };
      handoffs = [...handoffs, { seq, ts: ev.ts, taskId: ev.task_id ?? '', from: ev.staff_id, to: CEO_ID, kind: 'approval' as const }].slice(-50);
      break;
    }
    case 'approval_decided': {
      const id = str('approval_id');
      const prev = approvals[id];
      if (prev) {
        approvals[id] = { ...prev, status: str('decision') === 'reject' ? 'rejected' : 'approved', decidedAt: ev.ts, auto: p.auto === true };
        patchTask({ status: 'in_progress' });
        touch(ev.staff_id, {}, true);
        if (staff[prev.requestedBy]?.status === 'waiting_approval') touch(prev.requestedBy, { status: 'idle' }, false);
        handoffs = [...handoffs, { seq, ts: ev.ts, taskId: ev.task_id ?? '', from: CEO_ID, to: prev.requestedBy, kind: 'decision' as const }].slice(-50);
      }
      break;
    }
    case 'task_blocked': {
      patchTask({ status: 'blocked' });
      touch(ev.staff_id, { status: 'blocked' }, true);
      break;
    }
    case 'task_completed': {
      const rejected = str('outcome') === 'rejected';
      const prev = ev.task_id ? tasks[ev.task_id] : undefined;
      const humanMinutes = num('human_minutes');
      patchTask({ status: rejected ? 'rejected' : 'completed', endedAt: ev.ts, humanMinutes });
      if (holds(ev.staff_id)) touch(ev.staff_id, { status: 'idle', currentTaskId: null }, true);
      else touch(ev.staff_id, {}, true);
      if (!rejected && prev && ev.staff_id !== CEO_ID) {
        metrics = { ...metrics, completed: metrics.completed + 1, savedMinutes: metrics.savedMinutes + Math.max(0, (prev.manualMinutes ?? 0) - (humanMinutes ?? 0)) };
      }
      break;
    }
    case 'staff_status_changed': {
      touch(ev.staff_id, { status: str('status') as StaffStatus }, true);
      break;
    }
  }

  const feed: FeedItem[] = [...state.feed, { seq, event: ev }].slice(-300);
  const lastTs = !state.lastTs || (parseTs(ev.ts) ?? 0) >= (parseTs(state.lastTs) ?? 0) ? ev.ts : state.lastTs;
  return { seq, lastTs, staff, tasks, approvals, feed, handoffs, metrics, warnings };
}

/* ───────────── 가짜 이벤트를 만드는 감독 ───────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const BLOCK_REASONS = ['입력 자료 대기 중', '기계 검사 지적 확인 필요', '로그인 세션 만료(시뮬레이션)', '근거 출처 누락'];
const SCENARIO_START: Record<string, string> = { day: '06:00', 'morning-briefing': '06:30', 'report-digest': '09:30', anomaly: '13:00', 'closing-briefing': '15:40', 'idle-morning': '09:00' };
const SCENARIOS: ScenarioInfo[] = [
  { id: 'day', title: '하루 압축 재생', description: '06:00~18:30 하루를 압축해 재생합니다(개발용 가짜 재생).' },
  { id: 'morning-briefing', title: '모닝 브리핑', description: '모닝 브리핑 한 건이 만들어져 게시되기까지.' },
  { id: 'closing-briefing', title: '마감 브리핑', description: '마감 브리핑 한 건이 만들어져 게시되기까지.' },
  { id: 'report-digest', title: '증권사 리포트 정리', description: '여러 리포트를 모아 요약하는 흐름.' },
  { id: 'anomaly', title: '이상 상황', description: '막힘과 재작업이 섞인 흐름.' },
  { id: 'idle-morning', title: '한가한 오전', description: '큰 흐름 없이 담당 업무를 조금씩 처리합니다.' },
];

const VIRTUAL_PER_REAL = 30;       // 1x에서 실제 1초 = 가상 30초
const AUTO_APPROVE_MS = 20_000;    // 자동 승인까지 실제 20초(÷속도)
const MAX_EVENTS = 1500;

export interface MockOptions {
  seed?: number;
  /** 시작할 때 미리 돌려 둘 단계 수(피드·타임라인이 빈 채로 시작하지 않게). 기본 70 */
  prerun?: number;
  /** false면 타이머 없이 advance()로만 진행(시험용). 기본 true */
  autoRun?: boolean;
  /** 조직에 없는 행위자(미배정) 이벤트를 몇 단계마다 한 번 섞을지. 0이면 없음. 기본 0 */
  unassignedEvery?: number;
  /** 소스 종류·이름·오류 — 파일 열기 오류 화면 등을 흉내 낼 때 */
  kind?: SourceKind;
  label?: string;
  error?: string;
  org?: { origin: 'live' | 'bundled'; generatedAt: string; hash: string };
}

export interface MockStore extends DashboardStore {
  /** 시험용: 단계를 n번 진행한다. */
  advance(n: number): void;
}

export function createMockStore(index: OrgIndex, opts: MockOptions = {}): MockStore {
  const autoRun = opts.autoRun !== false;
  const orgMeta = opts.org ?? { origin: 'bundled' as const, generatedAt: index.org.meta.generated_at, hash: index.org.meta.source_hash };
  const staffIds = index.org.staff.map((s) => s.id);
  const weights: Record<string, number> = { active: 3, building: 2, planned: 1, paused: 0 };

  let scenarioId = 'day';
  let rng = mulberry32(opts.seed ?? 20261017);
  let state = initialMockState(index);
  let events: PbEvent[] = [];
  let eventMs: number[] = [];
  let snapshots: DashboardState[] = [];
  let cursor: 'live' | string = 'live';
  let version = 0;
  let cachedKey = '';
  let cachedView: DashboardView | null = null;
  let evCounter = 0;
  let taskCounter = 0;
  let approvalCounter = 0;
  let stepCounter = 0;
  let disposed = false;
  let queue: (() => void)[] = [];
  let sourceState: SourceStatus['state'] = autoRun ? 'live' : 'paused';

  let playing = autoRun;
  let speed = 1;
  let autoApprove = true;
  let vBase = Date.parse(`2026-10-17T${SCENARIO_START.day}:00+09:00`);
  let rBase = Date.now();
  let rate = playing ? VIRTUAL_PER_REAL * speed : 0;
  const autoDue = new Map<string, number>();

  const listeners = new Set<() => void>();
  const tickListeners = new Set<() => void>();
  const batchHandlers = new Set<(batch: PbEvent[]) => void>();
  const statusHandlers = new Set<(s: SourceStatus) => void>();
  const resetHandlers = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const vNow = (): number => vBase + (Date.now() - rBase) * rate;
  const resync = (newRate: number): void => { vBase = vNow(); rBase = Date.now(); rate = newRate; };
  const notify = (): void => { version += 1; for (const l of [...listeners]) l(); };
  const currentStatus = (): SourceStatus => ({
    state: opts.error ? 'error' : sourceState,
    detail: opts.error ?? '',
    lastEventTs: state.lastTs,
  });
  const pushStatus = (): void => { const s = currentStatus(); for (const h of [...statusHandlers]) h(s); };

  /* 이벤트 내기 */
  function emit(partial: Omit<PbEvent, 'event_id' | 'ts' | 'v'>): void {
    const last = eventMs[eventMs.length - 1] ?? 0;
    const now = vNow();
    const ms = Math.max(now, last + 1000);                  // 시각이 거꾸로 가지 않게: 시계가 늦으면 이벤트에 맞춰 민다
    if (ms > now) vBase += ms - now;
    evCounter += 1;
    const ev: PbEvent = { v: 1, event_id: `mock-${evCounter}`, ts: toKstIso(ms), ...partial };
    state = reduceMock(state, ev);
    events.push(ev);
    eventMs.push(ms);
    snapshots.push(state);
    if (events.length > MAX_EVENTS) { events.shift(); eventMs.shift(); snapshots.shift(); }
    for (const h of [...batchHandlers]) h([ev]);
  }

  /* 도우미 */
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const orgStaff = (id: string) => index.staff.get(id)!;
  const isBusy = (id: string): boolean => {
    const s = state.staff[id];
    return !!s && (s.status === 'working' || s.status === 'reviewing') && !!s.currentTaskId;
  };
  const isFree = (id: string): boolean => {
    const s = state.staff[id];
    return !!s && s.status === 'idle' && !s.currentTaskId;
  };
  const executorOf = (id: string): Executor => {
    const e = orgStaff(id).executors;
    return e.length ? pick(e) : 'claude';
  };
  function pickFreeWeighted(): string | null {
    const free = staffIds.filter(isFree);
    if (!free.length) return null;
    const w = free.map((id) => weights[orgStaff(id).status] ?? 1);
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) return pick(free);
    let r = rng() * total;
    for (let i = 0; i < free.length; i++) { r -= w[i]!; if (r <= 0) return free[i]!; }
    return free[free.length - 1]!;
  }
  function pickReceiver(from: string): string | null {
    const me = orgStaff(from);
    const sameTeam = (index.staffByTeam.get(me.team) ?? []).map((s) => s.id).filter((id) => id !== from && isFree(id));
    const sameDept = staffIds.filter((id) => id !== from && orgStaff(id).dept === me.dept && isFree(id));
    const any = staffIds.filter((id) => id !== from && isFree(id));
    const pool = rng() < 0.55 && sameTeam.length ? sameTeam : sameDept.length ? sameDept : any;
    return pool.length ? pick(pool) : null;
  }
  function pickReviewer(from: string): string | null {
    const checkers = orgStaff(from).checker_staff.filter((id) => id !== from && isFree(id));
    return checkers.length ? pick(checkers) : pickReceiver(from);
  }
  const taskOf = (id: string): TaskState | null => {
    const t = state.staff[id]?.currentTaskId;
    return t ? state.tasks[t] ?? null : null;
  };
  const nameOf = (id: string): string => index.actorName(id);

  /* 동작 */
  function spawn(id: string): void {
    const staff = orgStaff(id);
    const title = staff.duties.length ? pick(staff.duties).title : `${staff.name} 담당 업무`;
    taskCounter += 1;
    const taskId = `mock#${taskCounter}`;
    const executor = executorOf(id);
    emit({ type: 'task_created', staff_id: id, executor, task_id: taskId, message: `${title} 작업을 만들었습니다`, payload: { title, manual_minutes: 10 + Math.floor(rng() * 50), ...(staff.duties.length ? { duty: staff.duties.find((d) => d.title === title)?.id } : {}) } });
    emit({ type: 'task_started', staff_id: id, executor, task_id: taskId, message: '작업을 시작합니다' });
  }
  function handoff(from: string, kind: HandoffKind): void {
    const task = taskOf(from);
    const to = kind === 'review' ? pickReviewer(from) : pickReceiver(from);
    if (!task || !to) return;
    const msg = kind === 'review' ? `${nameOf(to)}에게 검토를 요청합니다` : kind === 'revision' ? `수정이 필요해 ${nameOf(to)}에게 되돌립니다` : `${nameOf(to)}에게 넘깁니다`;
    emit({ type: 'task_handoff', staff_id: from, executor: executorOf(to), task_id: task.id, message: msg, payload: { to, kind } });
  }
  function reviewRequest(from: string): void {
    const task = taskOf(from);
    const reviewer = pickReviewer(from);
    if (!task || !reviewer) return;
    emit({ type: 'task_review_requested', staff_id: from, executor: executorOf(reviewer), task_id: task.id, message: `${nameOf(reviewer)}에게 검토를 요청합니다`, payload: { reviewer } });
  }
  function requestApproval(from: string): void {
    const task = taskOf(from);
    if (!task) return;
    approvalCounter += 1;
    const approvalId = `${task.id}:A${approvalCounter}`;
    emit({ type: 'approval_requested', staff_id: from, executor: task.executor, task_id: task.id, message: '서명 승인 대기열에 올렸습니다(시뮬레이션)', payload: { approval_id: approvalId, summary: `${task.title} — 검사 통과, 게시 승인 요청` } });
    if (autoApprove) autoDue.set(approvalId, Date.now() + AUTO_APPROVE_MS / speed);
  }
  function block(from: string): void {
    const task = taskOf(from);
    if (!task) return;
    emit({ type: 'task_blocked', staff_id: from, executor: task.executor, task_id: task.id, message: '막혔습니다', payload: { reason: pick(BLOCK_REASONS) } });
  }
  function complete(from: string, outcome: 'done' | 'rejected' = 'done', humanMinutes?: number): void {
    const task = taskOf(from);
    if (!task) return;
    emit({ type: 'task_completed', staff_id: from, executor: task.executor, task_id: task.id, message: outcome === 'rejected' ? '반려로 종료합니다' : '완료했습니다', payload: { outcome, ...(humanMinutes !== undefined ? { human_minutes: humanMinutes } : {}) } });
  }
  function resume(from: string): void {
    const task = taskOf(from);
    if (!task) return;
    emit({ type: 'task_started', staff_id: from, executor: task.executor, task_id: task.id, message: '막힌 부분을 풀고 다시 진행합니다' });
  }

  function decideInternal(approvalId: string, decision: 'approve' | 'reject', auto: boolean): void {
    const ap: ApprovalState | undefined = state.approvals[approvalId];
    if (!ap || ap.status !== 'pending') return;
    autoDue.delete(approvalId);
    emit({
      type: 'approval_decided', staff_id: CEO_ID, executor: 'human', task_id: ap.taskId,
      message: auto ? '시뮬레이션 자동 승인' : decision === 'approve' ? '대표 승인(체험)' : '대표 반려(체험)',
      payload: { approval_id: approvalId, decision, ...(auto ? { auto: true } : {}) },
    });
    const owner = ap.requestedBy;
    queue.push(() => {
      const task = state.tasks[ap.taskId];
      if (!task || task.status === 'completed' || task.status === 'rejected') return;
      if (decision === 'approve') emit({ type: 'task_started', staff_id: owner, executor: task.executor, task_id: task.id, message: '승인 후 게시를 진행합니다(시뮬레이션)' });
      else complete(owner, 'rejected');
    });
    if (decision === 'approve') queue.push(() => complete(owner, 'done', 1 + Math.floor(rng() * 3)));
  }

  function checkAutoApprovals(): void {
    if (!autoApprove) return;
    const now = Date.now();
    for (const [id, due] of [...autoDue]) if (now >= due) decideInternal(id, 'approve', true);
  }

  /** 감독 한 단계. */
  function step(): void {
    stepCounter += 1;
    if (rate === 0) vBase += 4000 + Math.floor(rng() * 12000);   // 멈춘 채 수동으로 진행할 때는 단계마다 시계를 민다
    checkAutoApprovals();
    if (queue.length) { queue.shift()!(); return; }
    if (opts.unassignedEvery && stepCounter % opts.unassignedEvery === 0) {
      taskCounter += 1;
      const id = `unassigned:mock-${taskCounter}`;
      emit({ type: 'task_created', staff_id: id, executor: 'script', task_id: `mock#${taskCounter}`, message: '담당을 찾지 못한 작업(시뮬레이션)', payload: { title: '담당 미정 작업' } });
      return;
    }
    const busy = staffIds.filter(isBusy);
    const blocked = staffIds.filter((id) => state.staff[id]!.status === 'blocked' && state.staff[id]!.currentTaskId);
    const r = rng();
    if (busy.length < 7 || (r < 0.32 && busy.length < 16)) {
      const id = pickFreeWeighted();
      if (id) { spawn(id); return; }
    }
    if (blocked.length && r < 0.5) { resume(pick(blocked)); return; }
    if (!busy.length) return;
    const who = pick(busy);
    const sub = rng();
    if (state.staff[who]!.status === 'reviewing') {
      if (sub < 0.7) complete(who);
      else handoff(who, 'revision');
      return;
    }
    const waiting = Object.values(state.approvals).filter((a) => a.status === 'pending').length;
    if (sub < 0.34) handoff(who, 'work');
    else if (sub < 0.52) reviewRequest(who);
    else if (sub < 0.64 && waiting < 3) requestApproval(who);
    else if (sub < 0.72) block(who);
    else complete(who);
  }

  /* 타이머 */
  function schedule(): void {
    if (!autoRun || disposed || timer || !playing) return;
    const wait = (500 + rng() * 900) / speed;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || !playing) return;
      step();
      notify();
      schedule();
    }, wait);
  }
  function startTick(): void {
    if (!autoRun || tickTimer) return;
    tickTimer = setInterval(() => {
      if (disposed) return;
      const before = evCounter;
      if (playing) checkAutoApprovals();
      if (evCounter !== before) notify();
      for (const l of [...tickListeners]) l();
    }, 250);
  }

  /* 초기화·시나리오 바꾸기 */
  function reset(id: string, firstTime: boolean): void {
    scenarioId = id;
    rng = mulberry32((opts.seed ?? 20261017) ^ hashString(id));
    state = initialMockState(index);
    events = []; eventMs = []; snapshots = [];
    queue = []; autoDue.clear();
    cursor = 'live';
    evCounter = 0; taskCounter = 0; approvalCounter = 0; stepCounter = 0;
    vBase = Date.parse(`2026-10-17T${SCENARIO_START[id] ?? '06:00'}:00+09:00`);
    rBase = Date.now();
    rate = 0;
    const n = opts.prerun ?? 70;
    for (let i = 0; i < n; i++) step();
    rate = playing ? VIRTUAL_PER_REAL * speed : 0;
    rBase = Date.now();
    // 미리 돌린 동안 만든 승인 대기는 자동 승인 기한을 지금부터 다시 센다
    for (const ap of Object.values(state.approvals)) if (ap.status === 'pending' && autoApprove) autoDue.set(ap.id, Date.now() + AUTO_APPROVE_MS / speed);
    if (!firstTime) { for (const h of [...resetHandlers]) h(); }
    notify();
  }

  const control: SimControl = {
    play() { if (playing) return; playing = true; sourceState = 'live'; resync(VIRTUAL_PER_REAL * speed); schedule(); pushStatus(); for (const l of [...tickListeners]) l(); notify(); },
    pause() { if (!playing) return; playing = false; sourceState = 'paused'; resync(0); if (timer) { clearTimeout(timer); timer = null; } pushStatus(); for (const l of [...tickListeners]) l(); notify(); },
    isPlaying: () => playing,
    setSpeed(x) { speed = x; if (playing) resync(VIRTUAL_PER_REAL * speed); for (const l of [...tickListeners]) l(); },
    getSpeed: () => speed,
    listScenarios: () => SCENARIOS,
    getScenario: () => scenarioId,
    setScenario(id) { reset(id, false); for (const l of [...tickListeners]) l(); },
    setAutoApprove(on) {
      autoApprove = on;
      if (on) { for (const ap of Object.values(state.approvals)) if (ap.status === 'pending' && !autoDue.has(ap.id)) autoDue.set(ap.id, Date.now() + AUTO_APPROVE_MS / speed); }
      else autoDue.clear();
      for (const l of [...tickListeners]) l();
    },
    getAutoApprove: () => autoApprove,
    clock: () => toKstIso(Math.max(vNow(), eventMs[eventMs.length - 1] ?? 0)),
    autoApproveDue(approvalId) {
      const due = autoDue.get(approvalId);
      return autoApprove && due !== undefined ? Math.max(0, due - Date.now()) : null;
    },
    subscribeTick(listener) { tickListeners.add(listener); return () => { tickListeners.delete(listener); }; },
  };

  const source: EventSource = {
    kind: opts.kind ?? 'sim',
    label: opts.label ?? '시뮬레이션(개발용 가짜)',
    live: false,
    subscribe(handler) { batchHandlers.add(handler); return () => { batchHandlers.delete(handler); }; },
    onStatus(handler) { statusHandlers.add(handler); handler(currentStatus()); return () => { statusHandlers.delete(handler); }; },
    start() { if (disposed) return; startTick(); schedule(); pushStatus(); },
    stop() { if (timer) { clearTimeout(timer); timer = null; } if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } },
    control: opts.kind && opts.kind !== 'sim' ? undefined : control,
    decide: opts.kind && opts.kind !== 'sim' ? undefined : (approvalId, decision) => { decideInternal(approvalId, decision, false); notify(); },
    onReset(handler) { resetHandlers.add(handler); return () => { resetHandlers.delete(handler); }; },
  };

  /* 보기(view) */
  function stateAt(iso: string): DashboardState {
    const t = parseTs(iso);
    if (t === null || !eventMs.length) return t === null ? state : initialMockState(index);
    let lo = 0;
    let hi = eventMs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (eventMs[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? initialMockState(index) : snapshots[found]!;
  }

  function buildView(): DashboardView {
    const start = events[0]?.ts ?? null;
    const end = events[events.length - 1]?.ts ?? null;
    const density = new Array<number>(60).fill(0);
    const marks: DashboardView['marks'] = [];
    const s = eventMs[0];
    const e = eventMs[eventMs.length - 1];
    events.forEach((ev, i) => {
      const span = (e ?? 0) - (s ?? 0);
      const bin = span > 0 ? Math.min(59, Math.floor(((eventMs[i]! - s!) / span) * 60)) : 59;
      density[bin] = density[bin]! + 1;
      if (ev.type === 'approval_requested') marks.push({ ts: ev.ts, kind: 'approval' });
      else if (ev.type === 'task_blocked') marks.push({ ts: ev.ts, kind: 'blocked' });
    });
    return {
      state: cursor === 'live' ? state : stateAt(cursor),
      cursor,
      range: { start, end },
      density,
      marks,
      source: { kind: source.kind, label: source.label, live: source.live, status: currentStatus() },
      org: orgMeta,
    };
  }

  const store: MockStore = {
    index,
    source,
    getView() {
      const key = `${version}|${cursor}|${sourceState}`;
      if (!cachedView || key !== cachedKey) { cachedView = buildView(); cachedKey = key; }
      return cachedView;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setCursor(next) { if (next === cursor) return; cursor = next; notify(); },
    dispose() {
      disposed = true;
      source.stop();
      listeners.clear(); tickListeners.clear(); batchHandlers.clear(); statusHandlers.clear(); resetHandlers.clear();
    },
    advance(n) { for (let i = 0; i < n; i++) step(); notify(); },
  };

  reset('day', true);
  return store;
}
