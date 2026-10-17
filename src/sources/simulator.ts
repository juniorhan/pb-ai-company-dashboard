// 시뮬레이션 소스: SimEngine(결정적 엔진)을 실제 시계 tick으로 돌려 이벤트를 낸다. 재생·속도·시나리오·자동 승인 조작(SimControl)을 함께 준다.
// 시계·타이머를 주입할 수 있어 시험에서는 가짜 시계로 끝까지 돌린다(docs/DESIGN.md §5).
import { SimEngine, kstDateOf } from '../sim/engine';
import type { ScenarioLibrary } from '../sim/load';
import type { EventSource, OrgIndex, PbEvent, ScenarioInfo, SimControl } from '../types';
import { SourceBase, safeCall } from './base';

export const SIM_SPEEDS = [1, 2, 5] as const;
const TICK_NOTIFY_MIN_MS = 250;           // subscribeTick은 초당 최대 4회
const MAX_STEP_REAL_MS = 60_000;          // 절전·백그라운드 뒤에 한꺼번에 몇 시간을 돌리지 않도록 tick 한 번이 앞으로 보내는 실제 시간 상한

export interface SimulatorOptions {
  index: OrgIndex;
  library: ScenarioLibrary;
  seed: number;
  scenario?: string;                  // 기본 'day'
  speed?: number;                     // 기본 1
  autoApprove?: boolean;              // 기본 true
  startDate?: string;                 // YYYY-MM-DD(KST). 기본 오늘(KST)
  now?: () => number;                 // 실제 ms. 기본 Date.now
  setTimer?: (fn: () => void, ms: number) => () => void;   // 시간이 지나면 fn을 부르고, 취소 함수를 돌려준다. 기본 setTimeout
  tickMs?: number;                    // 기본 250
}

/** 1·2·5 중 가장 가까운 값(같은 거리면 작은 쪽). 숫자가 아니면 null */
export function nearestSpeed(x: number): 1 | 2 | 5 | null {
  if (typeof x !== 'number' || Number.isNaN(x)) return null;
  const clamped = Math.min(SIM_SPEEDS[SIM_SPEEDS.length - 1]!, Math.max(SIM_SPEEDS[0], x));   // ±무한대도 양 끝 값으로
  let best: 1 | 2 | 5 = SIM_SPEEDS[0];
  for (const s of SIM_SPEEDS) if (Math.abs(s - clamped) < Math.abs(best - clamped)) best = s;
  return best;
}

const defaultSetTimer = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => { clearTimeout(id); };
};

const validDate = (s: string | undefined): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+09:00`));

export class SimulatorSource extends SourceBase implements EventSource {
  readonly kind = 'sim' as const;
  readonly label = '시뮬레이션';
  readonly live = false;
  readonly control: SimControl;

  private readonly engine: SimEngine;
  private readonly library: ScenarioLibrary;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly tickMs: number;
  private readonly resetHandlers = new Set<() => void>();
  private readonly tickListeners = new Set<() => void>();

  private started = false;
  private playing = true;
  private speed: 1 | 2 | 5;
  private lastReal = 0;                 // 앞 tick의 실제 시각(ms)
  private cancelTick: (() => void) | null = null;
  private lastTickNotify = Number.NEGATIVE_INFINITY;
  private tickNotifyPending = false;

  constructor(opts: SimulatorOptions) {
    super();
    this.library = opts.library;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.tickMs = Math.max(1, opts.tickMs ?? 250);
    this.speed = nearestSpeed(opts.speed ?? 1) ?? 1;
    this.engine = new SimEngine({
      index: opts.index,
      library: opts.library,
      seed: opts.seed,
      scenario: opts.scenario ?? 'day',
      startDate: validDate(opts.startDate) ? opts.startDate : kstDateOf(this.now()),
      autoApprove: opts.autoApprove ?? true,
    });
    this.control = this.makeControl();
  }

  /** 시나리오를 읽을 때·돌릴 때 생긴 경고(같은 문구는 한 번만) */
  get warnings(): readonly string[] {
    return [...this.library.warnings, ...this.engine.warnings];
  }

  onReset(handler: () => void): () => void {
    this.resetHandlers.add(handler);
    return () => { this.resetHandlers.delete(handler); };
  }

  /** 재생을 시작한다(상태 live). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.playing = true;
    this.lastReal = this.now();
    this.setStatus('live', '시뮬레이션 재생 중');
    this.scheduleTick();
    this.fireTickListeners();
  }

  stop(): void {
    if (this.cancelTick) {
      this.cancelTick();
      this.cancelTick = null;
    }
    const wasStarted = this.started;
    this.started = false;
    if (wasStarted) {
      this.setStatus('idle', '시뮬레이션 정지');
      this.fireTickListeners();
    }
  }

  /** 사용자가 승인·반려한다(자동 승인이 아님). 대기 중인 승인이 아니면 무시한다. */
  decide(approvalId: string, decision: 'approve' | 'reject'): void {
    const batch: PbEvent[] = this.step();
    batch.push(...this.engine.decide(approvalId, decision, false));
    this.publish(batch);
    this.requestTickNotify();
  }

  /* ───────────── 시계 ───────────── */

  private scheduleTick(): void {
    if (!this.started) return;
    this.cancelTick = this.setTimer(() => {
      this.cancelTick = null;
      this.tick();
    }, this.tickMs);
  }

  /** 지난 tick 이후 실제로 흐른 시간 × 속도만큼 엔진을 앞으로 보내고 나온 이벤트를 돌려준다. 일시정지 중에는 아무 일도 없다. */
  private step(): PbEvent[] {
    const t = this.now();
    const elapsed = t - this.lastReal;
    this.lastReal = t;
    if (!this.started || !this.playing || !(elapsed > 0)) return [];
    return this.engine.advance((Math.min(elapsed, MAX_STEP_REAL_MS) / 1000) * this.speed);
  }

  private publish(batch: PbEvent[]): void {
    if (!batch.length) return;
    this.emitBatch(batch);
    this.republishStatus();             // lastEventTs가 바뀐 상태를 알린다
  }

  private tick(): void {
    if (!this.started) return;
    this.publish(this.step());
    if (this.playing || this.tickNotifyPending) this.requestTickNotify();   // 시계가 흐르는 동안은 tick마다 알린다
    this.scheduleTick();
  }

  /* ───────────── 화면 갱신 알림(초당 최대 4회) ───────────── */

  private fireTickListeners(): void {
    this.lastTickNotify = this.now();
    this.tickNotifyPending = false;
    for (const listener of [...this.tickListeners]) safeCall(listener);
  }

  /** 시계·재생 상태가 바뀌었음을 알린다. 앞 알림과 250ms가 안 지났으면 다음 tick으로 미룬다(tick이 없을 때는 바로). */
  private requestTickNotify(): void {
    if (!this.started || this.now() - this.lastTickNotify >= TICK_NOTIFY_MIN_MS) this.fireTickListeners();
    else this.tickNotifyPending = true;
  }

  /* ───────────── 조작 ───────────── */

  private makeControl(): SimControl {
    return {
      play: () => {
        if (this.playing && this.started) return;
        this.playing = true;
        this.lastReal = this.now();       // 멈춰 있던 시간은 세지 않는다
        if (this.started) this.setStatus('live', '시뮬레이션 재생 중');
        this.requestTickNotify();
      },
      pause: () => {
        if (!this.playing) return;
        this.publish(this.step());        // 멈추기 직전까지는 반영한다
        this.playing = false;
        if (this.started) this.setStatus('paused', '일시정지');
        this.requestTickNotify();
      },
      isPlaying: () => this.started && this.playing,
      setSpeed: (x) => {
        const next = nearestSpeed(x);
        if (next === null || next === this.speed) return;
        this.publish(this.step());        // 바꾸기 전 속도로 지금까지를 반영한다
        this.speed = next;
        this.requestTickNotify();
      },
      getSpeed: () => this.speed,
      listScenarios: (): ScenarioInfo[] => this.library.menu.map((m) => ({ ...m })),
      getScenario: () => this.engine.scenarioId,
      setScenario: (id) => {
        this.engine.reset(id);
        this.lastReal = this.now();
        this.clearLastEvent();            // 새 기록은 처음부터: 옛 시나리오의 마지막 이벤트 시각을 남기지 않는다
        for (const handler of [...this.resetHandlers]) safeCall(handler);
        this.republishStatus();
        this.requestTickNotify();
      },
      setAutoApprove: (on) => {
        if (on === this.engine.getAutoApprove()) return;
        this.publish(this.step());
        this.engine.setAutoApprove(on);
        this.requestTickNotify();
      },
      getAutoApprove: () => this.engine.getAutoApprove(),
      clock: () => this.engine.clock(),
      autoApproveDue: (approvalId) => {
        const remainingTau = this.engine.autoApproveRemainingTau(approvalId);
        if (remainingTau === null) return null;
        let ms = (remainingTau * 1000) / this.speed;
        if (this.started && this.playing) ms -= Math.max(0, this.now() - this.lastReal);   // 지난 tick 이후 흐른 시간
        return Math.max(0, Math.round(ms));
      },
      subscribeTick: (listener) => {
        this.tickListeners.add(listener);
        return () => { this.tickListeners.delete(listener); };
      },
    };
  }
}
