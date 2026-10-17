import { beforeEach, describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { CEO_ID, EXECUTORS } from '../types';
import type { DashboardState, EventType, Executor, PbEvent } from '../types';
import { LIMITS, applyInPlace, cloneShell, initialState, kstDay, reduce } from './reducer';

const index = indexOrg(parseOrg(bundledOrg));
const [A, B, C] = index.org.staff.slice(0, 3).map((s) => s.id) as [string, string, string];
const HQ = index.org.hq[0]!.id;
const T0 = Date.parse('2026-10-17T06:00:00+09:00');

/** T0에서 sec초 뒤의 +09:00 시각 */
const at = (sec: number): string => `${new Date(T0 + sec * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 19)}+09:00`;

let n = 0;
let clock = 0;
beforeEach(() => { n = 0; clock = 0; });

interface Opts { ts?: string; executor?: Executor; message?: string; payload?: Record<string, unknown> }
function ev(type: EventType, staff: string, task: string | null, o: Opts = {}): PbEvent {
  n += 1;
  clock += 60;
  const e: PbEvent = {
    event_id: `ev-${n}`, ts: o.ts ?? at(clock), type, staff_id: staff, executor: o.executor ?? 'claude', task_id: task, message: o.message ?? `${type} ${n}`,
  };
  if (o.payload) e.payload = o.payload;
  return e;
}
const created = (staff: string, task: string, o: Opts & { title?: string } = {}): PbEvent =>
  ev('task_created', staff, task, { ...o, payload: { title: o.title ?? `제목 ${task}`, ...o.payload } });
const started = (staff: string, task: string, o: Opts = {}): PbEvent => ev('task_started', staff, task, o);
const handoff = (staff: string, task: string, to: string, o: Opts & { kind?: string } = {}): PbEvent =>
  ev('task_handoff', staff, task, { ...o, payload: { to, ...(o.kind ? { kind: o.kind } : {}) } });
const review = (staff: string, task: string, reviewer: string, o: Opts = {}): PbEvent =>
  ev('task_review_requested', staff, task, { ...o, payload: { reviewer } });
const askApproval = (staff: string, task: string, id: string, o: Opts = {}): PbEvent =>
  ev('approval_requested', staff, task, { ...o, payload: { approval_id: id, summary: `요약 ${id}` } });
const decide = (task: string, id: string, decision: 'approve' | 'reject', o: Opts & { auto?: boolean; staff?: string } = {}): PbEvent =>
  ev('approval_decided', o.staff ?? CEO_ID, task, {
    executor: 'human', ...o, payload: { approval_id: id, decision, ...(o.auto === undefined ? {} : { auto: o.auto }) },
  });
const blocked = (staff: string, task: string, reason = '사유', o: Opts = {}): PbEvent => ev('task_blocked', staff, task, { ...o, payload: { reason } });
const completed = (staff: string, task: string, o: Opts & { outcome?: string; human?: number } = {}): PbEvent =>
  ev('task_completed', staff, task, {
    ...o,
    ...(o.outcome || o.human !== undefined ? { payload: { ...(o.outcome ? { outcome: o.outcome } : {}), ...(o.human !== undefined ? { human_minutes: o.human } : {}) } } : {}),
  });
const status = (staff: string, s: string, o: Opts = {}): PbEvent => ev('staff_status_changed', staff, null, { ...o, payload: { status: s } });

const run = (events: PbEvent[], from: DashboardState = initialState(index)): DashboardState => events.reduce((s, e) => reduce(s, e, index), from);

/** 같은 결과를 내는 빠른 접기(EventLog가 쓰는 제자리 적용). 작업이 천 개 단위로 쌓이는 시험에서 reduce를 건건이 부르면 느리다. */
const runFast = (events: PbEvent[]): DashboardState => {
  const state = cloneShell(initialState(index));
  for (const e of events) applyInPlace(state, e, index);
  return state;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

describe('initialState', () => {
  it('조직 직원 전원 + 대표 + AI 총괄이 대기·known으로 들어 있다', () => {
    const s = initialState(index);
    expect(Object.keys(s.staff)).toHaveLength(index.org.staff.length + 1 + index.org.hq.length);
    for (const id of [...index.org.staff.map((x) => x.id), CEO_ID, ...index.org.hq.map((h) => h.id)]) {
      expect(s.staff[id]).toEqual({
        id, known: true, status: 'idle', currentTaskId: null, lastMessage: null, lastTs: null, changeSeq: 0, history: [], recentTaskIds: [],
      });
    }
    expect(s.seq).toBe(0);
    expect(s.lastTs).toBeNull();
    expect(s.tasks).toEqual({});
    expect(s.approvals).toEqual({});
    expect(s.feed).toEqual([]);
    expect(s.handoffs).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.metrics).toEqual({ day: null, completed: 0, savedMinutes: 0, createdByExecutor: { claude: 0, codex: 0, aside: 0, script: 0, human: 0 } });
  });
});

describe('종류별 상태 변화', () => {
  it('task_created: 작업·최근 작업·실행 주체별 생성 수·피드', () => {
    const e = created(A, 't1', { executor: 'aside', title: '모닝 브리핑 원고', payload: { parent_task_id: 'p1', duty: 'com-01-T05', manual_minutes: 45 } });
    const s = reduce(initialState(index), e, index);
    expect(s.tasks.t1).toMatchObject({
      id: 't1', title: '모닝 브리핑 원고', owner: A, executor: 'aside', status: 'created', parentTaskId: 'p1', duty: 'com-01-T05',
      createdAt: e.ts, startedAt: null, endedAt: null, manualMinutes: 45, humanMinutes: null,
    });
    expect(s.tasks.t1!.history).toEqual([{ ts: e.ts, type: 'task_created', staffId: A, message: e.message }]);
    expect(s.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null, recentTaskIds: ['t1'], lastTs: e.ts, lastMessage: e.message, changeSeq: 0 });
    expect(s.metrics.createdByExecutor.aside).toBe(1);
    expect(s.metrics.day).toBe('2026-10-17');
    expect(s.seq).toBe(1);
    expect(s.lastTs).toBe(e.ts);
    expect(s.feed).toEqual([{ seq: 1, event: e }]);
  });

  it('task_started: 진행 중, 시작 시각은 처음만, 직원은 작업 중', () => {
    const s1 = run([created(A, 't1'), started(A, 't1', { executor: 'codex' })]);
    expect(s1.tasks.t1).toMatchObject({ status: 'in_progress', owner: A, executor: 'codex', startedAt: at(120) });
    expect(s1.staff[A]).toMatchObject({ status: 'working', currentTaskId: 't1', changeSeq: 1 });
    expect(s1.staff[A]!.history).toEqual([{ ts: at(120), status: 'working', message: 'task_started 2' }]);
    const s2 = reduce(s1, started(A, 't1'), index);
    expect(s2.tasks.t1!.startedAt).toBe(at(120));
    expect(s2.staff[A]!.changeSeq).toBe(1);                       // 상태가 같으면 changeSeq가 오르지 않는다
    expect(s2.staff[A]!.history).toHaveLength(1);
  });

  it('task_handoff: 보낸 쪽은 대기, 받는 쪽은 작업 중, 작업 담당·실행 주체가 넘어간다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', B, { executor: 'codex' })]);
    expect(s.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null });
    expect(s.staff[B]).toMatchObject({ status: 'working', currentTaskId: 't1', recentTaskIds: ['t1'] });
    expect(s.tasks.t1).toMatchObject({ owner: B, executor: 'codex', status: 'in_progress' });
    expect(s.handoffs).toEqual([{ seq: 3, ts: at(180), taskId: 't1', from: A, to: B, kind: 'work' }]);
  });

  it('task_handoff kind=review: 받는 쪽은 검토 중, 작업은 검토 중. kind 종류가 handoffs에 남는다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', B, { kind: 'review' })]);
    expect(s.staff[B]).toMatchObject({ status: 'reviewing', currentTaskId: 't1' });
    expect(s.tasks.t1!.status).toBe('in_review');
    expect(s.handoffs[0]!.kind).toBe('review');
    for (const kind of ['revision', 'publish']) {
      const k = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', B, { kind })]);
      expect(k.handoffs[0]!.kind).toBe(kind);
      expect(k.staff[B]!.status).toBe('working');
      expect(k.tasks.t1!.status).toBe('in_progress');
    }
  });

  it('task_handoff: 보낸 쪽이 그 작업을 들고 있지 않았으면 상태를 건드리지 않는다', () => {
    const s = run([created(A, 't1'), created(A, 't2'), started(A, 't2'), handoff(A, 't1', B)]);
    expect(s.staff[A]).toMatchObject({ status: 'working', currentTaskId: 't2' });
    expect(s.staff[B]).toMatchObject({ status: 'working', currentTaskId: 't1' });
  });

  it('task_handoff를 자기 자신에게 하면(수정 요청 등) 작업 중으로 남는다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', A, { kind: 'revision' })]);
    expect(s.staff[A]).toMatchObject({ status: 'working', currentTaskId: 't1' });
  });

  it('task_review_requested: 요청자는 대기, 검토자는 검토 중, 작업은 검토 중', () => {
    const s = run([created(A, 't1'), started(A, 't1'), review(A, 't1', B, { executor: 'script' })]);
    expect(s.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null });
    expect(s.staff[B]).toMatchObject({ status: 'reviewing', currentTaskId: 't1', recentTaskIds: ['t1'] });
    expect(s.tasks.t1).toMatchObject({ owner: B, executor: 'script', status: 'in_review' });
    expect(s.handoffs[0]).toMatchObject({ taskId: 't1', from: A, to: B, kind: 'review' });
  });

  it('approval_requested: 승인 대기, 승인 항목 pending, 대표 서류함으로 가는 handoff. 실행 주체는 그대로', () => {
    const e = askApproval(A, 't1', 't1:A1', { executor: 'script' });
    const s = run([created(A, 't1'), started(A, 't1'), e]);
    expect(s.staff[A]).toMatchObject({ status: 'waiting_approval', currentTaskId: 't1' });
    expect(s.tasks.t1).toMatchObject({ status: 'waiting_approval', executor: 'claude' });
    expect(s.approvals['t1:A1']).toEqual({
      id: 't1:A1', taskId: 't1', requestedBy: A, summary: '요약 t1:A1', status: 'pending', requestedAt: e.ts, decidedAt: null, auto: false,
    });
    expect(s.handoffs[0]).toMatchObject({ taskId: 't1', from: A, to: CEO_ID, kind: 'approval' });
  });

  it('approval_decided: 승인·반려 둘 다 작업은 진행 중으로, 요청자는 대기로, auto 값 기록, 결정 handoff', () => {
    for (const decision of ['approve', 'reject'] as const) {
      const d = decide('t1', 't1:A1', decision, { auto: true });
      const s = run([created(A, 't1'), started(A, 't1'), askApproval(A, 't1', 't1:A1'), d]);
      expect(s.approvals['t1:A1']).toMatchObject({ status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: d.ts, auto: true });
      expect(s.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null });
      expect(s.staff[CEO_ID]!.status).toBe('idle');
      expect(s.tasks.t1).toMatchObject({ status: 'in_progress', executor: 'claude' });          // 사람(human)이 실행 주체가 되지 않는다
      expect(s.handoffs.at(-1)).toMatchObject({ taskId: 't1', from: CEO_ID, to: A, kind: 'decision' });
      expect(s.warnings).toEqual([]);
    }
    const manual = run([created(A, 't1'), askApproval(A, 't1', 't1:A1'), decide('t1', 't1:A1', 'approve')]);
    expect(manual.approvals['t1:A1']!.auto).toBe(false);
  });

  it('approval_decided: 요청자가 이미 다른 상태면 건드리지 않는다', () => {
    const s = run([created(A, 't1'), askApproval(A, 't1', 't1:A1'), status(A, 'blocked'), decide('t1', 't1:A1', 'approve')]);
    expect(s.staff[A]!.status).toBe('blocked');
  });

  it('task_blocked: 직원도 작업도 막힘, 실행 주체 갱신', () => {
    const s = run([created(A, 't1'), started(A, 't1'), blocked(A, 't1', '검사 대기', { executor: 'script' })]);
    expect(s.staff[A]).toMatchObject({ status: 'blocked', currentTaskId: 't1' });
    expect(s.tasks.t1).toMatchObject({ status: 'blocked', executor: 'script' });
  });

  it('task_completed: 완료·종료 시각·대표 사용 분, 직원은 대기', () => {
    const e = completed(A, 't1', { human: 4 });
    const s = run([created(A, 't1'), started(A, 't1'), e]);
    expect(s.tasks.t1).toMatchObject({ status: 'completed', endedAt: e.ts, humanMinutes: 4 });
    expect(s.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null });
    const r = run([created(A, 't1'), started(A, 't1'), completed(A, 't1', { outcome: 'rejected' })]);
    expect(r.tasks.t1).toMatchObject({ status: 'rejected' });
    expect(r.tasks.t1!.endedAt).not.toBeNull();
  });

  it('task_completed: 작업을 들고 있던 이전 담당자도 대기로 돌린다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', B), completed(C, 't1')]);
    expect(s.staff[B]).toMatchObject({ status: 'idle', currentTaskId: null });
    expect(s.staff[C]).toMatchObject({ status: 'idle', currentTaskId: null });
  });

  it('task_completed: 행위자가 다른 작업을 하고 있으면 그 작업은 건드리지 않는다', () => {
    const s = run([created(A, 't1'), created(A, 't2'), started(A, 't2'), completed(A, 't1')]);
    expect(s.staff[A]).toMatchObject({ status: 'working', currentTaskId: 't2' });
  });

  it('staff_status_changed: 상태만 바꾸고 idle·offline이면 현재 작업을 비운다', () => {
    const base = run([created(A, 't1'), started(A, 't1')]);
    const offline = reduce(base, status(A, 'offline'), index);
    expect(offline.staff[A]).toMatchObject({ status: 'offline', currentTaskId: null });
    const idle = reduce(base, status(A, 'idle'), index);
    expect(idle.staff[A]).toMatchObject({ status: 'idle', currentTaskId: null });
    const blockedNow = reduce(base, status(A, 'blocked'), index);
    expect(blockedNow.staff[A]).toMatchObject({ status: 'blocked', currentTaskId: 't1' });
    expect(blockedNow.tasks.t1!.status).toBe('in_progress');      // 작업 상태는 그대로
    const back = reduce(offline, status(A, 'working'), index);
    expect(back.staff[A]).toMatchObject({ status: 'working', currentTaskId: null });
  });

  it('staff_status_changed: 모르는 상태 값은 경고', () => {
    const s = run([status(A, 'sleeping')]);
    expect(s.staff[A]!.status).toBe('idle');
    expect(s.warnings).toEqual(['알 수 없는 상태 값: sleeping']);
  });

  it('상태가 바뀔 때만 changeSeq와 상태 이력이 늘어난다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), status(A, 'working'), status(A, 'idle')]);
    expect(s.staff[A]!.changeSeq).toBe(2);
    expect(s.staff[A]!.history.map((h) => h.status)).toEqual(['working', 'idle']);
  });

  it('행위자의 lastTs·lastMessage는 그 행위자 이벤트로만 갱신된다', () => {
    const h = handoff(A, 't1', B);
    const s = run([created(A, 't1'), started(A, 't1'), h]);
    expect(s.staff[A]).toMatchObject({ lastTs: h.ts, lastMessage: h.message });
    expect(s.staff[B]!.lastTs).toBeNull();
  });
});

describe('경고', () => {
  it('승인 결정 행위자가 대표가 아니면 경고', () => {
    const s = run([created(A, 't1'), askApproval(A, 't1', 't1:A1'), decide('t1', 't1:A1', 'approve', { staff: B })]);
    expect(s.warnings).toEqual([`승인 결정 행위자가 대표가 아님: ${B}`]);
    expect(s.approvals['t1:A1']!.status).toBe('approved');           // 경고만 남기고 결정은 반영한다
  });

  it('승인 결정 실행 주체가 human이 아니면 대표 id여도 경고(EVENT_SPEC §3: ceo·human 조합만)', () => {
    const s = run([created(A, 't1'), askApproval(A, 't1', 't1:A1'), decide('t1', 't1:A1', 'approve', { executor: 'claude' })]);
    expect(s.warnings).toEqual(['승인 결정 실행 주체가 사람(human)이 아님: claude']);
    expect(s.approvals['t1:A1']!.status).toBe('approved');
    const both = run([created(A, 't1'), askApproval(A, 't1', 't1:A1'), decide('t1', 't1:A1', 'reject', { staff: B, executor: 'script' })]);
    expect(both.warnings).toEqual([`승인 결정 행위자가 대표가 아님: ${B}`, '승인 결정 실행 주체가 사람(human)이 아님: script']);
  });

  it('예약된 이름(__proto__·constructor)을 id로 쓴 이벤트는 오류 없이 건너뛰고 경고만 남긴다(스키마를 거치지 않은 경우)', () => {
    const base = run([created(A, 't1')]);
    for (const bad of [
      started('__proto__', 't1'),
      started(A, 'constructor'),
      handoff(A, 't1', '__proto__'),
      review(A, 't1', 'toString'),
      askApproval(A, 't1', '__proto__'),
    ]) {
      const s = reduce(base, bad, index);
      expect(s.warnings).toEqual([`예약된 이름을 id로 쓴 이벤트를 건너뜀: ${bad.event_id}`]);
      expect(s.seq).toBe(base.seq);
      expect(Object.keys(s.staff)).toEqual(Object.keys(base.staff));
      expect(Object.keys(s.tasks)).toEqual(Object.keys(base.tasks));
      expect(Object.getPrototypeOf(s.staff)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(s.approvals)).toBe(Object.prototype);
    }
  });

  it('모르는 승인 번호의 결정은 새로 만들고 경고', () => {
    const s = run([created(A, 't1'), decide('t1', 'nope:A9', 'reject')]);
    expect(s.warnings).toEqual(['모르는 승인 번호: nope:A9']);
    expect(s.approvals['nope:A9']).toMatchObject({ status: 'rejected', taskId: 't1', requestedBy: A });
  });

  it('조직에 없는 행위자는 known:false로 만들고 경고 1줄, 같은 경고는 다시 넣지 않는다', () => {
    const s1 = run([created('zzz-99-e01', 't1')]);
    expect(s1.staff['zzz-99-e01']).toMatchObject({ id: 'zzz-99-e01', known: false, status: 'idle' });
    expect(s1.warnings).toEqual(['조직에 없는 행위자: zzz-99-e01']);
    const s2 = reduce(s1, started('zzz-99-e01', 't1'), index);
    expect(s2.warnings).toEqual(['조직에 없는 행위자: zzz-99-e01']);
    expect(s2.staff['zzz-99-e01']).toMatchObject({ known: false, status: 'working' });
  });

  it('받는 쪽·검토자가 조직에 없어도 만들고 경고, 미배정 id도 조직에 없는 id로 본다', () => {
    const s = run([created(A, 't1'), started(A, 't1'), handoff(A, 't1', 'unassigned:rsc-99-T01'), review('unassigned:rsc-99-T01', 't1', 'nobody-01')]);
    expect(s.staff['unassigned:rsc-99-T01']).toMatchObject({ known: false });
    expect(s.staff['nobody-01']).toMatchObject({ known: false, status: 'reviewing' });
    expect(s.warnings).toEqual(['조직에 없는 행위자: unassigned:rsc-99-T01', '조직에 없는 행위자: nobody-01']);
  });

  it('대표·AI 총괄은 조직에 없는 행위자가 아니다', () => {
    const s = run([created(HQ, 't1'), started(HQ, 't1'), askApproval(HQ, 't1', 't1:A1'), decide('t1', 't1:A1', 'approve')]);
    expect(s.warnings).toEqual([]);
    expect(s.staff[HQ]!.known).toBe(true);
  });

  it('모르는 task_id에 created 외 이벤트가 오면 자리표시 작업(title = task_id)을 만들고 경고', () => {
    const s = run([started(A, 'ghost-1')]);
    expect(s.tasks['ghost-1']).toMatchObject({ id: 'ghost-1', title: 'ghost-1', owner: A, status: 'in_progress' });
    expect(s.warnings).toEqual(['모르는 작업: ghost-1']);
    const t = run([blocked(A, 'ghost-2'), completed(A, 'ghost-3'), handoff(A, 'ghost-4', B), review(A, 'ghost-5', B), askApproval(A, 'ghost-6', 'ghost-6:A1')]);
    for (const id of ['ghost-2', 'ghost-3', 'ghost-4', 'ghost-5', 'ghost-6']) expect(t.tasks[id]!.title).toBe(id);
    expect(t.warnings).toHaveLength(5);
  });

  it('같은 작업을 다시 만들면 경고만 하고 생성 수는 늘리지 않는다', () => {
    const s = run([created(A, 't1'), created(A, 't1', { title: '다시' })]);
    expect(s.warnings).toEqual(['이미 있는 작업을 다시 만듦: t1']);
    expect(s.tasks.t1!.title).toBe('다시');
    expect(s.metrics.createdByExecutor.claude).toBe(1);
  });

  it('작업 번호가 없는 이벤트(스키마를 거치지 않은 경우)는 경고만 남긴다', () => {
    const s = run([ev('task_started', A, null)]);
    expect(s.warnings).toEqual(['작업 번호가 없는 이벤트: task_started']);
    expect(s.seq).toBe(1);
  });
});

describe('metrics', () => {
  it('KST 날짜가 바뀌면 하루 값을 0부터 시작한다', () => {
    const d1 = [created(A, 'a', { ts: '2026-10-17T14:59:59Z', executor: 'aside', payload: { manual_minutes: 10 } }), completed(A, 'a', { ts: '2026-10-17T14:59:59Z', executor: 'aside' })];
    const s1 = run(d1);
    expect(s1.metrics).toMatchObject({ day: '2026-10-17', completed: 1, savedMinutes: 10 });
    expect(s1.metrics.createdByExecutor.aside).toBe(1);
    const s2 = reduce(s1, created(A, 'b', { ts: '2026-10-17T15:00:00Z', executor: 'codex' }), index);     // = 10월 18일 00:00 KST
    expect(s2.metrics.day).toBe('2026-10-18');
    expect(s2.metrics).toMatchObject({ completed: 0, savedMinutes: 0 });
    expect(s2.metrics.createdByExecutor).toEqual({ claude: 0, codex: 1, aside: 0, script: 0, human: 0 });
    expect(s2.tasks.a).toBeDefined();                                  // 작업 자체는 남는다
  });

  it('+09:00 표기와 Z 표기는 같은 KST 날짜로 센다', () => {
    const s = run([created(A, 'a', { ts: '2026-10-17T23:59:59+09:00' }), created(A, 'b', { ts: '2026-10-17T14:00:00Z' }), created(A, 'c', { ts: '2026-10-18T00:00:00+09:00' })]);
    expect(s.metrics.day).toBe('2026-10-18');
    expect(s.metrics.createdByExecutor.claude).toBe(1);
  });

  it('kstDay', () => {
    expect(kstDay('2026-10-17T00:00:00+09:00')).toBe('2026-10-17');
    expect(kstDay('2026-10-16T15:00:00Z')).toBe('2026-10-17');
    expect(kstDay('2026-10-16T14:59:59Z')).toBe('2026-10-16');
    expect(kstDay('2026-12-31T16:00:00Z')).toBe('2027-01-01');
  });

  it('생성은 실행 주체별로 센다', () => {
    const s = run(EXECUTORS.flatMap((x, i) => [created(A, `t${i}`, { executor: x })]));
    expect(s.metrics.createdByExecutor).toEqual({ claude: 1, codex: 1, aside: 1, script: 1, human: 1 });
  });

  it('절약 추정 = max(0, 기준 분 − 대표 사용 분)', () => {
    const one = (manual: number | undefined, human: number | undefined, over: Opts & { owner?: string } = {}): DashboardState => {
      const payload = manual === undefined ? undefined : { manual_minutes: manual };
      return run([
        created(over.owner ?? A, 't1', { ...(payload ? { payload } : {}) }),
        started(over.owner ?? A, 't1'),
        completed(over.owner ?? A, 't1', { ...over, ...(human === undefined ? {} : { human }) }),
      ]);
    };
    expect(one(30, undefined).metrics).toMatchObject({ completed: 1, savedMinutes: 30 });
    expect(one(30, 10).metrics).toMatchObject({ completed: 1, savedMinutes: 20 });
    expect(one(10, 25).metrics).toMatchObject({ completed: 1, savedMinutes: 0 });         // 음수는 0
    expect(one(undefined, 5).metrics).toMatchObject({ completed: 1, savedMinutes: 0 });   // 기준 분 없음: 완료 건수만
  });

  it('대표가 수행한 작업·반려 종료는 완료 건수와 절약에 넣지 않는다', () => {
    const humanExecutor = run([created(A, 't1', { payload: { manual_minutes: 30 } }), completed(A, 't1', { executor: 'human' })]);
    expect(humanExecutor.metrics).toMatchObject({ completed: 0, savedMinutes: 0 });
    const ceoOwner = run([created(CEO_ID, 't1', { payload: { manual_minutes: 30 } }), completed(CEO_ID, 't1', { executor: 'claude' })]);
    expect(ceoOwner.metrics).toMatchObject({ completed: 0, savedMinutes: 0 });
    const rejected = run([created(A, 't1', { payload: { manual_minutes: 30 } }), completed(A, 't1', { outcome: 'rejected' })]);
    expect(rejected.metrics).toMatchObject({ completed: 0, savedMinutes: 0 });
    expect(rejected.tasks.t1!.status).toBe('rejected');
  });

  it('같은 작업이 두 번 완료로 오면 한 번만 센다', () => {
    const s = run([created(A, 't1', { payload: { manual_minutes: 30 } }), completed(A, 't1'), completed(A, 't1')]);
    expect(s.metrics).toMatchObject({ completed: 1, savedMinutes: 30 });
  });
});

describe('순수성', () => {
  const sample = (): PbEvent[] => [
    created(A, 't1', { payload: { manual_minutes: 20 } }), started(A, 't1'), handoff(A, 't1', B, { kind: 'review' }), review(B, 't1', C),
    askApproval(C, 't1', 't1:A1'), decide('t1', 't1:A1', 'approve', { auto: true }), blocked(C, 't1'), completed(C, 't1'), status(A, 'offline'),
    started('zzz-1', 'ghost'),
  ];

  it('입력 상태를 바꾸지 않는다(이전 상태의 JSON이 그대로)', () => {
    let state = initialState(index);
    for (const e of sample()) {
      const before = JSON.stringify(state);
      const next = reduce(state, e, index);
      expect(JSON.stringify(state)).toBe(before);
      expect(next).not.toBe(state);
      state = next;
    }
  });

  it('Object.freeze(깊게)한 상태를 넣어도 오류가 없고 결과도 같다', () => {
    const events = sample();
    const frozenRun = events.reduce((s, e) => reduce(deepFreeze(s), e, index), deepFreeze(initialState(index)));
    expect(JSON.stringify(frozenRun)).toBe(JSON.stringify(run(events)));
  });

  it('reduce를 건건이 부른 결과와 제자리 적용(EventLog가 쓰는 방식)의 결과가 같다', () => {
    const events = sample();
    expect(JSON.stringify(runFast(events))).toBe(JSON.stringify(run(events)));
  });

  it('같은 이벤트 열은 같은 상태를 만든다(시간·난수를 쓰지 않는다)', () => {
    const events = sample();
    expect(JSON.stringify(run(events))).toBe(JSON.stringify(run(events)));
  });

  it('한 번 만든 상태는 이어지는 reduce로 바뀌지 않는다(스냅숏 안전)', () => {
    const events = sample();
    const mid = run(events.slice(0, 5));
    const midJson = JSON.stringify(mid);
    run(events.slice(5), mid);
    expect(JSON.stringify(mid)).toBe(midJson);
  });

  it('lastTs는 가장 늦은 ts(늦게 온 이전 시각 이벤트가 되돌리지 않는다)', () => {
    const s = run([created(A, 't1', { ts: at(500) }), started(A, 't1', { ts: at(100) })]);
    expect(s.lastTs).toBe(at(500));
  });
});

describe('상한', () => {
  it('피드 300 · 직원 상태 이력 30', () => {
    const events: PbEvent[] = [];
    for (let i = 0; i < 400; i += 1) events.push(status(A, i % 2 ? 'working' : 'idle'));
    const s = run(events);
    expect(s.feed).toHaveLength(LIMITS.feed);
    expect(s.feed[0]!.seq).toBe(101);
    expect(s.feed.at(-1)!.seq).toBe(400);
    expect(s.staff[A]!.history).toHaveLength(LIMITS.staffHistory);
    expect(s.staff[A]!.history.at(-1)!.ts).toBe(at(400 * 60));
  });

  it('handoffs 50 · 작업 이력 50 · 최근 작업 10', () => {
    const events: PbEvent[] = [created(A, 't0'), started(A, 't0')];
    for (let i = 0; i < 70; i += 1) events.push(handoff(i % 2 ? B : A, 't0', i % 2 ? A : B));
    const s = run(events);
    expect(s.handoffs).toHaveLength(LIMITS.handoffs);
    expect(s.tasks.t0!.history).toHaveLength(LIMITS.taskHistory);
    const many: PbEvent[] = [];
    for (let i = 0; i < 15; i += 1) many.push(created(A, `r${i}`));
    const r = run(many);
    expect(r.staff[A]!.recentTaskIds).toEqual(Array.from({ length: 10 }, (_, i) => `r${14 - i}`));
    const again = reduce(r, started(A, 'r10'), index);                 // 다시 쓰면 중복 없이 맨 앞으로
    expect(again.staff[A]!.recentTaskIds[0]).toBe('r10');
    expect(new Set(again.staff[A]!.recentTaskIds).size).toBe(again.staff[A]!.recentTaskIds.length);
    expect(again.staff[A]!.recentTaskIds).toHaveLength(10);
  });

  it('경고 50: 가장 최근 것이 남는다', () => {
    const events: PbEvent[] = [];
    for (let i = 0; i < 70; i += 1) events.push(created(`zz-${i}`, `t${i}`));
    const s = run(events);
    expect(s.warnings).toHaveLength(LIMITS.warnings);
    expect(s.warnings.at(-1)).toBe('조직에 없는 행위자: zz-69');
    expect(s.warnings[0]).toBe('조직에 없는 행위자: zz-20');
  });

  it('작업이 1500개를 넘으면 끝난 오래된 작업부터 1000개로 줄이고, 진행 중·최근 작업은 남긴다', () => {
    const events: PbEvent[] = [created(B, 'keep-open'), started(B, 'keep-open')];            // 진행 중 작업은 지워지지 않는다
    for (let i = 0; i < 1600; i += 1) {
      events.push(created(A, `k${i}`), started(A, `k${i}`), completed(A, `k${i}`));
    }
    const s = runFast(events);
    const ids = Object.keys(s.tasks);
    expect(ids.length).toBeLessThanOrEqual(1500);
    expect(ids.length).toBeGreaterThan(1000);
    expect(s.tasks['keep-open']).toBeDefined();
    for (const id of s.staff[A]!.recentTaskIds) expect(s.tasks[id], id).toBeDefined();
    // 가장 오래된 끝난 작업이 먼저 지워졌다
    expect(s.tasks.k0).toBeUndefined();
    expect(s.tasks.k1599).toBeDefined();
    // 남은 끝난 작업은 연속 구간이다(오래된 순으로만 지움)
    const firstKept = Math.min(...ids.filter((id) => id.startsWith('k')).map((id) => Number(id.slice(1))));
    for (let i = firstKept; i < 1600; i += 1) expect(s.tasks[`k${i}`], `k${i}`).toBeDefined();
  });

  it('줄이기는 결정적이다: 같은 이벤트 열이면 같은 작업이 남는다', () => {
    const events: PbEvent[] = [];
    for (let i = 0; i < 1550; i += 1) events.push(created(i % 2 ? A : B, `k${i}`), completed(i % 2 ? A : B, `k${i}`));
    const a = Object.keys(runFast(events).tasks);
    const b = Object.keys(runFast(events).tasks);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(1500);
    expect(a.length).toBeGreaterThan(1000);
  });

  it('결정된 승인은 최근 100개만 남기고 대기 중인 승인은 전부 남긴다', () => {
    const events: PbEvent[] = [created(A, 'pending-task'), askApproval(A, 'pending-task', 'pending-task:A1')];
    for (let i = 0; i < 130; i += 1) {
      events.push(created(B, `d${i}`), askApproval(B, `d${i}`, `d${i}:A1`), decide(`d${i}`, `d${i}:A1`, 'approve'));
    }
    const s = runFast(events);
    const all = Object.values(s.approvals);
    expect(all.filter((a) => a.status === 'pending').map((a) => a.id)).toEqual(['pending-task:A1']);
    expect(all.filter((a) => a.status !== 'pending')).toHaveLength(LIMITS.decidedApprovals);
    expect(s.approvals['d0:A1']).toBeUndefined();
    expect(s.approvals['d129:A1']).toBeDefined();
  });
});
