// 시나리오 1회 실행기: 시나리오 단계(steps)를 한 단계씩 이벤트 초안으로 바꾼다(docs/DESIGN.md §5).
// 시간은 '1배속 실제 초(τ)'로 센다. 시각(ts)·이벤트 id는 엔진이 붙인다.
// 현재 담당자·실행 주체는 이 실행기가 직접 추적한다(리듀서 상태에 기대지 않는다).
// 작업 id `시나리오id#회차/로컬id`, 승인 id `작업id:A<n>`(작업별 1부터).
import { CEO_ID, STAFF_STATUS_LABEL, UNASSIGNED_PREFIX } from '../types';
import type { ActorRef, Executor, OrgIndex, PbEvent, Scenario, ScenarioStep } from '../types';
import { resolveActor } from '../core/resolve';

/** 엔진이 ts·event_id를 붙이기 전의 이벤트 */
export type EventDraft = Omit<PbEvent, 'event_id' | 'ts' | 'v'>;

/** 본 단계 + on_approve 단계(중첩 포함)의 after 합 = 승인을 바로 받았을 때 1배속 실제 초 */
export function scenarioRealSeconds(s: Scenario): number {
  const sum = (steps: readonly ScenarioStep[]): number => {
    let total = 0;
    for (const st of steps) {
      total += st.after;
      if (st.do === 'approval') total += sum(st.on_approve);
    }
    return total;
  };
  return sum(s.steps);
}

/** 시나리오의 모든 ActorRef(on_approve·on_reject 중첩 포함) */
export function collectActorRefs(steps: readonly ScenarioStep[]): ActorRef[] {
  const out: ActorRef[] = [];
  for (const st of steps) {
    if (st.do === 'create' || st.do === 'status') out.push(st.actor);
    if ((st.do === 'start' || st.do === 'review' || st.do === 'approval' || st.do === 'block' || st.do === 'complete') && st.actor) out.push(st.actor);
    if (st.do === 'handoff') {
      out.push(st.to);
      if (st.from) out.push(st.from);
    }
    if (st.do === 'review') out.push(st.reviewer);
    if (st.do === 'approval') out.push(...collectActorRefs(st.on_approve), ...collectActorRefs(st.on_reject));
  }
  return out;
}

interface TaskTrack { owner: string; executor: Executor; done: boolean; approvals: number }
interface Frame { steps: readonly ScenarioStep[]; i: number }
interface PendingApproval { approvalId: string; taskId: string; onApprove: readonly ScenarioStep[]; onReject: readonly ScenarioStep[] }

/** 다음 단계의 계획: 관여하는 행위자와 낼 이벤트. commit()을 불러야 추적 상태가 바뀐다. */
export interface PlannedStep {
  step: ScenarioStep;
  actors: string[];
  draft: EventDraft;
  approvalId?: string;
  commit(): void;
}

export class ScenarioRun {
  readonly scenarioId: string;
  readonly runNo: number;
  private readonly scenario: Scenario;
  private readonly index: OrgIndex;
  private readonly warnSink: (message: string) => void;
  private readonly frames: Frame[];
  private readonly tasks = new Map<string, TaskTrack>();
  private readonly parked = new Set<string>();      // status 단계로 대기가 아닌 상태가 된 행위자
  private readonly warned = new Set<string>();
  private pending: PendingApproval | null = null;
  private lastTau: number;

  constructor(scenario: Scenario, runNo: number, index: OrgIndex, startTau: number, warn: (message: string) => void = () => undefined) {
    this.scenario = scenario;
    this.scenarioId = scenario.id;
    this.runNo = runNo;
    this.index = index;
    this.warnSink = warn;
    this.frames = [{ steps: scenario.steps, i: 0 }];
    this.lastTau = startTau;
  }

  /** 로컬 작업 id → 전체 작업 id */
  taskId(local: string): string {
    return `${this.scenario.id}#${this.runNo}/${local}`;
  }

  /** 다음 단계가 실행될 τ. 승인을 기다리는 중이거나 끝났으면 null */
  nextDue(): number | null {
    if (this.pending) return null;
    const step = this.current();
    return step ? this.lastTau + step.after : null;
  }

  isDone(): boolean {
    return this.pending === null && this.current() === null;
  }

  pendingApprovalId(): string | null {
    return this.pending?.approvalId ?? null;
  }

  /** 아직 끝나지 않은 작업의 담당자 + 대기가 아닌 상태로 둔 행위자(한가한 활동이 건드리지 않는다) */
  busyActors(): Set<string> {
    const out = new Set<string>(this.parked);
    for (const t of this.tasks.values()) if (!t.done) out.add(t.owner);
    return out;
  }

  /** 다음 단계의 계획(추적 상태는 바꾸지 않는다). 다음 단계가 없으면 null */
  peek(): PlannedStep | null {
    if (this.pending) return null;
    const step = this.current();
    return step ? this.plan(step) : null;
  }

  /** 다음 단계를 실제로 실행한다: 추적 상태를 바꾸고 커서를 옮긴다. 승인 단계면 결정이 올 때까지 멈춘다. */
  take(tau: number): EventDraft | null {
    if (this.pending) return null;
    const step = this.current();
    if (!step) return null;
    const planned = this.plan(step);
    planned.commit();
    this.frames[this.frames.length - 1]!.i += 1;
    this.lastTau = tau;
    if (step.do === 'approval' && planned.approvalId) {
      this.pending = { approvalId: planned.approvalId, taskId: planned.draft.task_id ?? '', onApprove: step.on_approve, onReject: step.on_reject };
    }
    return planned.draft;
  }

  /** 승인 결정: approval_decided 초안을 내고 on_approve·on_reject 분기를 이어서 실행하게 한다. 대기 중인 승인이 아니면 null */
  decide(decision: 'approve' | 'reject', auto: boolean, tau: number): EventDraft | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    const branch = decision === 'approve' ? p.onApprove : p.onReject;
    if (branch.length) this.frames.push({ steps: branch, i: 0 });
    this.lastTau = tau;
    const message = auto
      ? (decision === 'approve' ? '시뮬레이션 자동 승인' : '시뮬레이션 자동 반려')
      : (decision === 'approve' ? '대표 승인(시뮬레이션)' : '대표 반려(시뮬레이션)');
    return {
      type: 'approval_decided',
      staff_id: CEO_ID,
      executor: 'human',
      task_id: p.taskId,
      message,
      payload: { approval_id: p.approvalId, decision, auto },
    };
  }

  /* ───────────── 내부 ───────────── */

  private current(): ScenarioStep | null {
    while (this.frames.length) {
      const top = this.frames[this.frames.length - 1]!;
      if (top.i < top.steps.length) return top.steps[top.i]!;
      this.frames.pop();
    }
    return null;
  }

  private warn(message: string): void {
    this.warnSink(message);
  }

  private actor(ref: ActorRef): string {
    const r = resolveActor(ref, this.index);
    if (!r.ok) {
      const key = typeof ref === 'string' ? ref : JSON.stringify(ref);
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.warn(`행위자를 찾지 못함: ${key}`);
      }
    }
    return r.id;
  }

  private track(local: string): TaskTrack {
    let t = this.tasks.get(local);
    if (!t) {
      this.warn(`만들지 않은 작업을 쓰는 단계: ${this.scenario.id}/${local}`);
      t = { owner: `${UNASSIGNED_PREFIX}${local}`, executor: 'script', done: false, approvals: 0 };
      this.tasks.set(local, t);
    }
    return t;
  }

  private plan(step: ScenarioStep): PlannedStep {
    const message = step.message;
    switch (step.do) {
      case 'create': {
        const actor = this.actor(step.actor);
        const payload: Record<string, unknown> = { title: step.title };
        if (step.parent) payload.parent_task_id = this.taskId(step.parent);
        if (step.duty) payload.duty = step.duty;
        if (step.manual_minutes !== undefined) payload.manual_minutes = step.manual_minutes;
        return {
          step, actors: [actor],
          draft: { type: 'task_created', staff_id: actor, executor: step.executor, task_id: this.taskId(step.task), message: message ?? `작업 생성: ${step.title}`, payload },
          commit: () => { this.tasks.set(step.task, { owner: actor, executor: step.executor, done: false, approvals: 0 }); },
        };
      }
      case 'start': {
        const tr = this.track(step.task);
        const actor = step.actor ? this.actor(step.actor) : tr.owner;
        const executor = step.executor ?? tr.executor;
        return {
          step, actors: [actor],
          draft: { type: 'task_started', staff_id: actor, executor, task_id: this.taskId(step.task), message: message ?? '작업 시작' },
          commit: () => { tr.owner = actor; tr.executor = executor; },
        };
      }
      case 'handoff': {
        const tr = this.track(step.task);
        const from = step.from ? this.actor(step.from) : tr.owner;
        const to = this.actor(step.to);
        return {
          step, actors: [from, to],
          draft: {
            type: 'task_handoff', staff_id: from, executor: step.executor, task_id: this.taskId(step.task),
            message: message ?? `${this.index.actorName(to)}에게 전달`, payload: { to, kind: step.kind ?? 'work' },
          },
          commit: () => { tr.owner = to; tr.executor = step.executor; },
        };
      }
      case 'review': {
        const tr = this.track(step.task);
        const actor = step.actor ? this.actor(step.actor) : tr.owner;
        const reviewer = this.actor(step.reviewer);
        return {
          step, actors: [actor, reviewer],
          draft: {
            type: 'task_review_requested', staff_id: actor, executor: step.executor, task_id: this.taskId(step.task),
            message: message ?? `${this.index.actorName(reviewer)}에게 검토 요청`, payload: { reviewer },
          },
          commit: () => { tr.owner = reviewer; tr.executor = step.executor; },
        };
      }
      case 'approval': {
        const tr = this.track(step.task);
        const actor = step.actor ? this.actor(step.actor) : tr.owner;
        const executor = step.executor ?? tr.executor;
        const taskId = this.taskId(step.task);
        const approvalId = `${taskId}:A${tr.approvals + 1}`;
        return {
          step, actors: [actor], approvalId,
          draft: {
            type: 'approval_requested', staff_id: actor, executor, task_id: taskId,
            message: message ?? step.summary, payload: { approval_id: approvalId, summary: step.summary },
          },
          commit: () => { tr.approvals += 1; },     // 승인 요청·결정은 작업의 담당자·실행 주체를 바꾸지 않는다(리듀서와 같게)
        };
      }
      case 'block': {
        const tr = this.track(step.task);
        const actor = step.actor ? this.actor(step.actor) : tr.owner;
        const executor = step.executor ?? tr.executor;
        return {
          step, actors: [actor],
          draft: { type: 'task_blocked', staff_id: actor, executor, task_id: this.taskId(step.task), message: message ?? step.reason, payload: { reason: step.reason } },
          commit: () => { tr.executor = executor; },
        };
      }
      case 'complete': {
        const tr = this.track(step.task);
        const actor = step.actor ? this.actor(step.actor) : tr.owner;
        const executor = step.executor ?? tr.executor;
        const payload: Record<string, unknown> = {};
        if (step.outcome !== undefined) payload.outcome = step.outcome;
        if (step.human_minutes !== undefined) payload.human_minutes = step.human_minutes;
        const draft: EventDraft = {
          type: 'task_completed', staff_id: actor, executor, task_id: this.taskId(step.task),
          message: message ?? (step.outcome === 'rejected' ? '반려로 종료' : '완료'),
        };
        if (Object.keys(payload).length) draft.payload = payload;
        return { step, actors: [actor], draft, commit: () => { tr.executor = executor; tr.done = true; } };
      }
      case 'status': {
        const actor = this.actor(step.actor);
        return {
          step, actors: [actor],
          draft: {
            type: 'staff_status_changed', staff_id: actor, executor: step.executor ?? 'script', task_id: null,
            message: message ?? STAFF_STATUS_LABEL[step.status], payload: { status: step.status },
          },
          commit: () => {
            if (step.status === 'idle') this.parked.delete(actor);
            else this.parked.add(actor);
          },
        };
      }
    }
  }
}
