// 소스 공통 바탕(SourceBase·StaticSource·safeCall·timeOfDay) 확인.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PbEvent, SourceKind, SourceStatus } from '../types';
import { SourceBase, StaticSource, safeCall, timeOfDay } from './base';

const ev = (n: number, ts = `2026-10-17T09:00:${String(n).padStart(2, '0')}+09:00`): PbEvent => ({
  v: 1, event_id: `b${n}`, ts, type: 'task_started', staff_id: 'ceo', executor: 'human', task_id: `t${n}`, message: `작업 ${n}`,
});

/** 보호된 메서드를 열어 둔 시험용 소스 */
class Probe extends SourceBase {
  readonly kind: SourceKind = 'file';
  readonly label = '시험';
  readonly live = false;
  start(): void { /* 시험용 */ }
  stop(): void { /* 시험용 */ }
  emit(batch: PbEvent[]): void { this.emitBatch(batch); }
  status(state: SourceStatus['state'], detail: string): void { this.setStatus(state, detail); }
  republish(): void { this.republishStatus(); }
  clear(): void { this.clearLastEvent(); }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('timeOfDay', () => {
  it('HH:MM:SS (두 자리씩)', () => {
    expect(timeOfDay(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
    expect(timeOfDay(new Date(2026, 0, 2, 23, 59, 59))).toBe('23:59:59');
    expect(timeOfDay(new Date(2026, 0, 2, 0, 0, 0))).toBe('00:00:00');
  });
});

describe('safeCall', () => {
  it('정상이면 그대로 부른다', () => {
    const fn = vi.fn();
    safeCall(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('던져도 부른 쪽은 멈추지 않고, 오류는 버리지 않고 다음 microtask에서 다시 던진다', () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (fn: () => void) => { queued.push(fn); });
    const boom = new Error('구독자 오류');
    expect(() => { safeCall(() => { throw boom; }); }).not.toThrow();
    expect(queued).toHaveLength(1);
    expect(() => { queued[0]!(); }).toThrow(boom);
  });
});

describe('SourceBase', () => {
  it('처음 상태는 idle·빈 문구·lastEventTs null이고, getStatus는 사본', () => {
    const p = new Probe();
    expect(p.getStatus()).toEqual({ state: 'idle', detail: '', lastEventTs: null });
    const copy = p.getStatus();
    copy.detail = '바꿔 봄';
    expect(p.getStatus().detail).toBe('');
  });

  it('emitBatch: 구독자 모두에게 같은 batch를 주고, 빈 batch는 내지 않는다', () => {
    const p = new Probe();
    const a: PbEvent[][] = [];
    const b: PbEvent[][] = [];
    p.subscribe((x) => { a.push(x); });
    p.subscribe((x) => { b.push(x); });
    p.emit([]);
    expect(a).toEqual([]);
    const batch = [ev(1), ev(2)];
    p.emit(batch);
    expect(a).toEqual([batch]);
    expect(b).toEqual([batch]);
  });

  it('subscribe의 해지 함수는 그 구독만 푼다', () => {
    const p = new Probe();
    const a: number[] = [];
    const b: number[] = [];
    const offA = p.subscribe((x) => { a.push(x.length); });
    p.subscribe((x) => { b.push(x.length); });
    p.emit([ev(1)]);
    offA();
    offA();
    p.emit([ev(2), ev(3)]);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('lastEventTs는 가장 늦은 ts(뒤섞인 순서·옛 이벤트가 나중에 와도 되돌아가지 않는다)', () => {
    const p = new Probe();
    p.emit([ev(5), ev(2), ev(9), ev(3)]);
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T09:00:09+09:00');
    p.emit([ev(1)]);
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T09:00:09+09:00');
    p.emit([ev(1, '2026-10-17T12:00:00+09:00')]);
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T12:00:00+09:00');
  });

  it('clearLastEvent: 마지막 이벤트 시각을 비우고, 그보다 이른 ts도 다시 받아들인다', () => {
    const p = new Probe();
    p.emit([ev(40)]);
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T09:00:40+09:00');
    p.clear();
    expect(p.getStatus().lastEventTs).toBeNull();
    p.emit([ev(5)]);
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T09:00:05+09:00');
  });

  it('시간대가 다른 ts도 실제 시각으로 비교한다', () => {
    const p = new Probe();
    p.emit([ev(1, '2026-10-17T09:00:00+09:00'), ev(2, '2026-10-17T00:30:00Z')]);   // 둘째가 더 늦다(09:30 KST)
    expect(p.getStatus().lastEventTs).toBe('2026-10-17T00:30:00Z');
  });

  it('setStatus: 구독자에게 사본을 알리고 lastEventTs는 이어서 유지한다', () => {
    const p = new Probe();
    const seen: SourceStatus[] = [];
    p.onStatus((s) => { seen.push(s); });
    p.emit([ev(4)]);
    p.status('live', '읽는 중');
    p.status('error', 'HTTP 500');
    expect(seen.map((s) => [s.state, s.detail, s.lastEventTs])).toEqual([
      ['live', '읽는 중', '2026-10-17T09:00:04+09:00'],
      ['error', 'HTTP 500', '2026-10-17T09:00:04+09:00'],
    ]);
    seen[0]!.detail = '바꿔 봄';
    expect(p.getStatus().detail).toBe('HTTP 500');
  });

  it('republishStatus: 같은 상태를 다시 알린다', () => {
    const p = new Probe();
    const seen: SourceStatus[] = [];
    p.status('live', '재생 중');
    p.onStatus((s) => { seen.push(s); });
    p.emit([ev(7)]);
    p.republish();
    expect(seen).toEqual([{ state: 'live', detail: '재생 중', lastEventTs: '2026-10-17T09:00:07+09:00' }]);
  });

  it('구독자 하나가 던져도 나머지에게는 전달된다', () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (fn: () => void) => { queued.push(fn); });
    const p = new Probe();
    const got: string[] = [];
    p.subscribe(() => { throw new Error('첫 구독자'); });
    p.subscribe((b) => { got.push(`batch:${b.length}`); });
    p.onStatus(() => { throw new Error('상태 구독자'); });
    p.onStatus((s) => { got.push(`status:${s.state}`); });
    p.emit([ev(1)]);
    p.status('live', 'x');
    expect(got).toEqual(['batch:1', 'status:live']);
    expect(queued).toHaveLength(2);                                      // 던진 오류는 둘 다 다시 던지도록 남아 있다
  });
});

describe('StaticSource', () => {
  it('이벤트는 내지 않고 정해 둔 상태 하나만 보여 준다', () => {
    const s = new StaticSource('ws', 'WebSocket', true, { state: 'error', detail: '주소가 없습니다' });
    expect(s).toMatchObject({ kind: 'ws', label: 'WebSocket', live: true });
    expect(s.getStatus().state).toBe('idle');
    const seen: SourceStatus[] = [];
    s.onStatus((x) => { seen.push(x); });
    s.start();
    expect(seen).toEqual([{ state: 'error', detail: '주소가 없습니다', lastEventTs: null }]);
    s.stop();
    expect(s.getStatus()).toEqual({ state: 'error', detail: '주소가 없습니다', lastEventTs: null });
  });
});
