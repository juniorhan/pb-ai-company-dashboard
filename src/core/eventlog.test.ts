import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { SimEngine } from '../sim/engine';
import { loadScenarioLibrary } from '../sim/load';
import { createRng } from '../sim/rng';
import type { Rng } from '../sim/rng';
import type { DashboardState, EventType, PbEvent } from '../types';
import { EventLog } from './eventlog';
import { applyInPlace, cloneShell, initialState } from './reducer';

const index = indexOrg(parseOrg(bundledOrg));
const library = loadScenarioLibrary();

/** 시뮬레이터로 만든 현실적인 이벤트 열(같은 초에 여러 건이 있어 같은 ts 순서 규칙도 시험된다) */
function simEvents(seed: number, scenario: string, tau: number): PbEvent[] {
  const engine = new SimEngine({ index, library, seed, scenario, startDate: '2026-10-17', autoApprove: true });
  const out: PbEvent[] = [];
  for (let t = 0; t < tau; t += 2) out.push(...engine.advance(2));
  return out;
}

const time = (e: PbEvent): number => Date.parse(e.ts);

/** 받은 순서에서 event_id 중복을 버리고(처음 것을 남김) ts로 안정 정렬한 열 */
function expectedOrder(received: PbEvent[]): PbEvent[] {
  const seen = new Set<string>();
  const unique = received.filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
  return unique.map((e, i) => ({ e, i })).sort((a, b) => time(a.e) - time(b.e) || a.i - b.i).map((x) => x.e);
}

/** 정렬한 열을 한 번에 reduce한 결과(EventLog와 같은 제자리 적용을 쓰되, 스냅숏·정렬 없이) */
function reference(events: PbEvent[]): DashboardState {
  const state = cloneShell(initialState(index));
  for (const e of events) applyInPlace(state, e, index);
  return state;
}
const json = (s: DashboardState): string => JSON.stringify(s);

function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function chunks<T>(items: T[], rng: Rng, max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length;) {
    const size = rng.int(1, max);
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

const stream = simEvents(11, 'day', 2500);

describe('시험 입력', () => {
  it('충분히 현실적이다(수백 건, 같은 ts가 여럿, 승인 요청 포함)', () => {
    expect(stream.length).toBeGreaterThan(200);
    const ts = stream.map((e) => e.ts);
    expect(new Set(ts).size).toBeLessThan(ts.length);
    expect(stream.some((e) => e.type === 'approval_requested')).toBe(true);
  });
});

describe('정렬·중복 제거', () => {
  it('순서대로 한 번에 넣으면 reduce 결과와 같다', () => {
    const log = new EventLog(index);
    expect(log.add(stream)).toEqual({ added: stream.length, duplicates: 0 });
    expect(json(log.latest())).toBe(json(reference(stream)));
    expect(log.size).toBe(stream.length);
  });

  it.each([1, 7, 100, 100000])('섞고 중복을 넣고 여러 묶음으로 나눠 넣어도 정렬 후 한 번에 reduce한 결과와 같다 (snapshotEvery=%i)', (snapshotEvery) => {
    const rng = createRng(snapshotEvery + 5);
    const shuffled = shuffle(stream, rng);
    const dupes = Array.from({ length: 120 }, () => rng.pick(stream)!);
    const received = shuffle([...shuffled, ...dupes], rng);
    const log = new EventLog(index, { snapshotEvery });
    let added = 0;
    let duplicates = 0;
    for (const part of chunks(received, rng, 90)) {
      const r = log.add(part);
      added += r.added;
      duplicates += r.duplicates;
    }
    expect(added).toBe(stream.length);
    expect(duplicates).toBe(received.length - stream.length);
    expect(log.size).toBe(stream.length);
    expect(json(log.latest())).toBe(json(reference(expectedOrder(received))));
    expect(log.events().map((e) => e.event_id)).toEqual(expectedOrder(received).map((e) => e.event_id));
  });

  it('같은 ts는 받은 순서를 지킨다(나중 묶음의 같은 ts는 뒤)', () => {
    const mk = (id: string, sec: number): PbEvent => ({
      event_id: id, ts: `2026-10-17T06:00:${String(sec).padStart(2, '0')}+09:00`, type: 'task_created', staff_id: index.org.staff[0]!.id, executor: 'claude',
      task_id: id, message: id, payload: { title: id },
    });
    const log = new EventLog(index);
    log.add([mk('b', 5), mk('a', 5), mk('c', 9)]);
    log.add([mk('z', 5), mk('y', 1), mk('x', 9)]);
    expect(log.events().map((e) => e.event_id)).toEqual(['y', 'b', 'a', 'z', 'c', 'x']);
  });

  it('이미 있는 event_id는 버린다', () => {
    const log = new EventLog(index);
    log.add(stream);
    const before = log.latest();
    const again = log.add(stream.slice(0, 50));
    expect(again).toEqual({ added: 0, duplicates: 50 });
    expect(log.latest()).toBe(before);                                  // 바뀐 게 없으면 같은 객체
    const events = log.events();
    log.add([]);
    expect(log.events()).toBe(events);
  });

  it('latest()는 이벤트가 들어올 때까지 같은 객체이고, 들어오면 새 객체다', () => {
    const log = new EventLog(index);
    log.add(stream.slice(0, 20));
    const a = log.latest();
    expect(log.latest()).toBe(a);
    log.add(stream.slice(20, 25));
    const b = log.latest();
    expect(b).not.toBe(a);
    expect(a.seq).toBe(20);                                             // 이미 낸 상태는 바뀌지 않는다
    expect(b.seq).toBe(25);
  });

  it('읽을 수 없는 ts의 이벤트도 오류 없이 끝에 붙는다', () => {
    const log = new EventLog(index);
    log.add(stream.slice(0, 5));
    const odd: PbEvent = { ...stream[5]!, event_id: 'odd-1', ts: 'not a time' };
    expect(log.add([odd]).added).toBe(1);
    expect(log.size).toBe(6);
    expect(log.events().at(-1)!.event_id).toBe('odd-1');
  });
});

describe('stateAt (되감기)', () => {
  const sorted = expectedOrder(stream);
  const log = new EventLog(index, { snapshotEvery: 13 });
  log.add(shuffle(stream, createRng(3)));

  const prefix = (ts: string): PbEvent[] => sorted.filter((e) => time(e) <= Date.parse(ts));

  it('ts 이하 마지막 이벤트까지만 reduce한 결과와 같다', () => {
    const probes = [
      sorted[0]!.ts, sorted[1]!.ts, sorted[37]!.ts, sorted[100]!.ts, sorted[Math.floor(sorted.length / 2)]!.ts,
      sorted.at(-2)!.ts, sorted.at(-1)!.ts,
    ];
    for (let i = 0; i < 40; i += 1) probes.push(new Date(time(sorted[0]!) + (i * (time(sorted.at(-1)!) - time(sorted[0]!))) / 39 + 123).toISOString());
    for (const ts of probes) expect(json(log.stateAt(ts)), ts).toBe(json(reference(prefix(ts))));
  });

  it('첫 이벤트보다 이르면 처음 상태, 마지막보다 늦으면 최신 상태', () => {
    expect(json(log.stateAt('2000-01-01T00:00:00Z'))).toBe(json(initialState(index)));
    expect(log.stateAt('2099-01-01T00:00:00Z')).toBe(log.latest());
    expect(log.stateAt(sorted.at(-1)!.ts)).toBe(log.latest());
  });

  it('읽을 수 없는 ts는 최신 상태', () => {
    expect(log.stateAt('???')).toBe(log.latest());
  });

  it('stateAt이 돌려준 상태는 이후 이벤트가 들어와도 바뀌지 않는다', () => {
    const mine = new EventLog(index, { snapshotEvery: 10 });
    mine.add(sorted.slice(0, 120));
    const at = mine.stateAt(sorted[60]!.ts);
    const snapshot = json(at);
    mine.add(sorted.slice(120, 200));
    mine.add([{ ...sorted[30]!, event_id: 'late-1' }]);                  // 과거 ts가 끼어도
    expect(json(at)).toBe(snapshot);
  });

  it('과거 ts의 이벤트가 끼면 그 지점부터 다시 계산한 결과가 정렬 후 reduce와 같다', () => {
    const mine = new EventLog(index, { snapshotEvery: 9 });
    const head = sorted.slice(0, 150);
    const late = [sorted[10]!, sorted[44]!].map((e, i) => ({ ...e, event_id: `late-${i}`, message: `늦게 옴 ${i}` }));
    mine.add(head);
    mine.add(late);
    const received = [...head, ...late];
    expect(json(mine.latest())).toBe(json(reference(expectedOrder(received))));
    const probe = sorted[80]!.ts;
    expect(json(mine.stateAt(probe))).toBe(json(reference(expectedOrder(received).filter((e) => time(e) <= Date.parse(probe)))));
  });
});

describe('maxEvents', () => {
  const all = expectedOrder(simEvents(21, 'day', 2000));

  it('넘으면 오래된 것부터 버리지만 latest()와 남은 구간의 stateAt은 바뀌지 않는다', () => {
    const limited = new EventLog(index, { maxEvents: 100, snapshotEvery: 11 });
    const rng = createRng(8);
    for (const part of chunks(all, rng, 40)) limited.add(part);
    expect(all.length).toBeGreaterThan(300);
    expect(limited.size).toBe(100);
    expect(json(limited.latest())).toBe(json(reference(all)));
    expect(limited.range().start).toBe(all[all.length - 100]!.ts);
    expect(limited.range().end).toBe(all.at(-1)!.ts);
    expect(limited.events()).toHaveLength(100);
    // 남은 구간 안의 시각
    for (const k of [all.length - 99, all.length - 60, all.length - 30, all.length - 2]) {
      const ts = all[k]!.ts;
      expect(json(limited.stateAt(ts)), `k=${k}`).toBe(json(reference(all.filter((e) => time(e) <= Date.parse(ts)))));
    }
    // 버린 구간보다 앞의 시각은 버린 이벤트까지 반영한 기준 상태
    expect(json(limited.stateAt('2000-01-01T00:00:00Z'))).toBe(json(reference(all.slice(0, all.length - 100))));
  });

  it('조금 늦게 온 이벤트가 상한 안쪽에 끼어도 결과가 같다', () => {
    const rng = createRng(77);
    const received = all.slice();
    for (let i = 0; i < received.length - 12; i += 1) {
      if (rng.chance(0.3)) {
        const j = i + rng.int(1, 10);
        [received[i], received[j]] = [received[j]!, received[i]!];       // 이웃 이벤트와 순서를 바꿔 도착
      }
    }
    const limited = new EventLog(index, { maxEvents: 100, snapshotEvery: 8 });
    for (const part of chunks(received, rng, 25)) limited.add(part);
    expect(limited.size).toBe(100);
    expect(json(limited.latest())).toBe(json(reference(expectedOrder(received))));
    const sortedAll = expectedOrder(received);
    const ts = sortedAll[sortedAll.length - 40]!.ts;
    expect(json(limited.stateAt(ts))).toBe(json(reference(sortedAll.filter((e) => time(e) <= Date.parse(ts)))));
  });

  it('한 번에 아주 많이 넣어도 같다', () => {
    const limited = new EventLog(index, { maxEvents: 50 });
    limited.add(all);
    expect(limited.size).toBe(50);
    expect(json(limited.latest())).toBe(json(reference(all)));
  });

  it('최근에 버린 이벤트가 다시 와도 중복으로 막는다(버린 id도 상한 안에서 기억한다)', () => {
    const limited = new EventLog(index, { maxEvents: 50 });
    limited.add(all);
    const justDropped = all.slice(all.length - 90, all.length - 55);        // 로그에서는 밀려났지만 가장 최근 id 범위 안
    const before = JSON.stringify(limited.latest());
    const r = limited.add(justDropped);
    expect(r.added).toBe(0);
    expect(r.duplicates).toBe(justDropped.length);
    expect(JSON.stringify(limited.latest())).toBe(before);
  });

  it('기본 상한은 20000건', () => {
    const big: PbEvent[] = Array.from({ length: 20050 }, (_, i) => ({
      event_id: `b-${i}`, ts: new Date(Date.parse('2026-10-17T00:00:00Z') + i * 1000).toISOString(), type: 'staff_status_changed', staff_id: index.org.staff[0]!.id,
      executor: 'script', task_id: null, message: 'm', payload: { status: i % 2 ? 'working' : 'idle' },
    }));
    const log = new EventLog(index);
    log.add(big);
    expect(log.size).toBe(20000);
    expect(log.latest().seq).toBe(20050);
  });
});

describe('density · marks · range · clear', () => {
  const mk = (id: string, sec: number, type: EventType = 'task_created'): PbEvent => ({
    event_id: id, ts: new Date(Date.parse('2026-10-17T00:00:00Z') + sec * 1000).toISOString(), type, staff_id: index.org.staff[0]!.id, executor: 'claude',
    task_id: `t-${id}`, message: id, payload: type === 'task_created' ? { title: id } : type === 'approval_requested' ? { approval_id: `a-${id}`, summary: '' } : type === 'task_blocked' ? { reason: 'x' } : undefined,
  });

  it('비어 있으면 range는 null, density는 0으로 채운 bins칸, marks는 빈 목록', () => {
    const log = new EventLog(index);
    expect(log.range()).toEqual({ start: null, end: null });
    expect(log.density()).toEqual(new Array(60).fill(0));
    expect(log.density(5)).toEqual([0, 0, 0, 0, 0]);
    expect(log.marks()).toEqual([]);
    expect(log.size).toBe(0);
    expect(json(log.latest())).toBe(json(initialState(index)));
  });

  it('density: 첫~마지막 이벤트 시각을 bins칸으로 나눈 이벤트 수(합 = 이벤트 수, 마지막 이벤트는 마지막 칸)', () => {
    const log = new EventLog(index);
    log.add(Array.from({ length: 60 }, (_, i) => mk(`d${i}`, i)));       // 0~59초에 1건씩
    const d = log.density(60);
    expect(d).toHaveLength(60);
    expect(d.reduce((a, b) => a + b, 0)).toBe(60);
    expect(d[59]).toBeGreaterThanOrEqual(1);
    expect(d[0]).toBeGreaterThanOrEqual(1);
    const ten = log.density(10);
    expect(ten.reduce((a, b) => a + b, 0)).toBe(60);
    expect(ten.every((x) => x >= 5 && x <= 7)).toBe(true);
    expect(log.density(0)).toHaveLength(1);                              // 0칸은 1칸으로
  });

  it('density: 이벤트가 몰려 있으면 그 칸에 몰린다. 시각이 모두 같으면 첫 칸', () => {
    const log = new EventLog(index);
    log.add([mk('a', 0), mk('b', 1), mk('c', 2), mk('d', 100)]);
    const d = log.density(4);
    expect(d).toEqual([3, 0, 0, 1]);
    const same = new EventLog(index);
    same.add([mk('x', 5), mk('y', 5)]);
    expect(same.density(3)).toEqual([2, 0, 0]);
  });

  it('marks: 승인 요청·막힘만, 오래된 것부터, 최근 300건', () => {
    const log = new EventLog(index);
    const events: PbEvent[] = [];
    for (let i = 0; i < 350; i += 1) events.push(mk(`m${i}`, i * 2, i % 2 ? 'task_blocked' : 'approval_requested'), mk(`n${i}`, i * 2 + 1, 'task_created'));
    log.add(events);
    const marks = log.marks();
    expect(marks).toHaveLength(300);
    expect(marks.every((m) => m.kind === 'approval' || m.kind === 'blocked')).toBe(true);
    expect(marks[0]).toEqual({ ts: events.find((e) => e.event_id === 'm50')!.ts, kind: 'approval' });
    expect(marks.at(-1)).toEqual({ ts: events.find((e) => e.event_id === 'm349')!.ts, kind: 'blocked' });
    const times = marks.map((m) => Date.parse(m.ts));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new EventLog(index).marks()).toEqual([]);
  });

  it('range: 첫 이벤트와 마지막 이벤트의 ts', () => {
    const log = new EventLog(index);
    log.add([mk('b', 30), mk('a', 10), mk('c', 20)]);
    expect(log.range()).toEqual({ start: mk('a', 10).ts, end: mk('b', 30).ts });
  });

  it('clear(): 모두 비우고 처음 상태로, 이전 id도 다시 받는다', () => {
    const log = new EventLog(index, { snapshotEvery: 3 });
    log.add(stream.slice(0, 40));
    log.clear();
    expect(log.size).toBe(0);
    expect(log.range()).toEqual({ start: null, end: null });
    expect(log.events()).toEqual([]);
    expect(log.marks()).toEqual([]);
    expect(json(log.latest())).toBe(json(initialState(index)));
    expect(json(log.stateAt(stream[10]!.ts))).toBe(json(initialState(index)));
    expect(log.add(stream.slice(0, 40))).toEqual({ added: 40, duplicates: 0 });
    expect(json(log.latest())).toBe(json(reference(stream.slice(0, 40))));
  });
});

describe('성능', () => {
  const N = 20000;
  const staff = index.org.staff.slice(0, 40).map((s) => s.id);
  const events: PbEvent[] = [];
  for (let i = 0; i < N; i += 1) {
    const task = Math.floor(i / 3);
    const who = staff[task % staff.length]!;
    const type: EventType = (['task_created', 'task_started', 'task_completed'] as const)[i % 3]!;
    events.push({
      event_id: `p-${i}`, ts: new Date(Date.parse('2026-10-17T00:00:00Z') + i * 1000).toISOString(), type, staff_id: who, executor: 'claude',
      task_id: `task-${task}`, message: `${type} ${i}`, ...(type === 'task_created' ? { payload: { title: `작업 ${task}`, manual_minutes: 10 } } : {}),
    });
  }

  it('이벤트 2만 건 add가 3초 이내, stateAt 1회가 설계 목표(50ms) 수준', () => {
    const log = new EventLog(index);
    const t0 = performance.now();
    log.add(events);
    const addMs = performance.now() - t0;
    expect(log.size).toBe(N);
    expect(addMs, `add ${addMs.toFixed(0)}ms`).toBeLessThan(3000);

    const mid = events[N / 2]!.ts;
    log.stateAt(mid);                                                    // 첫 호출(JIT) 제외
    const times: number[] = [];
    for (const k of [0.1, 0.35, 0.5, 0.77, 0.93]) {
      const s = performance.now();
      log.stateAt(events[Math.floor(N * k)]!.ts);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    // 설계 목표는 50ms(로컬 실측은 그 안쪽). 공유 CI 실행기·병렬 시험 부하에서 흔들리지 않게 중앙값에 2배 여유를 두고,
    // 최대값은 병적인 경우(스냅숏을 못 쓰고 처음부터 재생 등)만 잡는다.
    expect(times[2]!, `stateAt 중앙값 ${times[2]!.toFixed(1)}ms`).toBeLessThan(100);
    expect(times[4]!, `stateAt 최대 ${times[4]!.toFixed(1)}ms`).toBeLessThan(400);
    const l0 = performance.now();
    log.latest();
    expect(performance.now() - l0).toBeLessThan(100);
  });

  it('5천 건씩 나눠 넣어도(실연결 폴링) 합쳐서 3초 이내', () => {
    const log = new EventLog(index);
    const t0 = performance.now();
    for (let i = 0; i < N; i += 5000) log.add(events.slice(i, i + 5000));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(log.latest().seq).toBe(N);
  });
});
