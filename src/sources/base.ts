// 소스 공통 바탕: 구독자 목록·현재 상태·마지막 이벤트 시각을 관리한다. 각 소스는 start/stop과 읽는 방법만 구현한다.
import type { EventSource, PbEvent, SourceKind, SourceStatus } from '../types';

export type BatchHandler = (batch: PbEvent[]) => void;
export type StatusHandler = (status: SourceStatus) => void;

/** 구독자가 던진 오류가 소스의 읽기 순환을 끊지 않게 한다. 오류는 버리지 않고 전역 오류로 다시 올린다. */
export function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    queueMicrotask(() => { throw e; });
  }
}

export function timeOfDay(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export abstract class SourceBase implements EventSource {
  abstract readonly kind: SourceKind;
  abstract readonly label: string;
  abstract readonly live: boolean;
  private readonly batchHandlers = new Set<BatchHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private current: SourceStatus = { state: 'idle', detail: '', lastEventTs: null };
  private lastTsMs = Number.NEGATIVE_INFINITY;

  abstract start(): void;
  abstract stop(): void;

  subscribe(handler: BatchHandler): () => void {
    this.batchHandlers.add(handler);
    return () => { this.batchHandlers.delete(handler); };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => { this.statusHandlers.delete(handler); };
  }

  /** 지금 상태(읽기 전용 사본) */
  getStatus(): SourceStatus {
    return { ...this.current };
  }

  /** 새 이벤트 묶음을 구독자에게 낸다. 빈 묶음은 내지 않는다. lastEventTs는 가장 늦은 ts로 갱신한다. */
  protected emitBatch(batch: PbEvent[]): void {
    if (!batch.length) return;
    for (const e of batch) {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t) && t >= this.lastTsMs) {
        this.lastTsMs = t;
        this.current = { ...this.current, lastEventTs: e.ts };
      }
    }
    for (const handler of [...this.batchHandlers]) safeCall(() => handler(batch));
  }

  /** 상태를 바꾸고 구독자에게 알린다(lastEventTs는 이어서 유지). */
  protected setStatus(state: SourceStatus['state'], detail: string): void {
    this.current = { state, detail, lastEventTs: this.current.lastEventTs };
    const snapshot = { ...this.current };
    for (const handler of [...this.statusHandlers]) safeCall(() => handler(snapshot));
  }

  /** 지금 상태의 detail만 바꾸지 않고 다시 알린다(lastEventTs가 바뀐 뒤 등). */
  protected republishStatus(): void {
    this.setStatus(this.current.state, this.current.detail);
  }

  /** 기록을 처음부터 새로 받기 시작할 때(시나리오 변경): 마지막 이벤트 시각을 비운다. 알림은 부르는 쪽이 한다. */
  protected clearLastEvent(): void {
    this.lastTsMs = Number.NEGATIVE_INFINITY;
    this.current = { ...this.current, lastEventTs: null };
  }
}

/** 이벤트를 내지 않고 상태 하나만 보여 주는 소스(파일 열기 전, 주소 없는 WebSocket 등). */
export class StaticSource extends SourceBase {
  readonly kind: SourceKind;
  readonly label: string;
  readonly live: boolean;
  private readonly initial: { state: SourceStatus['state']; detail: string };

  constructor(kind: SourceKind, label: string, live: boolean, initial: { state: SourceStatus['state']; detail: string }) {
    super();
    this.kind = kind;
    this.label = label;
    this.live = live;
    this.initial = initial;
  }

  start(): void {
    this.setStatus(this.initial.state, this.initial.detail);
  }

  stop(): void {
    // 보여 줄 상태가 하나뿐이라 멈춰도 그대로 둔다
  }
}
