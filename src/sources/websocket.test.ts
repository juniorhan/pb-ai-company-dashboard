// WebSocketSource: 가짜 생성자로 연결·메시지·끊김과 재연결·정지를 확인한다. (실제 서버로는 확인하지 않았다 — 파일 머리 주석의 '미검증')
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventSource, PbEvent, SourceStatus } from '../types';
import { WebSocketSource } from './websocket';
import type { WebSocketLike } from './websocket';

const ev = (n: number): Record<string, unknown> => ({
  v: 1, event_id: `w${n}`, ts: `2026-10-17T09:00:${String(n).padStart(2, '0')}+09:00`, type: 'task_started',
  staff_id: 'ceo', executor: 'human', task_id: `t${n}`, message: `작업 ${n}`,
});

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  static throwOnCreate: Error | null = null;
  onopen: ((ev: never) => void) | null = null;
  onmessage: ((ev: never) => void) | null = null;
  onerror: ((ev: never) => void) | null = null;
  onclose: ((ev: never) => void) | null = null;
  closed = 0;
  constructor(readonly url: string) {
    if (FakeSocket.throwOnCreate) throw FakeSocket.throwOnCreate;
    FakeSocket.instances.push(this);
  }
  close(): void { this.closed += 1; }
  // 서버 쪽에서 일어나는 일을 흉내 낸다
  open(): void { (this.onopen as ((e: object) => void) | null)?.({}); }
  message(data: unknown): void { (this.onmessage as ((e: { data: unknown }) => void) | null)?.({ data }); }
  error(): void { (this.onerror as ((e: object) => void) | null)?.({}); }
  drop(): void { (this.onclose as ((e: object) => void) | null)?.({}); }
}

function setup(url = 'wss://example.test/events', reconnectMs?: number) {
  const source = new WebSocketSource({ url, WebSocketImpl: FakeSocket, ...(reconnectMs === undefined ? {} : { reconnectMs }) });
  const events: PbEvent[] = [];
  const batches: PbEvent[][] = [];
  const statuses: SourceStatus[] = [];
  source.subscribe((b) => { batches.push(b); events.push(...b); });
  source.onStatus((s) => { statuses.push(s); });
  return { source, events, batches, statuses, last: (): SourceStatus => statuses.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.throwOnCreate = null;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WebSocketSource', () => {
  it('종류·이름·읽기 전용(control·decide 없음)', () => {
    const { source } = setup();
    expect(source).toMatchObject({ kind: 'ws', live: true, label: 'WebSocket' });
    expect((source as EventSource).control).toBeUndefined();
    expect(new WebSocketSource({ url: 'ws://a', label: '내 서버' }).label).toBe('내 서버');
  });

  it('start: 연결 중 → 열리면 live `연결됨 · 받은 0건`', () => {
    const t = setup();
    t.source.start();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toBe('wss://example.test/events');
    expect(t.last()).toMatchObject({ state: 'connecting', detail: '연결하는 중' });
    FakeSocket.instances[0]!.open();
    expect(t.last()).toMatchObject({ state: 'live', detail: '연결됨 · 받은 0건' });
    t.source.stop();
  });

  it('start를 두 번 불러도 소켓은 하나', () => {
    const t = setup();
    t.source.start();
    t.source.start();
    expect(FakeSocket.instances).toHaveLength(1);
    t.source.stop();
  });

  it('메시지 1개 = 이벤트 1건 또는 배열. batch로 내고 받은 수를 상태에 보여 준다', () => {
    const t = setup();
    t.source.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.message(JSON.stringify(ev(1)));
    s.message(JSON.stringify([ev(2), ev(3)]));
    expect(t.batches.map((b) => b.map((e) => e.event_id))).toEqual([['w1'], ['w2', 'w3']]);
    expect(t.last()).toMatchObject({ state: 'live', detail: '연결됨 · 받은 3건', lastEventTs: '2026-10-17T09:00:03+09:00' });
    t.source.stop();
  });

  it('잘못된 메시지는 세어서 보여 주고 나머지는 받는다', () => {
    const t = setup();
    t.source.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.message('JSON 아님');
    s.message(JSON.stringify({ v: 1 }));
    s.message(JSON.stringify([ev(1), { nope: 1 }, 7]));
    s.message(new ArrayBuffer(4));                                       // 글자가 아닌 메시지
    s.message(JSON.stringify([]));
    expect(t.events.map((e) => e.event_id)).toEqual(['w1']);
    expect(t.last().detail).toBe('연결됨 · 받은 1건 · 잘못된 메시지 5');
    t.source.stop();
  });

  it('오류: 상태 error와 재연결 안내, 5초 뒤 새 소켓으로 다시 연결하고 받은 수는 이어진다', () => {
    const t = setup();
    t.source.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.message(JSON.stringify(ev(1)));
    first.error();
    expect(t.last()).toMatchObject({ state: 'error', detail: '연결 오류 — 5초 뒤 다시 연결합니다' });
    expect(first.closed).toBe(1);
    vi.advanceTimersByTime(4999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(t.last()).toMatchObject({ state: 'connecting', detail: '다시 연결하는 중' });
    const second = FakeSocket.instances[1]!;
    second.open();
    second.message(JSON.stringify(ev(2)));
    expect(t.last().detail).toBe('연결됨 · 받은 2건');
    expect(t.events.map((e) => e.event_id)).toEqual(['w1', 'w2']);
    t.source.stop();
  });

  it('끊김(close)도 같다. 오류와 끊김이 연달아 와도 재연결은 한 번만', () => {
    const t = setup();
    t.source.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.drop();
    expect(t.last()).toMatchObject({ state: 'error', detail: '연결이 끊겼습니다 — 5초 뒤 다시 연결합니다' });
    first.error();                                                       // 이미 떼어낸 소켓의 늦은 이벤트는 무시
    first.drop();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    t.source.stop();
  });

  it('브라우저처럼 error 뒤에 close가 이어서 와도 재연결은 한 번만', () => {
    const t = setup();
    t.source.start();
    const first = FakeSocket.instances[0]!;
    first.error();
    first.drop();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    t.source.stop();
  });

  it('재연결 간격을 옵션으로 바꿀 수 있다', () => {
    const t = setup('ws://localhost:9000', 1000);
    t.source.start();
    FakeSocket.instances[0]!.error();
    expect(t.last().detail).toBe('연결 오류 — 1초 뒤 다시 연결합니다');
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    t.source.stop();
  });

  it('소켓을 만들다 던지면 오류로 보여 주고 다시 시도한다', () => {
    const t = setup();
    FakeSocket.throwOnCreate = new SyntaxError('주소가 이상합니다');
    t.source.start();
    expect(t.last()).toMatchObject({ state: 'error', detail: '연결하지 못했습니다: 주소가 이상합니다 — 5초 뒤 다시 연결합니다' });
    FakeSocket.throwOnCreate = null;
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.open();
    expect(t.last().state).toBe('live');
    t.source.stop();
  });

  it('stop: 소켓을 닫고 재연결 타이머를 풀며 상태 idle. 이미 떼어낸 소켓의 메시지는 무시한다', () => {
    const t = setup();
    t.source.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    t.source.stop();
    expect(s.closed).toBe(1);
    expect(t.last()).toMatchObject({ state: 'idle', detail: '연결 중지' });
    s.message(JSON.stringify(ev(1)));
    expect(t.events).toEqual([]);

    // 재연결을 기다리는 중에 멈춰도 다시 연결하지 않는다
    const u = setup();
    u.source.start();
    FakeSocket.instances[1]!.error();
    expect(vi.getTimerCount()).toBe(1);
    u.source.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('시작한 적 없으면 stop은 상태를 바꾸지 않는다. stop 뒤 start로 다시 연결할 수 있다', () => {
    const t = setup();
    t.source.stop();
    expect(t.statuses).toEqual([]);
    t.source.start();
    t.source.stop();
    t.source.start();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(t.last()).toMatchObject({ state: 'connecting' });
    t.source.stop();
  });

  it('ws:// 또는 wss:// 가 아닌 주소는 연결하지 않고 오류로 보여 준다', () => {
    for (const bad of ['https://example.test/x', 'example.test', '', 'javascript:alert(1)', 'file:///x']) {
      const t = setup(bad);
      t.source.start();
      expect(FakeSocket.instances).toHaveLength(0);
      expect(t.last()).toMatchObject({ state: 'error', detail: '주소는 ws:// 또는 wss:// 로 시작해야 합니다' });
    }
    const ok = setup('WS://localhost:1');
    ok.source.start();
    expect(FakeSocket.instances).toHaveLength(1);
    ok.source.stop();
  });

  it('WebSocket을 쓸 수 없는 환경이면 오류로 보여 준다', () => {
    vi.stubGlobal('WebSocket', undefined);
    const source = new WebSocketSource({ url: 'wss://example.test/x' });
    const statuses: SourceStatus[] = [];
    source.onStatus((s) => { statuses.push(s); });
    source.start();
    expect(statuses.at(-1)).toMatchObject({ state: 'error', detail: '이 환경에서는 WebSocket을 쓸 수 없습니다' });
  });

  it('주입한 생성자가 없으면 전역 WebSocket을 쓴다', () => {
    const made: string[] = [];
    class Global extends FakeSocket {
      constructor(url: string) { super(url); made.push(url); }
    }
    vi.stubGlobal('WebSocket', Global);
    const source = new WebSocketSource({ url: 'ws://localhost:5' });
    source.start();
    expect(made).toEqual(['ws://localhost:5']);
    source.stop();
  });
});
