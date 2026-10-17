// 시뮬레이션 엔진(결정적): 하루 계획의 구간을 차례로 재생하며 시나리오 단계·한가한 활동·자동 승인을 이벤트로 낸다(docs/DESIGN.md §5).
// 시간은 '1배속 실제 초(τ)'다. 재생 속도(1·2·5)는 SimulatorSource가 실제 경과에 곱해 τ로 넘기므로 엔진은 속도를 모른다.
// 예정된 일(시나리오 단계·한가한 작업 단계·자동 승인·구간 끝)은 τ 순서로 하나씩 처리하므로
// advance를 몇 번에 나눠 부르든 같은 이벤트 열(같은 ts)이 나온다. 시뮬레이션 시각은 구간 기준점에서 비율로 계산해 오차가 쌓이지 않는다.
import type { DaySegment, OrgIndex, PbEvent } from '../types';
import { ScenarioRun, scenarioRealSeconds } from './compile';
import type { EventDraft } from './compile';
import { IdleActivity, nextSpawnDelay } from './idle';
import type { IdleStepKind } from './idle';
import type { ScenarioLibrary } from './load';
import { createRng } from './rng';
import type { Rng } from './rng';

const KST_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;
/** 자동 승인까지 1배속 실제 초(실제로는 ÷속도) */
export const AUTO_APPROVE_TAU = 20;
const SCENARIO_IDLE_FACTOR = 0.5;            // 시나리오가 도는 동안 한가한 작업 빈도
const SOLO_LEAD_MIN = 10;                    // 시나리오 하나만 고르면: 시작 10분 전부터 한가한 15초 → 시나리오 → 끝+20분까지 한가한 30초
const SOLO_LEAD_REAL_S = 15;
const SOLO_TAIL_MIN = 20;
const SOLO_TAIL_REAL_S = 30;

/* ───────────── 시각 도우미(KST) ───────────── */

/** 에포크 ms → KST 날짜 YYYY-MM-DD */
export function kstDateOf(ms: number): string {
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}

/** 에포크 ms → `YYYY-MM-DDTHH:mm:ss+09:00`(초 아래는 버린다) */
export function formatKst(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000 + KST_MS).toISOString().slice(0, 19)}+09:00`;
}

const absMs = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+09:00`);
const addDays = (date: string, n: number): string => kstDateOf(Date.parse(`${date}T00:00:00+09:00`) + n * DAY_MS);
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/* ───────────── 계획 해석 ───────────── */

interface ResolvedPlan { selectedId: string; start: string; segments: DaySegment[] }

function resolvePlan(library: ScenarioLibrary, id: string, warn: (m: string) => void): ResolvedPlan {
  const plan = library.plans.get(id);
  if (plan) return { selectedId: plan.id, start: plan.start, segments: plan.segments };
  const sc = library.scenarios.get(id);
  if (sc) {
    const startMin = toMinutes(sc.start);
    const endMin = Math.min(23 * 60 + 59, startMin + Math.ceil(sc.virtual_minutes) + SOLO_TAIL_MIN);
    return {
      selectedId: sc.id,
      start: toHhmm(Math.max(0, startMin - SOLO_LEAD_MIN)),
      segments: [
        { idle: true, until: sc.start, real_seconds: SOLO_LEAD_REAL_S },
        { scenario: sc.id },
        { idle: true, until: toHhmm(endMin), real_seconds: SOLO_TAIL_REAL_S },
      ],
    };
  }
  warn(`없는 시나리오 '${id}' — 기본 재생으로 바꿉니다`);
  const fallback = library.plans.get('day') ?? library.plans.values().next().value;
  if (fallback) return { selectedId: fallback.id, start: fallback.start, segments: fallback.segments };
  const first = library.scenarios.values().next().value;
  if (first) return resolvePlan(library, first.id, warn);
  return { selectedId: id, start: '09:00', segments: [{ idle: true, until: '18:00', real_seconds: 120 }] };
}

/* ───────────── 엔진 ───────────── */

export interface EngineOptions {
  index: OrgIndex;
  library: ScenarioLibrary;
  seed: number;
  scenario: string;
  startDate: string;                  // YYYY-MM-DD(KST)
  autoApprove: boolean;
}

type TimerKind = 'segmentEnd' | 'scenarioStep' | 'idleSpawn' | 'idleStep' | 'autoApprove';
interface Timer {
  due: number;
  seq: number;
  kind: TimerKind;
  taskId?: string;
  step?: IdleStepKind;
  approvalId?: string;
  untilMs?: number;
}

const NO_BUSY: ReadonlySet<string> = new Set<string>();

export class SimEngine {
  /** 시나리오 해석 경고(같은 문구는 한 번만) */
  readonly warnings: string[] = [];
  private readonly index: OrgIndex;
  private readonly library: ScenarioLibrary;
  private readonly seed: number;
  private readonly startDate: string;
  private autoApprove: boolean;

  private rng!: Rng;
  private idle!: IdleActivity;
  private plan!: ResolvedPlan;
  private timers: Timer[] = [];
  private timerSeq = 0;
  private tau = 0;
  private resetNo = 0;
  private eventNo = 0;
  private lastEventMs = Number.NEGATIVE_INFINITY;
  private date = '';
  private runNo = 1;
  private segIdx = 0;
  private run: ScenarioRun | null = null;
  private readonly approvalDue = new Map<string, number>();
  private anchorTau = 0;
  private anchorMs = 0;
  private ratio = 0;                      // τ 1초당 시뮬레이션 ms

  constructor(opts: EngineOptions) {
    this.index = opts.index;
    this.library = opts.library;
    this.seed = opts.seed;
    this.startDate = opts.startDate;
    this.autoApprove = opts.autoApprove;
    this.init(opts.scenario);
  }

  /** 지금 재생 중인 하루 계획 또는 시나리오의 id */
  get scenarioId(): string {
    return this.plan.selectedId;
  }

  /** 지금 시뮬레이션 날짜(KST, YYYY-MM-DD) */
  get currentDate(): string {
    return this.date;
  }

  /** 하루 계획이 몇 번째 회차인가(1부터) */
  get currentRunNo(): number {
    return this.runNo;
  }

  /** 지금 시뮬레이션 시각(ISO, +09:00) */
  clock(): string {
    return formatKst(this.virtualMs(this.tau));
  }

  /** 전부 처음으로 되돌린다(같은 시작 날짜·같은 시드, 회차 1). 이벤트 id는 reset 번호가 올라가 겹치지 않는다. */
  reset(scenarioId?: string): void {
    this.resetNo += 1;
    this.init(scenarioId ?? this.plan.selectedId);
  }

  getAutoApprove(): boolean {
    return this.autoApprove;
  }

  /** 끄면 대기 중인 자동 승인 예약을 취소하고, 켜면 대기 중인 승인마다 그때부터 20초(τ)를 다시 센다. */
  setAutoApprove(on: boolean): void {
    if (on === this.autoApprove) return;
    this.autoApprove = on;
    this.timers = this.timers.filter((t) => t.kind !== 'autoApprove');
    this.approvalDue.clear();
    if (on) {
      const pending = this.run?.pendingApprovalId();
      if (pending) this.armAutoApprove(pending);
    }
  }

  /** 자동 승인까지 남은 τ초. 자동 승인 대상이 아니면 null */
  autoApproveRemainingTau(approvalId: string): number | null {
    const due = this.approvalDue.get(approvalId);
    return due === undefined ? null : Math.max(0, due - this.tau);
  }

  pendingApprovalIds(): string[] {
    const id = this.run?.pendingApprovalId();
    return id ? [id] : [];
  }

  /** 사용자가 승인·반려한다. 대기 중인 승인이 아니면 아무것도 하지 않는다. */
  decide(approvalId: string, decision: 'approve' | 'reject', auto = false): PbEvent[] {
    const out: PbEvent[] = [];
    this.decideInternal(approvalId, decision, auto, out);
    return out;
  }

  /** τ초만큼 진행하며 그 사이 일어난 이벤트를 시간 순으로 돌려준다. */
  advance(dTau: number): PbEvent[] {
    const out: PbEvent[] = [];
    if (!(dTau > 0)) return out;
    const target = this.tau + dTau;
    for (let guard = 0; guard < 200000; guard += 1) {
      const next = this.takeNextTimer(target);
      if (!next) break;
      if (next.due > this.tau) this.tau = next.due;
      this.handle(next, out);
    }
    this.tau = target;
    return out;
  }

  /* ───────────── 초기화·시계 ───────────── */

  private init(scenarioId: string): void {
    this.warnings.length = 0;
    this.rng = createRng(this.seed);
    this.idle = new IdleActivity(this.index, this.library.idle, this.rng);
    this.timers = [];
    this.timerSeq = 0;
    this.tau = 0;
    this.eventNo = 0;
    this.lastEventMs = Number.NEGATIVE_INFINITY;
    this.run = null;
    this.approvalDue.clear();
    this.date = this.startDate;
    this.runNo = 1;
    this.segIdx = 0;
    this.plan = resolvePlan(this.library, scenarioId, (m) => this.warn(m));
    this.anchorTau = 0;
    this.anchorMs = absMs(this.date, this.plan.start);
    this.ratio = 0;
    this.nextSegment();
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private virtualMs(tau: number): number {
    return this.anchorMs + this.ratio * (tau - this.anchorTau);
  }

  private anchor(ms: number, ratioMsPerTau: number): void {
    this.anchorTau = this.tau;
    this.anchorMs = ms;
    this.ratio = ratioMsPerTau;
  }

  private makeEvent(d: EventDraft): PbEvent {
    const ms = Math.max(this.lastEventMs, Math.floor(Math.round(this.virtualMs(this.tau)) / 1000) * 1000);   // 시계는 거꾸로 가지 않는다
    this.lastEventMs = ms;
    this.eventNo += 1;
    const event: PbEvent = {
      v: 1,
      event_id: `sim-${this.seed}-${this.resetNo}-${this.eventNo}`,
      ts: formatKst(ms),
      type: d.type,
      staff_id: d.staff_id,
      executor: d.executor,
      task_id: d.task_id,
      message: d.message,
    };
    if (d.payload) event.payload = d.payload;
    return event;
  }

  /* ───────────── 예약 목록 ───────────── */

  private addTimer(t: Omit<Timer, 'seq'>): void {
    this.timerSeq += 1;
    this.timers.push({ ...t, seq: this.timerSeq });
  }

  /** target 이하에 예정된 것 중 가장 이른 것을 꺼낸다(같은 τ면 먼저 예약한 것) */
  private takeNextTimer(target: number): Timer | null {
    let best = -1;
    for (let i = 0; i < this.timers.length; i += 1) {
      const t = this.timers[i]!;
      if (t.due > target) continue;
      if (best < 0) best = i;
      else {
        const b = this.timers[best]!;
        if (t.due < b.due || (t.due === b.due && t.seq < b.seq)) best = i;
      }
    }
    return best < 0 ? null : this.timers.splice(best, 1)[0]!;
  }

  private handle(timer: Timer, out: PbEvent[]): void {
    switch (timer.kind) {
      case 'segmentEnd':
        if (timer.untilMs !== undefined) this.anchor(timer.untilMs, 0);     // 구간 끝 시각에 정확히 맞춘다
        this.nextSegment();
        return;
      case 'scenarioStep':
        this.runScenarioStep(out);
        return;
      case 'idleSpawn':
        this.spawnIdle(out);
        this.scheduleSpawn();
        return;
      case 'idleStep': {
        if (!timer.taskId || !timer.step) return;
        const busy = this.busySet();
        for (const d of this.idle.fire(timer.taskId, timer.step, (id) => this.isBusy(id, busy))) out.push(this.makeEvent(d));
        return;
      }
      case 'autoApprove':
        if (this.autoApprove && timer.approvalId) this.decideInternal(timer.approvalId, 'approve', true, out);
        return;
    }
  }

  /* ───────────── 구간 ───────────── */

  private nextSegment(): void {
    const total = this.plan.segments.length;
    let skipped = 0;
    for (let guard = 0; guard < 10000; guard += 1) {
      if (this.segIdx >= total) {
        this.wrapDay();
        if (skipped >= total) {      // 한 바퀴 내내 쓸 구간이 없었다 — 멈추지 않도록 1초 쉰다
          this.anchor(this.virtualMs(this.tau), 0);
          this.addTimer({ due: this.tau + 1, kind: 'segmentEnd' });
          this.scheduleSpawn();
          return;
        }
        continue;
      }
      const seg = this.plan.segments[this.segIdx]!;
      this.segIdx += 1;
      const now = this.virtualMs(this.tau);
      if ('idle' in seg) {
        const untilMs = absMs(this.date, seg.until);
        if (!(untilMs > now)) {      // 이미 지났으면 건너뜀
          skipped += 1;
          continue;
        }
        const real = Math.max(seg.real_seconds, 0.001);
        this.anchor(now, (untilMs - now) / real);
        this.addTimer({ due: this.tau + real, kind: 'segmentEnd', untilMs });
        this.scheduleSpawn();
        return;
      }
      const sc = this.library.scenarios.get(seg.scenario);
      if (!sc) {
        this.warn(`하루 계획이 없는 시나리오를 가리킴: ${seg.scenario}`);
        skipped += 1;
        continue;
      }
      // 시나리오 시작 시각이 지금보다 늦으면 그 시각으로 앞당기고, 이르면 지금 시각 그대로 시작한다
      const from = Math.max(now, absMs(this.date, sc.start));
      const real = Math.max(scenarioRealSeconds(sc), 0.001);
      this.anchor(from, (sc.virtual_minutes * 60000) / real);
      this.run = new ScenarioRun(sc, this.runNo, this.index, this.tau, (m) => this.warn(m));
      this.armScenario();
      this.scheduleSpawn();
      return;
    }
  }

  /** 계획 끝: 날짜 +1, 계획 시작 시각부터 다시(회차 +1). 시계는 거꾸로 가지 않는다. */
  private wrapDay(): void {
    this.date = addDays(this.date, 1);
    this.runNo += 1;
    this.segIdx = 0;
    this.anchor(Math.max(this.virtualMs(this.tau), absMs(this.date, this.plan.start)), 0);
  }

  /* ───────────── 시나리오 ───────────── */

  private armScenario(): void {
    const due = this.run?.nextDue();
    if (due !== null && due !== undefined) this.addTimer({ due, kind: 'scenarioStep' });
  }

  private runScenarioStep(out: PbEvent[]): void {
    const run = this.run;
    if (!run) return;
    const planned = run.peek();
    if (!planned) {
      this.afterScenarioProgress();
      return;
    }
    // 한가한 작업 중인 직원에게 시나리오 이벤트를 내야 하면 그 한가한 작업을 먼저 끝낸다
    for (const actor of new Set(planned.actors)) {
      for (const d of this.idle.finishHolder(actor)) out.push(this.makeEvent(d));
    }
    const draft = run.take(this.tau);
    if (draft) out.push(this.makeEvent(draft));
    this.afterScenarioProgress();
  }

  private afterScenarioProgress(): void {
    const run = this.run;
    if (!run) return;
    const pending = run.pendingApprovalId();
    if (pending) {
      if (this.autoApprove && !this.approvalDue.has(pending)) this.armAutoApprove(pending);
      return;
    }
    if (run.isDone()) {
      this.run = null;
      this.nextSegment();
      return;
    }
    this.armScenario();
  }

  private armAutoApprove(approvalId: string): void {
    const due = this.tau + AUTO_APPROVE_TAU;
    this.approvalDue.set(approvalId, due);
    this.addTimer({ due, kind: 'autoApprove', approvalId });
  }

  private decideInternal(approvalId: string, decision: 'approve' | 'reject', auto: boolean, out: PbEvent[]): void {
    const run = this.run;
    if (!run || run.pendingApprovalId() !== approvalId) return;
    const draft = run.decide(decision, auto, this.tau);
    if (!draft) return;
    this.approvalDue.delete(approvalId);
    this.timers = this.timers.filter((t) => !(t.kind === 'autoApprove' && t.approvalId === approvalId));
    out.push(this.makeEvent(draft));
    this.afterScenarioProgress();
  }

  /* ───────────── 한가한 활동 ───────────── */

  private busySet(): ReadonlySet<string> {
    return this.run ? this.run.busyActors() : NO_BUSY;
  }

  private isBusy(id: string, scenarioBusy: ReadonlySet<string>): boolean {
    return scenarioBusy.has(id) || this.idle.isHolder(id);
  }

  /** 다음 새 한가한 작업 시각을 다시 뽑는다(시나리오가 도는 동안은 빈도를 절반으로). 지수 분포라 다시 뽑아도 통계가 같다. */
  private scheduleSpawn(): void {
    this.timers = this.timers.filter((t) => t.kind !== 'idleSpawn');
    const delay = nextSpawnDelay(this.library.idle, this.run ? SCENARIO_IDLE_FACTOR : 1, this.rng);
    if (delay !== null) this.addTimer({ due: this.tau + delay, kind: 'idleSpawn' });
  }

  private spawnIdle(out: PbEvent[]): void {
    const busy = this.busySet();
    const spawned = this.idle.spawn((id) => this.isBusy(id, busy));
    if (!spawned) return;
    for (const d of spawned.drafts) out.push(this.makeEvent(d));
    for (const item of spawned.schedule) {
      this.addTimer({ due: this.tau + item.at, kind: 'idleStep', taskId: item.taskId, step: item.step });
    }
  }
}
