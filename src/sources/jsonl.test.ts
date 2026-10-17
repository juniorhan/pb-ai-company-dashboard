// JsonlPollingSource: 가짜 fetch와 가짜 타이머로 새 줄만 반영·중복 무시·잘못된 줄·재시도 간격·교체·쓰는 중인 줄을 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventSource, PbEvent, SourceStatus } from '../types';
import { JsonlPollingSource } from './jsonl';
import type { FetchLike } from './jsonl';

/** 유효한 이벤트 1건(JSON 객체). n이 같으면 event_id가 같다. */
function ev(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const sec = String(n % 60).padStart(2, '0');
  return {
    v: 1, event_id: `e${n}`, ts: `2026-10-17T09:00:${sec}+09:00`, type: 'task_started',
    staff_id: 'ceo', executor: 'human', task_id: `t${n}`, message: `작업 ${n}`, ...over,
  };
}
const line = (n: number, over: Record<string, unknown> = {}): string => JSON.stringify(ev(n, over));
const lines = (...ns: number[]): string => ns.map((n) => `${line(n)}\n`).join('');

function fakeServer() {
  const s = {
    body: '', status: 200, failWith: null as unknown, calls: 0,
    urls: [] as string[], inits: [] as ({ cache?: RequestCache; signal?: AbortSignal } | undefined)[],
    hang: false,
  };
  const fetchImpl: FetchLike = (url, init) => {
    s.calls += 1;
    s.urls.push(url);
    s.inits.push(init);
    if (s.hang) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      });
    }
    if (s.failWith !== null) return Promise.reject(s.failWith);
    return Promise.resolve({ ok: s.status >= 200 && s.status < 300, status: s.status, text: () => Promise.resolve(s.body) });
  };
  return { s, fetchImpl };
}

function setup(over: { intervalMs?: number; requestTimeoutMs?: number } = {}) {
  const server = fakeServer();
  const source = new JsonlPollingSource({ url: '/x/events.jsonl', fetchImpl: server.fetchImpl, ...over });
  const events: PbEvent[] = [];
  const batches: PbEvent[][] = [];
  const statuses: SourceStatus[] = [];
  source.subscribe((b) => { batches.push(b); events.push(...b); });
  source.onStatus((st) => { statuses.push(st); });
  /** 가짜 시간을 ms만큼 보내고 그 사이 끝난 비동기 일도 마무리한다 */
  const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
  return { ...server, source, events, batches, statuses, advance };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 17, 10, 42, 13)); });
afterEach(() => { vi.useRealTimers(); });

describe('JsonlPollingSource 읽기', () => {
  it('종류·이름·읽기 전용(control·decide 없음)', () => {
    const { source } = setup();
    expect(source).toMatchObject({ kind: 'jsonl', live: true, label: '실시간 기록' });
    expect((source as EventSource).control).toBeUndefined();
    expect((source as unknown as { decide?: unknown }).decide).toBeUndefined();
    expect(new JsonlPollingSource({ url: 'u', label: '내 기록' }).label).toBe('내 기록');
  });

  it('start: 연결 중 → 읽은 뒤 live, 상태 문구는 `마지막 읽기 HH:MM:SS · 새 n건`, 요청은 no-store', async () => {
    const t = setup();
    t.s.body = lines(1, 2, 3);
    t.source.start();
    expect(t.statuses.map((x) => x.state)).toEqual(['connecting']);
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(t.batches).toHaveLength(1);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'live', detail: '마지막 읽기 10:42:13 · 새 3건', lastEventTs: '2026-10-17T09:00:03+09:00' });
    expect(t.s.urls).toEqual(['/x/events.jsonl']);
    expect(t.s.inits[0]!.cache).toBe('no-store');
    expect(t.s.inits[0]!.signal).toBeInstanceOf(AbortSignal);
    t.source.stop();
  });

  it('start를 두 번 불러도 읽기 순환은 하나', async () => {
    const t = setup();
    t.s.body = lines(1);
    t.source.start();
    t.source.start();
    await t.advance(0);
    expect(t.s.calls).toBe(1);
    await t.advance(5000);
    expect(t.s.calls).toBe(2);
    t.source.stop();
  });

  it('기본 간격 5초, 옵션으로 바꾸면 그 간격(최소 100ms)', async () => {
    const a = setup();
    a.source.start();
    await a.advance(4999);
    expect(a.s.calls).toBe(1);
    await a.advance(1);
    expect(a.s.calls).toBe(2);
    a.source.stop();

    const b = setup({ intervalMs: 1000 });
    b.source.start();
    await b.advance(3000);
    expect(b.s.calls).toBe(4);
    b.source.stop();

    const c = setup({ intervalMs: 1 });
    c.source.start();
    await c.advance(1000);
    expect(c.s.calls).toBe(11);                                          // 100ms 간격 + 처음 1번
    c.source.stop();
  });

  it('새 줄만 반영하고 이미 본 event_id는 무시한다', async () => {
    const t = setup();
    t.s.body = lines(1, 2);
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);

    t.s.body += lines(3);
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(t.batches.map((b) => b.length)).toEqual([2, 1]);
    expect(t.statuses.at(-1)!.detail).toContain('새 1건');

    // 같은 id를 다시 붙여도, 새 줄 사이에 끼어 있어도 한 번만
    t.s.body += lines(3, 4, 2, 5);
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);

    // 바뀐 게 없으면 batch 없이 상태만
    const n = t.batches.length;
    await t.advance(5000);
    expect(t.batches.length).toBe(n);
    expect(t.statuses.at(-1)!.detail).toContain('새 0건');
    t.source.stop();
  });

  it('늘어난 뒷부분만 해석한다(앞부분을 다시 해석하지 않는다)', async () => {
    const t = setup();
    const first = lines(1, 2);
    t.s.body = first;
    t.source.start();
    await t.advance(0);
    // 앞부분에 잘못된 줄이 있었다면 뒷부분만 읽을 때 다시 세지 않는다
    t.s.body = `${first}garbage\n${line(3)}\n`;
    await t.advance(5000);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:18 · 새 1건 · 잘못된 줄 1');
    t.s.body += lines(4);
    await t.advance(5000);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:23 · 새 1건 · 잘못된 줄 1');
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    t.source.stop();
  });

  it('잘못된 줄은 세어서 상태에 보여 주고 나머지는 받는다', async () => {
    const t = setup();
    t.s.body = `${line(1)}\n이건 JSON이 아님\n${line(2, { executor: '아무개' })}\n${line(3)}\n{"v":1}\n`;
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e3']);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:13 · 새 2건 · 잘못된 줄 3');
    t.source.stop();
  });

  it('쓰는 중인 마지막 줄(개행 전)은 완성될 때까지 기다린다', async () => {
    const t = setup();
    const full = line(2);
    t.s.body = `${lines(1)}${full.slice(0, 30)}`;
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1']);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:13 · 새 1건');   // 미완성 줄은 잘못된 줄로 세지 않는다

    t.s.body = `${lines(1)}${full.slice(0, 80)}`;
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1']);

    t.s.body = `${lines(1)}${full}\n`;
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    expect(t.statuses.at(-1)!.detail).not.toContain('잘못된');
    t.source.stop();
  });

  it('개행 없이 끝났어도 온전한 이벤트면 바로 받고, 개행이 붙어도 다시 받지 않는다', async () => {
    const t = setup();
    t.s.body = `${lines(1)}${line(2)}`;
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    t.s.body += '\n';
    await t.advance(5000);
    t.s.body += lines(3);
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
    t.source.stop();
  });

  it('JSON 배열 본문도 읽고, 읽을 때마다 전체를 해석하되 새 id만 낸다', async () => {
    const t = setup();
    t.s.body = JSON.stringify([ev(1), ev(2)]);
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    t.s.body = JSON.stringify([ev(1), ev(2), ev(3), { v: 1, nope: true }]);
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:18 · 새 1건 · 잘못된 줄 1');
    t.source.stop();
  });

  it('파일이 짧아지거나 앞부분이 바뀌면(교체) 전체를 다시 읽되 본 id는 계속 버린다', async () => {
    const t = setup();
    t.s.body = lines(1, 2, 3);
    t.source.start();
    await t.advance(0);
    expect(t.events).toHaveLength(3);

    t.s.body = lines(2, 3, 4);                                           // 첫 줄이 사라지고 새 줄이 붙음(앞부분이 다르다)
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4']);

    t.s.body = lines(4);                                                 // 훨씬 짧아짐
    await t.advance(5000);
    expect(t.events).toHaveLength(4);
    expect(t.statuses.at(-1)!.detail).toContain('새 0건');

    t.s.body = lines(4, 9);                                              // 짧아진 파일이 다시 자람
    await t.advance(5000);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e9']);

    t.s.body = '';                                                       // 비운 파일
    await t.advance(5000);
    expect(t.events).toHaveLength(5);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'live' });
    t.source.stop();
  });

  it('교체하면 잘못된 줄 수도 새 파일 기준으로 다시 센다', async () => {
    const t = setup();
    t.s.body = `${['x', 'y'].join('\n')}\n${lines(1)}`;
    t.source.start();
    await t.advance(0);
    expect(t.statuses.at(-1)!.detail).toContain('잘못된 줄 2');
    t.s.body = lines(5);
    await t.advance(5000);
    expect(t.statuses.at(-1)!.detail).toBe('마지막 읽기 10:42:18 · 새 1건');
    t.source.stop();
  });

  it('BOM이 붙은 파일도 읽는다', async () => {
    const t = setup();
    t.s.body = `﻿${lines(1, 2)}`;
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    t.source.stop();
  });

  it('CRLF 개행도 읽는다', async () => {
    const t = setup();
    t.s.body = `${line(1)}\r\n${line(2)}\r\n`;
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
    t.source.stop();
  });

  it('lastEventTs는 가장 늦은 ts(순서가 뒤섞여도)', async () => {
    const t = setup();
    t.s.body = `${line(30)}\n${line(10)}\n${line(20)}\n`;
    t.source.start();
    await t.advance(0);
    expect(t.source.getStatus().lastEventTs).toBe('2026-10-17T09:00:30+09:00');
    t.source.stop();
  });
});

describe('JsonlPollingSource 실패와 재시도', () => {
  it('HTTP 오류: 상태 error, detail은 `HTTP 404`', async () => {
    const t = setup();
    t.s.status = 404;
    t.source.start();
    await t.advance(0);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', detail: 'HTTP 404' });
    expect(t.events).toEqual([]);
    t.source.stop();
  });

  it('연결 실패: 상태 error, detail은 `읽기 실패: 사유`', async () => {
    const t = setup();
    t.s.failWith = new TypeError('Failed to fetch');
    t.source.start();
    await t.advance(0);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', detail: '읽기 실패: Failed to fetch' });
    t.s.failWith = '문자열 오류';
    await t.advance(5000);
    expect(t.statuses.at(-1)!.detail).toBe('읽기 실패: 문자열 오류');
    t.source.stop();
  });

  it('재시도 간격은 5 → 10 → 30초(최대 30초), 성공하면 원래 간격으로 돌아오고 실패 횟수도 처음부터', async () => {
    const t = setup();
    t.s.failWith = new Error('boom');
    t.source.start();
    await t.advance(0);
    expect(t.s.calls).toBe(1);

    await t.advance(4999);
    expect(t.s.calls).toBe(1);
    await t.advance(1);                                                  // +5초
    expect(t.s.calls).toBe(2);
    await t.advance(9999);
    expect(t.s.calls).toBe(2);
    await t.advance(1);                                                  // +10초
    expect(t.s.calls).toBe(3);
    await t.advance(29_999);
    expect(t.s.calls).toBe(3);
    await t.advance(1);                                                  // +30초
    expect(t.s.calls).toBe(4);
    await t.advance(30_000);                                             // 그 뒤로도 30초
    expect(t.s.calls).toBe(5);
    await t.advance(30_000);
    expect(t.s.calls).toBe(6);

    // 복구: 새 이벤트를 받고 원래 간격(5초)으로
    t.s.failWith = null;
    t.s.body = lines(1);
    await t.advance(30_000);
    expect(t.s.calls).toBe(7);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'live' });
    expect(t.events.map((e) => e.event_id)).toEqual(['e1']);
    await t.advance(4999);
    expect(t.s.calls).toBe(7);
    await t.advance(1);
    expect(t.s.calls).toBe(8);

    // 다시 실패하면 5초부터
    t.s.failWith = new Error('again');
    await t.advance(5000);
    expect(t.s.calls).toBe(9);
    await t.advance(4999);
    expect(t.s.calls).toBe(9);
    await t.advance(1);
    expect(t.s.calls).toBe(10);
    t.source.stop();
  });

  it('실패해도 앞서 받은 이벤트는 그대로고 lastEventTs도 유지된다', async () => {
    const t = setup();
    t.s.body = lines(1, 2);
    t.source.start();
    await t.advance(0);
    t.s.status = 500;
    await t.advance(5000);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', detail: 'HTTP 500', lastEventTs: '2026-10-17T09:00:02+09:00' });
    t.s.status = 200;
    await t.advance(5000);
    expect(t.events).toHaveLength(2);                                    // 같은 본문이라 다시 나오지 않는다
    expect(t.statuses.at(-1)).toMatchObject({ state: 'live' });
    t.source.stop();
  });

  it('응답이 안 오면 시간 초과로 실패 처리하고 다시 시도한다', async () => {
    const t = setup({ requestTimeoutMs: 2000 });
    t.s.hang = true;
    t.source.start();
    await t.advance(1999);
    expect(t.statuses.at(-1)!.state).toBe('connecting');
    await t.advance(1);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', detail: '응답 시간 초과(2초)' });
    expect(t.s.inits[0]!.signal!.aborted).toBe(true);
    t.s.hang = false;
    t.s.body = lines(1);
    await t.advance(5000);
    expect(t.s.calls).toBe(2);
    expect(t.events).toHaveLength(1);
    t.source.stop();
  });
});

describe('JsonlPollingSource 멈춤과 구독', () => {
  it('stop: 상태 idle, 타이머와 진행 중 요청을 정리하고, 늦게 도착한 응답은 버린다', async () => {
    const t = setup();
    t.s.body = lines(1);
    t.source.start();
    await t.advance(0);
    t.source.stop();
    expect(t.statuses.at(-1)).toMatchObject({ state: 'idle', detail: '읽기 중지' });
    expect(vi.getTimerCount()).toBe(0);
    await t.advance(60_000);
    expect(t.s.calls).toBe(1);

    // 요청이 진행 중일 때 멈추면 그 응답은 버린다
    const hangs = setup();
    hangs.s.hang = true;
    hangs.source.start();
    await hangs.advance(10);
    const signal = hangs.s.inits[0]!.signal!;
    hangs.source.stop();
    expect(signal.aborted).toBe(true);
    await hangs.advance(60_000);
    expect(hangs.s.calls).toBe(1);
    expect(hangs.events).toEqual([]);
    expect(hangs.statuses.at(-1)!.state).toBe('idle');
  });

  it('시작한 적 없으면 stop은 상태를 바꾸지 않는다', () => {
    const t = setup();
    t.source.stop();
    expect(t.statuses).toEqual([]);
  });

  it('stop 뒤 다시 start하면 이어서 읽되 이미 본 id는 다시 내지 않는다', async () => {
    const t = setup();
    t.s.body = lines(1, 2);
    t.source.start();
    await t.advance(0);
    t.source.stop();
    t.s.body = lines(1, 2, 3);
    t.source.start();
    await t.advance(0);
    expect(t.events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'live' });
    t.source.stop();
  });

  it('구독 해지: 해지한 쪽에는 더 알리지 않는다', async () => {
    const t = setup();
    const extra: PbEvent[][] = [];
    const off = t.source.subscribe((b) => { extra.push(b); });
    t.s.body = lines(1);
    t.source.start();
    await t.advance(0);
    off();
    t.s.body += lines(2);
    await t.advance(5000);
    expect(extra).toHaveLength(1);
    expect(t.batches).toHaveLength(2);
    t.source.stop();
  });

  it('getStatus는 사본이다', async () => {
    const t = setup();
    t.source.start();
    await t.advance(0);
    const status = t.source.getStatus();
    status.detail = '바꿔 봄';
    expect(t.source.getStatus().detail).not.toBe('바꿔 봄');
    t.source.stop();
  });
});
