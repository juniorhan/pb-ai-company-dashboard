import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import type { EventSource, EventType, PbEvent, SourceKind, SourceStatus } from '../types';
import { initialState } from './reducer';
import { createDashboardStore } from './store';

const index = indexOrg(parseOrg(bundledOrg));
const WHO = index.org.staff[0]!.id;
const orgMeta = { origin: 'bundled' as const, generatedAt: '2026-10-17T00:00:00.000Z', hash: 'abc' };

class FakeSource implements EventSource {
  readonly kind: SourceKind = 'jsonl';
  readonly label = '가짜 소스';
  readonly live = true;
  readonly batchHandlers = new Set<(b: PbEvent[]) => void>();
  readonly statusHandlers = new Set<(s: SourceStatus) => void>();
  readonly resetHandlers = new Set<() => void>();
  started = 0;
  stopped = 0;
  subscribe(h: (b: PbEvent[]) => void): () => void { this.batchHandlers.add(h); return () => { this.batchHandlers.delete(h); }; }
  onStatus(h: (s: SourceStatus) => void): () => void { this.statusHandlers.add(h); return () => { this.statusHandlers.delete(h); }; }
  onReset(h: () => void): () => void { this.resetHandlers.add(h); return () => { this.resetHandlers.delete(h); }; }
  start(): void { this.started += 1; }
  stop(): void { this.stopped += 1; }
  emit(batch: PbEvent[]): void { for (const h of [...this.batchHandlers]) h(batch); }
  status(s: SourceStatus): void { for (const h of [...this.statusHandlers]) h(s); }
  reset(): void { for (const h of [...this.resetHandlers]) h(); }
}

/** onReset이 없는 소스(실연결) */
class PlainSource extends FakeSource {
  override onReset = undefined as unknown as FakeSource['onReset'];
}

let seq = 0;
const T0 = Date.parse('2026-10-17T06:00:00+09:00');
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
function ev(sec: number, type: EventType = 'task_created', task = `t${++seq}`): PbEvent {
  seq += 1;
  return {
    event_id: `s-${seq}`, ts: iso(sec), type, staff_id: WHO, executor: 'claude', task_id: task, message: `m${seq}`,
    ...(type === 'task_created' ? { payload: { title: task } } : type === 'approval_requested' ? { payload: { approval_id: `${task}:A1`, summary: '' } } : {}),
  };
}

beforeEach(() => { seq = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('getView', () => {
  it('바뀐 것이 없으면 같은 객체(참조 동일)', () => {
    const store = createDashboardStore(index, new FakeSource(), orgMeta);
    const v = store.getView();
    expect(store.getView()).toBe(v);
    vi.advanceTimersByTime(1000);
    expect(store.getView()).toBe(v);
  });

  it('칸: 처음 상태·범위·밀도·눈금·소스·조직', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const v = store.getView();
    expect(JSON.stringify(v.state)).toBe(JSON.stringify(initialState(index)));
    expect(v.cursor).toBe('live');
    expect(v.range).toEqual({ start: null, end: null });
    expect(v.density).toEqual(new Array(60).fill(0));
    expect(v.marks).toEqual([]);
    expect(v.source).toEqual({ kind: 'jsonl', label: '가짜 소스', live: true, status: { state: 'idle', detail: '', lastEventTs: null } });
    expect(v.org).toEqual(orgMeta);
    expect(store.index).toBe(index);
    expect(store.source).toBe(source);
  });

  it('이벤트가 들어오면 새 view, 상태가 최신으로 바뀐다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const v0 = store.getView();
    source.emit([ev(0), ev(10, 'approval_requested', 'x'), ev(20)]);
    const v1 = store.getView();
    expect(v1).not.toBe(v0);
    expect(v1.state.seq).toBe(3);
    expect(v1.range).toEqual({ start: iso(0), end: iso(20) });
    expect(v1.marks).toEqual([{ ts: iso(10), kind: 'approval' }]);
    expect(v1.density.reduce((a, b) => a + b, 0)).toBe(3);
    expect(v0.state.seq).toBe(0);                                      // 이전 view는 그대로
  });

  it('이미 있는 event_id만 오면 view가 바뀌지 않는다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const batch = [ev(0), ev(1)];
    source.emit(batch);
    vi.advanceTimersByTime(100);
    const v = store.getView();
    const listener = vi.fn();
    store.subscribe(listener);
    source.emit(batch);
    vi.advanceTimersByTime(500);
    expect(store.getView()).toBe(v);
    expect(listener).not.toHaveBeenCalled();
  });

  it('소스 상태가 바뀌면 view.source.status가 갱신되고 state는 같은 객체', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    source.emit([ev(0)]);
    const v0 = store.getView();
    const status: SourceStatus = { state: 'live', detail: '마지막 읽기 10:42:13 · 새 1건', lastEventTs: iso(0) };
    source.status(status);
    const v1 = store.getView();
    expect(v1).not.toBe(v0);
    expect(v1.source.status).toEqual(status);
    expect(v1.state).toBe(v0.state);
    expect(v1.range).toEqual(v0.range);
  });

  it('보관 구간보다 이른 이벤트를 건너뛰면 소스 상태 설명에 건수를 덧붙인다(상태는 그대로)', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    source.emit(Array.from({ length: 20001 }, (_, i) => ev(i, 'task_started', 'x')));      // 기본 상한 20000건 → 가장 오래된 1건(0초)을 버린다
    source.status({ state: 'live', detail: '새 기록', lastEventTs: null });
    const v0 = store.getView();
    expect(v0.source.status.detail).toBe('새 기록');
    source.emit([ev(-1, 'task_started', 'x')]);                                              // 버린 구간보다 이르다
    const v1 = store.getView();
    expect(v1).not.toBe(v0);
    expect(v1.state).toBe(v0.state);
    expect(v1.source.status.detail).toBe('새 기록 · 보관 구간보다 이른 이벤트 1건은 반영하지 않음');
  });
});

describe('알림 묶기', () => {
  it('알림은 바로 가지 않고 50ms 안에 몰린 변화는 한 번만 간다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const listener = vi.fn();
    store.subscribe(listener);
    source.emit([ev(0)]);
    source.emit([ev(1)]);
    source.status({ state: 'live', detail: 'x', lastEventTs: null });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getView().state.seq).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('초당 최대 20회: 1초 동안 계속 변해도 알림은 20회를 넘지 않는다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const listener = vi.fn();
    store.subscribe(listener);
    for (let t = 0; t < 1000; t += 5) {
      source.emit([ev(t)]);
      vi.advanceTimersByTime(5);
    }
    expect(listener.mock.calls.length).toBeGreaterThan(0);
    expect(listener.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('구독 해제하면 더 알리지 않는다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    store.subscribe(b);
    offA();
    source.emit([ev(0)]);
    vi.advanceTimersByTime(60);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('requestAnimationFrame이 있으면 그것으로 묶고, 앞 알림 뒤 50ms가 지난 프레임에서 알린다', () => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const runFrame = (): void => { const cb = frames.shift(); cb?.(); };

    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const listener = vi.fn();
    store.subscribe(listener);

    source.emit([ev(0)]);
    source.emit([ev(1)]);
    expect(frames).toHaveLength(1);                                    // 몰린 변화는 프레임 하나
    runFrame();
    expect(listener).toHaveBeenCalledTimes(1);

    nowMs += 16;
    source.emit([ev(2)]);
    runFrame();                                                        // 16ms 뒤 프레임: 아직 이르다 → 다음 프레임으로 미룬다
    expect(listener).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    nowMs += 40;
    runFrame();                                                        // 합쳐서 56ms
    expect(listener).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(0);
    expect(store.getView().state.seq).toBe(3);
    store.dispose();
    vi.restoreAllMocks();
  });
});

describe('setCursor (되감기)', () => {
  function setup() {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    source.emit([ev(0), ev(60), ev(120), ev(180)]);
    vi.advanceTimersByTime(60);
    return { source, store };
  }

  it('그 시점 상태로 고정하고 즉시 알린다. 새 이벤트가 와도 state는 그대로, range·density·marks는 갱신', () => {
    const { source, store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setCursor(iso(90));
    expect(listener).toHaveBeenCalledTimes(1);                         // 묶지 않고 바로
    const pinned = store.getView();
    expect(pinned.cursor).toBe(iso(90));
    expect(pinned.state.seq).toBe(2);                                  // 0초·60초 이벤트까지
    expect(pinned.range).toEqual({ start: iso(0), end: iso(180) });

    source.emit([ev(240, 'approval_requested', 'z'), ev(300)]);
    vi.advanceTimersByTime(60);
    const later = store.getView();
    expect(later).not.toBe(pinned);
    expect(later.cursor).toBe(iso(90));
    expect(later.state).toBe(pinned.state);                            // 같은 객체: 화면이 다시 그려지지 않는다
    expect(later.range.end).toBe(iso(300));
    expect(later.marks).toEqual([{ ts: iso(240), kind: 'approval' }]);
    expect(later.density.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("'live'로 돌아오면 최신 상태", () => {
    const { source, store } = setup();
    store.setCursor(iso(90));
    source.emit([ev(240)]);
    vi.advanceTimersByTime(60);
    store.setCursor('live');
    const v = store.getView();
    expect(v.cursor).toBe('live');
    expect(v.state.seq).toBe(5);
  });

  it('같은 커서·읽을 수 없는 커서는 무시한다', () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setCursor('live');
    store.setCursor('garbage');
    expect(listener).not.toHaveBeenCalled();
    expect(store.getView().cursor).toBe('live');
    store.setCursor(iso(10));
    store.setCursor(iso(10));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('커서가 마지막 이벤트보다 뒤면 최신 상태를 따라간다', () => {
    const { source, store } = setup();
    store.setCursor(iso(1000));
    expect(store.getView().state.seq).toBe(4);
    source.emit([ev(500)]);
    vi.advanceTimersByTime(60);
    expect(store.getView().state.seq).toBe(5);
  });

  it('커서 이전 시각의 늦은 이벤트가 들어오면 그 시점 상태가 다시 계산된다', () => {
    const { source, store } = setup();
    store.setCursor(iso(90));
    const before = store.getView().state;
    source.emit([ev(30, 'task_created', 'late')]);
    vi.advanceTimersByTime(60);
    const after = store.getView().state;
    expect(after).not.toBe(before);
    expect(after.seq).toBe(3);
    expect(after.tasks.late).toBeDefined();
  });
});

describe('소스 연결', () => {
  it('onReset이면 로그를 비우고 커서를 live로', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    source.emit([ev(0), ev(60)]);
    vi.advanceTimersByTime(60);
    store.setCursor(iso(30));
    const listener = vi.fn();
    store.subscribe(listener);
    source.reset();
    vi.advanceTimersByTime(60);
    expect(listener).toHaveBeenCalledTimes(1);
    const v = store.getView();
    expect(v.cursor).toBe('live');
    expect(v.range).toEqual({ start: null, end: null });
    expect(v.marks).toEqual([]);
    expect(JSON.stringify(v.state)).toBe(JSON.stringify(initialState(index)));
    source.emit([ev(0), ev(60)]);                                      // 같은 시각의 새 이벤트(시나리오 다시 시작)도 받는다
    vi.advanceTimersByTime(60);
    expect(store.getView().state.seq).toBe(2);
  });

  it('onReset이 없는 소스도 쓸 수 있다', () => {
    const source = new PlainSource();
    const store = createDashboardStore(index, source, orgMeta);
    source.emit([ev(0)]);
    vi.advanceTimersByTime(60);
    expect(store.getView().state.seq).toBe(1);
    expect(source.resetHandlers.size).toBe(0);
  });

  it('store는 source.start()를 부르지 않는다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    store.setCursor(iso(5));
    store.dispose();
    expect(source.started).toBe(0);
  });

  it('dispose: 구독을 풀고 source.stop()을 부르며, 그 뒤 이벤트·알림은 없다', () => {
    const source = new FakeSource();
    const store = createDashboardStore(index, source, orgMeta);
    const listener = vi.fn();
    store.subscribe(listener);
    source.emit([ev(0)]);                                              // 알림 예약
    store.dispose();
    expect(source.stopped).toBe(1);
    expect(source.batchHandlers.size).toBe(0);
    expect(source.statusHandlers.size).toBe(0);
    expect(source.resetHandlers.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(listener).not.toHaveBeenCalled();                           // 예약된 알림도 취소
    source.emit([ev(10)]);
    vi.advanceTimersByTime(500);
    expect(listener).not.toHaveBeenCalled();
    store.setCursor(iso(5));
    expect(listener).not.toHaveBeenCalled();
    store.dispose();
    expect(source.stopped).toBe(1);                                    // 두 번째 dispose는 아무 일도 없다
  });
});
