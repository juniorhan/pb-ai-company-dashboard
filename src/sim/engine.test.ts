// 시뮬레이션 끝까지 돌려 보기: 가짜 시계·타이머로 SimulatorSource를 돌리고, 엔진(SimEngine)을 직접 부려 시계·구간 규칙도 확인한다.
import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { applyInPlace, cloneShell, initialState } from '../core/reducer';
import { indexOrg, parseOrg } from '../data/org';
import { parseEvent } from '../data/schema';
import { SimulatorSource } from '../sources/simulator';
import type { SimulatorOptions } from '../sources/simulator';
import { UNASSIGNED_PREFIX } from '../types';
import type { DashboardState, Org, PbEvent } from '../types';
import { AUTO_APPROVE_TAU, SimEngine, formatKst, kstDateOf } from './engine';
import { createFakeClock } from './fake-clock';
import { DEFAULT_IDLE, loadScenarioLibrary, parseScenarioFiles } from './load';
import type { ScenarioLibrary } from './load';

const index = indexOrg(parseOrg(bundledOrg));
const library = loadScenarioLibrary();
const DATE = '2026-10-17';

/* ───────────── 가짜 시계·타이머로 SimulatorSource 돌리기 ───────────── */

function makeSim(over: Partial<SimulatorOptions> = {}, lib: ScenarioLibrary = library, idx = index) {
  const clock = createFakeClock();                       // 실제 시각은 아무 값이나 — 시뮬레이션 시각과 무관하다
  const source = new SimulatorSource({ index: idx, library: lib, seed: 1, startDate: DATE, now: clock.now, setTimer: clock.setTimer, ...over });
  const events: PbEvent[] = [];
  const log: string[] = [];
  source.subscribe((b) => { events.push(...b); log.push(`batch:${b.length}`); });
  source.onReset?.(() => { log.push('reset'); });
  return { source, events, log, run: clock.run };
}

function fold(events: PbEvent[], idx = index): DashboardState {
  const state = cloneShell(initialState(idx));
  for (const e of events) applyInPlace(state, e, idx);
  return state;
}

const ended = (s: string): boolean => s === 'completed' || s === 'rejected';
const tsMs = (e: PbEvent): number => Date.parse(e.ts);

/** 이벤트 열이 스키마를 지키고 ts가 줄지 않는지 */
function expectWellFormed(events: PbEvent[]): void {
  let prev = Number.NEGATIVE_INFINITY;
  events.forEach((e, i) => {
    const r = parseEvent(e);
    if (!r.ok) throw new Error(`#${i} ${e.event_id}: ${r.error}`);
    if (tsMs(e) < prev) throw new Error(`#${i} ${e.event_id}: ts가 거꾸로 감 ${e.ts}`);
    prev = tsMs(e);
  });
}

/* ───────────── ① 시나리오마다 자동 승인으로 끝까지 ───────────── */

describe('시나리오 끝까지(자동 승인)', () => {
  for (const id of library.scenarios.keys()) {
    it(`${id}: 작업이 모두 완료·반려로 끝나고 승인 대기 0, 이벤트는 스키마를 지키고 ts는 줄지 않는다`, () => {
      const sim = makeSim({ scenario: id, autoApprove: true });
      sim.source.start();
      sim.run(240_000);                                                   // 1배속 240초: 앞 한가한 15초 + 시나리오 + 자동 승인 20초 여유
      expectWellFormed(sim.events);
      const state = fold(sim.events);

      const own = Object.values(state.tasks).filter((t) => t.id.startsWith(`${id}#1/`));
      expect(own.length).toBeGreaterThan(0);
      for (const t of own) expect(ended(t.status), `${t.id} = ${t.status}`).toBe(true);
      expect(Object.values(state.approvals).filter((a) => a.status === 'pending')).toEqual([]);
      expect(Object.values(state.approvals).filter((a) => a.auto).length).toBeGreaterThan(0);

      // 엔진과 리듀서가 어긋나지 않는다: 조직에 없는 행위자·모르는 작업·모르는 승인이 한 번도 없었다
      expect(state.warnings).toEqual([]);
      expect(Object.values(state.staff).filter((s) => !s.known)).toEqual([]);
      expect(sim.events.some((e) => e.staff_id.startsWith(UNASSIGNED_PREFIX))).toBe(false);

      // 상태가 남아 돌지 않는다: 대기가 아닌 직원은 한가한 작업 또는 다음 회차 작업을 하고 있을 때뿐
      for (const s of Object.values(state.staff)) {
        if (s.status === 'idle') continue;
        expect(s.currentTaskId, `${s.id}: ${s.status}`).toMatch(/^idle#|#2\//);
      }
    });
  }

  it('모든 이벤트의 executor·task_id·message가 채워져 있고 종목 추천·승인 주장 문구가 없다', () => {
    const sim = makeSim({ scenario: 'closing-briefing' });
    sim.source.start();
    sim.run(240_000);
    for (const e of sim.events) {
      expect(e.message, e.event_id).not.toBe('');
      if (e.type === 'staff_status_changed') expect(e.task_id).toBeNull();
      else expect(e.task_id).toEqual(expect.any(String));
      expect(JSON.stringify(e)).not.toMatch(/매수|매도|추천 종목|(준법감시|금융당국).{0,8}승인(을|이)?\s?(받|완료|획득)/);
    }
  });
});

/* ───────────── ② 자동 승인 끔 + 직접 결정 ───────────── */

describe('자동 승인 끔 + decide', () => {
  for (const id of library.scenarios.keys()) {
    it(`${id}: 반려해도 끝까지 간다(대기 중에는 자동으로 넘어가지 않는다)`, () => {
      const sim = makeSim({ scenario: id, autoApprove: false });
      sim.source.start();
      const requested = (): PbEvent | undefined => sim.events.find((e) => e.type === 'approval_requested');
      for (let i = 0; i < 2000 && !requested(); i += 1) sim.run(250);
      const req = requested()!;
      expect(req).toBeDefined();
      const approvalId = (req.payload as { approval_id: string }).approval_id;
      expect(sim.source.control.autoApproveDue(approvalId)).toBeNull();

      sim.run(120_000);                                                   // 2분을 기다려도 결정은 나지 않는다
      expect(sim.events.some((e) => e.type === 'approval_decided')).toBe(false);
      const before = fold(sim.events);
      expect(before.approvals[approvalId]!.status).toBe('pending');
      expect(before.staff[req.staff_id]!.status).toBe('waiting_approval');

      sim.source.decide!(approvalId, 'reject');
      const decided = sim.events.find((e) => e.type === 'approval_decided')!;
      expect(decided).toMatchObject({ staff_id: 'ceo', executor: 'human', message: '대표 반려(시뮬레이션)', payload: { approval_id: approvalId, decision: 'reject', auto: false } });

      sim.run(120_000);
      expectWellFormed(sim.events);
      const state = fold(sim.events);
      const own = Object.values(state.tasks).filter((t) => t.id.startsWith(`${id}#1/`));
      for (const t of own) expect(ended(t.status), `${t.id} = ${t.status}`).toBe(true);
      expect(Object.values(state.approvals).filter((a) => a.status === 'pending' && a.id.startsWith(`${id}#1/`))).toEqual([]);
      expect(state.approvals[approvalId]).toMatchObject({ status: 'rejected', auto: false });
      expect(state.warnings).toEqual([]);
    });
  }

  it('승인(직접)도 끝까지 간다', () => {
    const sim = makeSim({ scenario: 'morning-briefing', autoApprove: false });
    sim.source.start();
    for (let i = 0; i < 2000 && !sim.events.some((e) => e.type === 'approval_requested'); i += 1) sim.run(250);
    const approvalId = (sim.events.find((e) => e.type === 'approval_requested')!.payload as { approval_id: string }).approval_id;
    sim.source.decide!(approvalId, 'approve');
    sim.run(120_000);
    const state = fold(sim.events);
    const brief = state.tasks['morning-briefing#1/brief']!;
    expect(brief.status).toBe('completed');
    expect(state.approvals[approvalId]).toMatchObject({ status: 'approved', auto: false });
    expect(sim.events.find((e) => e.type === 'approval_decided')!.message).toBe('대표 승인(시뮬레이션)');
  });

  it('대기 중이 아닌 승인 번호의 decide는 무시한다', () => {
    const sim = makeSim({ scenario: 'morning-briefing', autoApprove: false });
    sim.source.start();
    sim.run(30_000);
    const n = sim.events.length;
    sim.source.decide!('nope:A1', 'approve');
    expect(sim.events.length).toBe(n);
  });
});

/* ───────────── ③ 하루 압축 재생 ───────────── */

describe("'day' 한 바퀴 완주 뒤 날짜 +1", () => {
  it('06:00~18:30을 돌고 다음 날 06:00부터 반복한다. 시각은 거꾸로 가지 않는다', () => {
    const sim = makeSim({ scenario: 'day', speed: 5 });
    sim.source.start();
    sim.run(300_000);                                                    // 5배속 300초 = 1배속 1500초(하루 약 15분 + 승인 대기)
    expectWellFormed(sim.events);
    const days = new Set(sim.events.map((e) => e.ts.slice(0, 10)));
    expect(days.has('2026-10-17')).toBe(true);
    expect(days.has('2026-10-18')).toBe(true);
    const day1 = sim.events.filter((e) => e.ts.startsWith('2026-10-17'));
    expect(day1[0]!.ts >= '2026-10-17T06:00:00+09:00').toBe(true);
    const lastDay1 = day1.at(-1)!.ts;
    expect(lastDay1 <= '2026-10-17T19:00:00+09:00').toBe(true);
    const day2 = sim.events.filter((e) => e.ts.startsWith('2026-10-18'));
    expect(day2[0]!.ts >= '2026-10-18T06:00:00+09:00').toBe(true);
    // 회차가 올라가고, 새 회차 시나리오가 다시 돈다
    expect(sim.events.some((e) => e.task_id?.startsWith('morning-briefing#1/'))).toBe(true);
    expect(sim.events.some((e) => e.task_id?.startsWith('morning-briefing#2/'))).toBe(true);
    // 하루 계획의 시나리오 4개가 모두 한 번씩 돌았다
    for (const id of ['morning-briefing', 'report-digest', 'anomaly', 'closing-briefing']) {
      const state = fold(sim.events);
      const own = Object.values(state.tasks).filter((t) => t.id.startsWith(`${id}#1/`));
      expect(own.length, id).toBeGreaterThan(0);
      for (const t of own) expect(ended(t.status), `${t.id} = ${t.status}`).toBe(true);
    }
  });

  it('시나리오는 계획에 적힌 시각에 시작한다(모닝 06:30, 리포트 10:00, 이상 상황 13:30, 마감 15:40)', () => {
    const sim = makeSim({ scenario: 'day', speed: 5 });
    sim.source.start();
    sim.run(200_000);
    const firstOf = (id: string): string => sim.events.find((e) => e.task_id?.startsWith(`${id}#1/`))!.ts;
    expect(firstOf('morning-briefing')).toBe(`${DATE}T06:30:00+09:00`);
    expect(firstOf('report-digest')).toBe(`${DATE}T10:00:00+09:00`);
    expect(firstOf('anomaly')).toBe(`${DATE}T13:30:00+09:00`);
    expect(firstOf('closing-briefing')).toBe(`${DATE}T15:40:00+09:00`);
  });
});

/* ───────────── ④ 같은 seed → 같은 이벤트 열 ───────────── */

describe('재현성', () => {
  it('같은 seed·같은 시간이면 같은 이벤트 열(tick 간격이 달라도)', () => {
    const a = makeSim({ seed: 5, scenario: 'day', speed: 5, tickMs: 250 });
    const b = makeSim({ seed: 5, scenario: 'day', speed: 5, tickMs: 100 });
    a.source.start();
    b.source.start();
    a.run(300_000);
    b.run(300_000);
    expect(a.events.length).toBeGreaterThan(300);
    expect(b.events).toEqual(a.events);
  });

  it('속도는 시간만 압축할 뿐 같은 열을 낸다(1배속 120초 = 2배속 60초)', () => {
    const slow = makeSim({ seed: 8, scenario: 'morning-briefing', speed: 1 });
    const fast = makeSim({ seed: 8, scenario: 'morning-briefing', speed: 2 });
    slow.source.start();
    fast.source.start();
    slow.run(120_000);
    fast.run(60_000);
    expect(slow.events.length).toBeGreaterThan(20);
    expect(fast.events).toEqual(slow.events);
  });

  it('seed가 다르면 한가한 활동이 달라진다', () => {
    const a = makeSim({ seed: 1, scenario: 'idle-morning' });
    const b = makeSim({ seed: 2, scenario: 'idle-morning' });
    a.source.start();
    b.source.start();
    a.run(60_000);
    b.run(60_000);
    expect(a.events.length).toBeGreaterThan(10);
    expect(a.events.map((e) => e.staff_id)).not.toEqual(b.events.map((e) => e.staff_id));
  });

  it('엔진은 advance를 몇 번에 나눠 불러도 같은 열을 낸다', () => {
    const make = (): SimEngine => new SimEngine({ index, library, seed: 33, scenario: 'closing-briefing', startDate: DATE, autoApprove: true });
    const whole = make().advance(200);
    const parts = make();
    const pieces: PbEvent[] = [];
    for (let i = 0; i < 400; i += 1) pieces.push(...parts.advance(0.5));
    expect(whole.length).toBeGreaterThan(40);
    expect(pieces).toEqual(whole);
  });
});

/* ───────────── ⑤ setScenario ───────────── */

describe('setScenario', () => {
  it('onReset을 먼저 알리고, 새로 처음부터 재생하며, 이벤트 id는 겹치지 않는다', () => {
    const sim = makeSim({ scenario: 'morning-briefing' });
    sim.source.start();
    sim.run(60_000);
    const before = sim.events.length;
    const lastBefore = sim.events.at(-1)!;
    expect(before).toBeGreaterThan(10);
    expect(sim.log.filter((l) => l === 'reset')).toHaveLength(0);

    sim.source.control.setScenario('anomaly');
    expect(sim.log.filter((l) => l === 'reset')).toHaveLength(1);
    expect(sim.source.control.getScenario()).toBe('anomaly');
    const resetAt = sim.log.indexOf('reset');
    expect(sim.log.slice(resetAt + 1)).toEqual([]);                       // 리셋 알림 뒤에 아직 새 이벤트는 없다
    sim.run(60_000);

    const fresh = sim.events.slice(before);
    expect(fresh.length).toBeGreaterThan(5);
    expect(sim.log.indexOf('reset')).toBeLessThan(sim.log.findIndex((l, i) => i > resetAt && l.startsWith('batch')));
    const ids = sim.events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);                           // 리셋해도 id가 겹치지 않는다
    expect(fresh[0]!.event_id).toMatch(/^sim-1-1-1$/);
    expect(lastBefore.event_id).toMatch(/^sim-1-0-/);
    expect(fresh.some((e) => e.task_id?.startsWith('anomaly#1/'))).toBe(true);
    expect(fresh[0]!.ts.startsWith(DATE)).toBe(true);                     // 같은 시작 날짜부터 다시
    expectWellFormed(fresh);
  });

  it('리셋을 여러 번 해도 id는 계속 겹치지 않고, 같은 시나리오로 다시 해도 처음부터', () => {
    const sim = makeSim({ scenario: 'anomaly' });
    sim.source.start();
    sim.run(40_000);
    sim.source.control.setScenario('anomaly');
    sim.run(40_000);
    sim.source.control.setScenario('day');
    sim.run(40_000);
    const ids = sim.events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sim.log.filter((l) => l === 'reset')).toHaveLength(2);
    expect(sim.source.control.getScenario()).toBe('day');
  });

  it('재생 중이었으면 계속 재생하고, 멈춰 있었으면 멈춘 채로 둔다', () => {
    const playing = makeSim({ scenario: 'anomaly' });
    playing.source.start();
    playing.source.control.setScenario('morning-briefing');
    expect(playing.source.control.isPlaying()).toBe(true);
    playing.run(20_000);
    expect(playing.events.length).toBeGreaterThan(0);
    const paused = makeSim({ scenario: 'anomaly' });
    paused.source.start();
    paused.source.control.pause();
    paused.source.control.setScenario('morning-briefing');
    paused.run(20_000);
    expect(paused.events).toEqual([]);
  });

  it('없는 시나리오 id는 하루 압축 재생으로 되돌리고 경고를 남긴다', () => {
    const sim = makeSim({ scenario: 'no-such-scenario' });
    expect(sim.source.control.getScenario()).toBe('day');
    expect(sim.source.warnings.some((w) => w.includes('no-such-scenario'))).toBe(true);
  });
});

/* ───────────── ⑥ 일시정지 ───────────── */

describe('일시정지', () => {
  it('멈춰 있는 동안 이벤트가 0건이고 시계도 멈춘다. 다시 재생하면 몰아서 따라잡지 않는다', () => {
    const sim = makeSim({ scenario: 'idle-morning' });
    sim.source.start();
    sim.run(30_000);
    expect(sim.events.length).toBeGreaterThan(5);
    sim.source.control.pause();
    expect(sim.source.control.isPlaying()).toBe(false);
    expect(sim.source.getStatus()).toMatchObject({ state: 'paused' });
    const n = sim.events.length;
    const clock = sim.source.control.clock();
    sim.run(600_000);
    expect(sim.events.length).toBe(n);
    expect(sim.source.control.clock()).toBe(clock);

    sim.source.control.play();
    expect(sim.source.getStatus()).toMatchObject({ state: 'live', detail: '시뮬레이션 재생 중' });
    sim.run(5_000);
    const added = sim.events.length - n;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(40);                                       // 5초치만(멈춘 600초치가 한꺼번에 쏟아지지 않는다)
    const advancedMs = Date.parse(sim.source.control.clock()) - Date.parse(clock);
    expect(advancedMs).toBeLessThan(3 * 3600 * 1000 * (6 / 180));          // 한가한 오전 비율(3시간/180초)로 6초 이내
  });

  it('멈춘 채 setSpeed·setAutoApprove를 바꿔도 이벤트는 없다', () => {
    const sim = makeSim({ scenario: 'idle-morning' });
    sim.source.start();
    sim.source.control.pause();
    sim.source.control.setSpeed(5);
    sim.source.control.setAutoApprove(false);
    sim.run(60_000);
    expect(sim.events).toEqual([]);
  });
});

/* ───────────── ⑦ 한가한 작업 중인 직원을 시나리오가 쓰면 ───────────── */

function tinyOrg(): Org {
  return {
    format: 1,
    meta: { generated_at: '2026-10-17T00:00:00.000Z', source: 'fixture', source_hash: 'tiny', counts: { depts: 1, teams: 1, staff: 1, expansion: 0 } },
    ceo: { title: '대표이사', holds: [], owner_only: [] },
    hq: [{ id: 'hq.claude', name: 'Claude', executor: 'claude', role: '' }],
    depts: [{ id: 'tst', name: '시험본부', head: '본부장', role: '' }],
    teams: [{ id: 'tst-01', dept: 'tst', name: '시험팀', role: '', status: 'active', phase: 'P0' }],
    staff: [{
      id: 'tst-01-e01', team: 'tst-01', dept: 'tst', name: '일꾼', role: '', status: 'active', phase: 'P0', risk: 'R0',
      executors: ['claude'], checkers: [], checker_staff: [], duties: [{ id: 'tst-01-T01', title: '시험 업무' }],
    }],
    expansion: [],
    legacy: { teams: {}, depts: {} },
  };
}

describe('한가한 작업 중인 직원을 시나리오가 쓰면 그 작업을 먼저 끝낸다', () => {
  const tiny = indexOrg(parseOrg(tinyOrg()));
  const WORKER = 'tst-01-e01';
  const lib = parseScenarioFiles({
    'tiny.json': {
      id: 'tiny', title: '작은 시나리오', description: '직원 1명', start: '09:00', virtual_minutes: 10,
      steps: [
        { after: 0, do: 'create', task: 'a', title: '시나리오 작업', actor: { duty: 'tst-01-T01' }, executor: 'claude' },
        { after: 2, do: 'start', task: 'a' },
        { after: 20, do: 'complete', task: 'a' },
      ],
    },
    'idle.json': { rate_per_min: 600, duration_seconds: [100, 100], review_chance: 0, weights: { active: 1, building: 1, planned: 1, paused: 0 }, manual_minutes: [5, 5] },
  });

  it('시나리오 이벤트 바로 앞에 `다른 작업으로 전환` 완료가 같은 시각에 끼고, 시나리오가 도는 동안 그 직원에게 한가한 작업이 생기지 않는다', () => {
    expect(lib.warnings).toEqual([]);
    const sim = makeSim({ scenario: 'tiny' }, lib, tiny);
    sim.source.start();
    sim.run(100_000);
    expectWellFormed(sim.events);

    const firstScenario = sim.events.findIndex((e) => e.task_id?.startsWith('tiny#1/'));
    expect(firstScenario).toBeGreaterThan(0);
    const forced = sim.events[firstScenario - 1]!;
    expect(forced).toMatchObject({ type: 'task_completed', staff_id: WORKER, message: '다른 작업으로 전환' });
    expect(forced.task_id).toMatch(/^idle#/);
    expect(forced.ts).toBe(sim.events[firstScenario]!.ts);
    // 그 한가한 작업은 아직 한참 남아 있었다(길이 100초인데 15초 만에 끝났다)
    const idleCreated = sim.events.find((e) => e.task_id === forced.task_id && e.type === 'task_created')!;
    expect(Date.parse(forced.ts) - Date.parse(idleCreated.ts)).toBeLessThan(15 * 60_000 + 1);

    // 시나리오 작업이 진행되는 동안(만들기~완료) 그 직원에게 새 한가한 작업이 없다
    const complete = sim.events.findIndex((e) => e.task_id === 'tiny#1/a' && e.type === 'task_completed');
    expect(complete).toBeGreaterThan(firstScenario);
    const between = sim.events.slice(firstScenario, complete + 1);
    expect(between.filter((e) => e.task_id?.startsWith('idle#'))).toEqual([]);
    // 끝나면 다시 한가한 활동이 이어진다
    expect(sim.events.slice(complete + 1).some((e) => e.type === 'task_created' && e.task_id?.startsWith('idle#'))).toBe(true);

    // 강제로 끝낸 한가한 작업의 남은 예정 단계(시작·완료)는 이벤트를 내지 않는다: 만들기 → 강제 완료로 끝
    const forcedEvents = sim.events.filter((e) => e.task_id === forced.task_id);
    expect(forcedEvents[0]!.type).toBe('task_created');
    expect(forcedEvents.at(-1)).toBe(forced);
    expect(forcedEvents.filter((e) => e.type === 'task_completed')).toHaveLength(1);

    // 리듀서 기준으로도 문제가 없다
    expect(fold(sim.events, tiny).warnings).toEqual([]);
  });
});

/* ───────────── 한가한 활동의 busy 규칙(현실 조직으로 긴 재생) ───────────── */

describe('busy 규칙(하루 재생을 길게 돌려 리듀서 상태로 확인)', () => {
  it('한가한 작업은 쉬는 직원에게만 생기고, 시나리오 이벤트는 한가한 작업 중인 직원에게 겹치지 않는다', () => {
    const sim = makeSim({ scenario: 'day', speed: 5, seed: 7 });
    sim.source.start();
    sim.run(600_000);                                                     // 5배속 600초 = 1배속 3000초
    expect(sim.events.length).toBeGreaterThan(500);
    const state = cloneShell(initialState(index));
    let idleCreates = 0;
    let scenarioEvents = 0;
    for (const e of sim.events) {
      const isIdleTask = e.task_id?.startsWith('idle#') ?? false;
      if (isIdleTask) {
        if (e.type === 'task_created') {
          idleCreates += 1;
          expect(state.staff[e.staff_id]!.status, `${e.event_id} 한가한 작업 생성자`).toBe('idle');
        }
        if (e.type === 'task_review_requested') {
          const reviewer = (e.payload as { reviewer: string }).reviewer;
          expect(state.staff[reviewer]!.status, `${e.event_id} 한가한 검토자`).toBe('idle');
        }
      } else if (e.type !== 'approval_decided' && e.type !== 'staff_status_changed') {
        scenarioEvents += 1;
        const targets = [e.staff_id, (e.payload as { to?: string; reviewer?: string } | undefined)?.to, (e.payload as { reviewer?: string } | undefined)?.reviewer];
        for (const who of targets) {
          if (!who) continue;
          const cur = state.staff[who]?.currentTaskId;
          expect(cur === null || cur === undefined || !cur.startsWith('idle#'), `${e.event_id}: ${who}가 ${cur}를 하는 중`).toBe(true);
        }
      }
      applyInPlace(state, e, index);
    }
    expect(idleCreates).toBeGreaterThan(50);
    expect(scenarioEvents).toBeGreaterThan(100);
  });
});

/* ───────────── 시계 규칙(엔진 직접) ───────────── */

describe('시계', () => {
  const lib = (extra: Record<string, unknown> = {}, idleRate = 0): ScenarioLibrary =>
    parseScenarioFiles({
      'idle.json': { ...DEFAULT_IDLE, rate_per_min: idleRate },
      's1.json': {
        id: 's1', title: 's1', description: '', start: '09:00', virtual_minutes: 100,
        steps: [
          { after: 0, do: 'create', task: 'a', title: '가', actor: 'ceo', executor: 'human' },
          { after: 50, do: 'start', task: 'a' },
          { after: 50, do: 'complete', task: 'a' },
        ],
      },
      ...extra,
    });
  const engine = (l: ScenarioLibrary, scenario: string, over: { autoApprove?: boolean } = {}): SimEngine =>
    new SimEngine({ index, library: l, seed: 1, scenario, startDate: DATE, autoApprove: over.autoApprove ?? true });

  it('시나리오 구간은 virtual_minutes×60 ÷ 실제 초 비율로 흐른다', () => {
    const l = lib({ 'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ scenario: 's1' }] } });
    const e = engine(l, 'p');
    const out = e.advance(100);
    expect(out.slice(0, 3).map((x) => x.ts)).toEqual([`${DATE}T09:00:00+09:00`, `${DATE}T09:50:00+09:00`, `${DATE}T10:40:00+09:00`]);
    expect(out[0]!.event_id).toBe('sim-1-0-1');
    // 끝나는 순간 계획이 한 바퀴 돌아 다음 날 첫 단계가 바로 이어진다
    expect(out[3]!.ts).toBe('2026-10-18T09:00:00+09:00');
    expect(out).toHaveLength(4);
  });

  it('한가한 구간은 (until − 지금) ÷ real_seconds 비율. 구간이 끝나면 정확히 until에 맞추고, 계획 끝에서 다음 날 시작 시각으로 간다', () => {
    const l = lib({ 'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ idle: true, until: '12:00', real_seconds: 180 }] } });
    const e = engine(l, 'p');
    expect(e.clock()).toBe(`${DATE}T09:00:00+09:00`);
    e.advance(90);
    expect(e.clock()).toBe(`${DATE}T10:30:00+09:00`);
    e.advance(89.999);
    expect(Date.parse(e.clock())).toBeLessThanOrEqual(Date.parse(`${DATE}T12:00:00+09:00`));
    e.advance(0.001);
    expect(e.clock()).toBe('2026-10-18T09:00:00+09:00');                  // 12:00 → 다음 날 09:00
    expect(e.currentDate).toBe('2026-10-18');
    expect(e.currentRunNo).toBe(2);
    e.advance(90);
    expect(e.clock()).toBe('2026-10-18T10:30:00+09:00');
  });

  it('시나리오 시작 시각이 지금보다 늦으면 그 시각으로 앞당기고, 이르면 지금 시각 그대로 시작한다', () => {
    const later = lib({ 'p.json': { id: 'p', title: 'p', description: '', start: '08:00', segments: [{ scenario: 's1' }] } });
    const a = engine(later, 'p').advance(1);
    expect(a[0]!.ts).toBe(`${DATE}T09:00:00+09:00`);                      // 08:00에 시작했지만 s1은 09:00 시작
    const earlier = lib({ 'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ idle: true, until: '10:00', real_seconds: 10 }, { scenario: 's1' }] } });
    const e = engine(earlier, 'p');
    const b = e.advance(11);
    expect(b[0]!.ts).toBe(`${DATE}T10:00:00+09:00`);                      // 10:00에 도착했고 s1(09:00)은 이미 지났으니 지금부터
  });

  it('이미 지난 한가한 구간은 건너뛴다', () => {
    const l = lib({ 'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ scenario: 's1' }, { idle: true, until: '09:30', real_seconds: 60 }, { idle: true, until: '12:30', real_seconds: 30 }] } });
    const e = engine(l, 'p');
    e.advance(100);                                                       // 시나리오 끝: 10:40
    expect(e.clock()).toBe(`${DATE}T10:40:00+09:00`);
    e.advance(15);                                                        // 09:30은 지났으니 건너뛰고 12:30까지 30초 구간의 절반
    expect(e.clock()).toBe(`${DATE}T11:35:00+09:00`);
  });

  it('승인을 기다리는 동안에도 시계는 그 구간 비율로 흐르고, 시나리오는 그 구간에 머문다', () => {
    const approvalScenario = {
      id: 'ap', title: 'ap', description: '', start: '09:00', virtual_minutes: 60,
      steps: [
        { after: 0, do: 'create', task: 'a', title: '가', actor: 'ceo', executor: 'human' },
        { after: 10, do: 'approval', task: 'a', summary: '요약', on_approve: [{ after: 10, do: 'complete', task: 'a' }], on_reject: [] },
      ],
    };
    const l = parseScenarioFiles({
      'idle.json': { ...DEFAULT_IDLE, rate_per_min: 0 },
      'ap.json': approvalScenario,
      'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ scenario: 'ap' }, { idle: true, until: '23:00', real_seconds: 100 }] },
    });
    const e = engine(l, 'p', { autoApprove: false });
    const out = e.advance(200);                                           // 승인 요청(10초) 뒤 190초를 기다렸다
    expect(out.map((x) => x.type)).toEqual(['task_created', 'approval_requested']);
    expect(e.pendingApprovalIds()).toEqual(['ap#1/a:A1']);
    // 비율: 60분 ÷ (10+10)초 = 3분/초 → 200초 뒤는 09:00 + 600분 = 19:00, 아직 다음 구간(한가한 구간)으로 넘어가지 않았다
    expect(e.clock()).toBe(`${DATE}T19:00:00+09:00`);
    const decided = e.decide('ap#1/a:A1', 'approve');
    expect(decided.map((x) => x.type)).toEqual(['approval_decided']);
    expect(decided[0]!.ts).toBe(`${DATE}T19:00:00+09:00`);
    const rest = e.advance(10);
    expect(rest.map((x) => x.type)).toEqual(['task_completed']);
    expect(rest[0]!.ts).toBe(`${DATE}T19:30:00+09:00`);                   // 결정 10초 뒤 = 3분/초 × 10초
  });

  it('시계는 거꾸로 가지 않는다: 이벤트 시각은 줄지 않고 초 단위(+09:00)다', () => {
    const e = new SimEngine({ index, library, seed: 4, scenario: 'day', startDate: DATE, autoApprove: true });
    const out: PbEvent[] = [];
    for (let i = 0; i < 4000; i += 1) out.push(...e.advance(0.5));
    expect(out.length).toBeGreaterThan(500);
    let prev = 0;
    for (const x of out) {
      expect(x.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
      const t = Date.parse(x.ts);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(e.currentRunNo).toBeGreaterThan(1);
  });

  it('자동 승인은 승인 요청 20초(τ) 뒤, 켜고 끄면 그때부터 다시 센다', () => {
    const approvalScenario = {
      id: 'ap', title: 'ap', description: '', start: '09:00', virtual_minutes: 10,
      steps: [
        { after: 0, do: 'create', task: 'a', title: '가', actor: 'ceo', executor: 'human' },
        { after: 5, do: 'approval', task: 'a', summary: '요약', on_approve: [], on_reject: [] },
      ],
    };
    const l = parseScenarioFiles({
      'idle.json': { ...DEFAULT_IDLE, rate_per_min: 0 },
      'ap.json': approvalScenario,
      'p.json': { id: 'p', title: 'p', description: '', start: '09:00', segments: [{ scenario: 'ap' }] },
    });
    expect(AUTO_APPROVE_TAU).toBe(20);
    const e = engine(l, 'p');
    const first = e.advance(5);
    expect(first.map((x) => x.type)).toEqual(['task_created', 'approval_requested']);
    expect(e.getAutoApprove()).toBe(true);
    expect(e.autoApproveRemainingTau('ap#1/a:A1')).toBe(20);
    e.advance(12);
    expect(e.autoApproveRemainingTau('ap#1/a:A1')).toBeCloseTo(8, 6);
    e.setAutoApprove(false);
    expect(e.autoApproveRemainingTau('ap#1/a:A1')).toBeNull();
    expect(e.advance(100)).toEqual([]);                                   // 끄면 예약이 취소된다
    e.setAutoApprove(true);
    expect(e.autoApproveRemainingTau('ap#1/a:A1')).toBe(20);              // 다시 켜면 그때부터 20초
    e.advance(19.9);
    expect(e.pendingApprovalIds()).toEqual(['ap#1/a:A1']);
    const done = e.advance(0.1);
    expect(done.map((x) => x.type)).toEqual(['approval_decided', 'task_created']);   // 결정 직후 시나리오가 끝나 다음 날 첫 단계가 이어진다
    expect(done[0]!.payload).toMatchObject({ auto: true, decision: 'approve' });
    expect(e.autoApproveRemainingTau('ap#1/a:A1')).toBeNull();
  });
});

describe('시나리오 파일이 하나도 없어도 멈추지 않는다', () => {
  it('빈 라이브러리: 한가한 활동만 돌고, 어떤 시나리오 id를 줘도 같다', () => {
    const empty = parseScenarioFiles({});
    expect(empty.menu).toEqual([]);
    for (const id of ['day', '없는-시나리오']) {
      const e = new SimEngine({ index, library: empty, seed: 3, scenario: id, startDate: DATE, autoApprove: true });
      const out = e.advance(300);
      expect(out.length).toBeGreaterThan(20);
      expectWellFormed(out);
      expect(out.every((x) => x.task_id?.startsWith('idle#'))).toBe(true);
      expect(e.currentDate >= DATE).toBe(true);
    }
  });
});

describe('도우미', () => {
  it('formatKst·kstDateOf', () => {
    const ms = Date.parse('2026-10-17T14:59:59.999Z');
    expect(formatKst(ms)).toBe('2026-10-17T23:59:59+09:00');
    expect(kstDateOf(ms)).toBe('2026-10-17');
    expect(kstDateOf(ms + 1)).toBe('2026-10-18');
    expect(formatKst(Date.parse('2026-10-17T15:00:00Z'))).toBe('2026-10-18T00:00:00+09:00');
  });
});
