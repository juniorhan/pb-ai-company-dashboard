// SimulatorSource: 가짜 시계·타이머로 tick, batch, 재생 조작, 자동 승인 남은 시간, 알림 빈도를 확인한다.
import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { createFakeClock } from '../sim/fake-clock';
import { DEFAULT_IDLE, loadScenarioLibrary, parseScenarioFiles } from '../sim/load';
import type { ScenarioLibrary } from '../sim/load';
import type { PbEvent, SourceStatus } from '../types';
import { SIM_SPEEDS, SimulatorSource, nearestSpeed } from './simulator';
import type { SimulatorOptions } from './simulator';

const index = indexOrg(parseOrg(bundledOrg));
const DATE = '2026-10-17';
const realLibrary = loadScenarioLibrary();

/* 시험용 작은 라이브러리: 한꺼번에 나오는 3건 / 승인 1건 / 한가한 구간만(τ 1초 = 시뮬레이션 60초) */
const miniFiles = {
  'idle.json': { ...DEFAULT_IDLE, rate_per_min: 0 },
  'burst.json': {
    id: 'burst', title: '한꺼번에', description: '시험용', start: '09:00', virtual_minutes: 10,
    steps: [
      { after: 0, do: 'create', task: 'a', title: '가', actor: 'ceo', executor: 'human' },
      { after: 0, do: 'start', task: 'a' },
      { after: 0, do: 'complete', task: 'a' },
      { after: 60, do: 'create', task: 'b', title: '나', actor: 'ceo', executor: 'human' },
    ],
  },
  'ask.json': {
    id: 'ask', title: '승인', description: '시험용', start: '09:00', virtual_minutes: 10,
    steps: [
      { after: 0, do: 'create', task: 'a', title: '가', actor: 'ceo', executor: 'human' },
      { after: 5, do: 'approval', task: 'a', summary: '요약', on_approve: [{ after: 5, do: 'complete', task: 'a' }], on_reject: [] },
    ],
  },
  'burst-plan.json': { id: 'burst-plan', title: '한꺼번에 계획', description: '', start: '09:00', segments: [{ scenario: 'burst' }] },
  'ask-plan.json': { id: 'ask-plan', title: '승인 계획', description: '', start: '09:00', segments: [{ scenario: 'ask' }] },
  'flat.json': { id: 'flat', title: '한가함', description: '', start: '09:00', segments: [{ idle: true, until: '21:00', real_seconds: 720 }] },
};
const mini = (): ScenarioLibrary => parseScenarioFiles(miniFiles);

function build(over: Partial<SimulatorOptions> = {}, library: ScenarioLibrary = mini()) {
  const clock = createFakeClock();
  const source = new SimulatorSource({
    index, library, seed: 1, startDate: DATE, scenario: 'burst-plan', now: clock.now, setTimer: clock.setTimer, ...over,
  });
  const batches: PbEvent[][] = [];
  const statuses: SourceStatus[] = [];
  const resets: number[] = [];
  source.subscribe((b) => { batches.push(b); });
  source.onStatus((s) => { statuses.push(s); });
  source.onReset(() => { resets.push(clock.now()); });
  return { source, clock, batches, statuses, resets, events: (): PbEvent[] => batches.flat() };
}

const msBetween = (a: string, b: string): number => Date.parse(b) - Date.parse(a);

describe('nearestSpeed', () => {
  it('1·2·5 중 가장 가까운 값, 같은 거리면 작은 쪽', () => {
    expect([...SIM_SPEEDS]).toEqual([1, 2, 5]);
    expect([0, 1, 1.4, 1.5, -3, Number.NEGATIVE_INFINITY].map(nearestSpeed)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([1.6, 2, 3, 3.5].map(nearestSpeed)).toEqual([2, 2, 2, 2]);
    expect([3.6, 4, 5, 100, Number.POSITIVE_INFINITY].map(nearestSpeed)).toEqual([5, 5, 5, 5, 5]);
  });

  it('숫자가 아니면 null', () => {
    expect(nearestSpeed(Number.NaN)).toBeNull();
    expect(nearestSpeed('3' as unknown as number)).toBeNull();
    expect(nearestSpeed(undefined as unknown as number)).toBeNull();
  });
});

describe('SimulatorSource 기본', () => {
  it('종류·이름·실연결 아님, 조작(control)·decide·onReset이 있다', () => {
    const { source } = build();
    expect(source).toMatchObject({ kind: 'sim', label: '시뮬레이션', live: false });
    expect(source.control).toBeDefined();
    expect(typeof source.decide).toBe('function');
    expect(typeof source.onReset).toBe('function');
    expect(source.getStatus()).toEqual({ state: 'idle', detail: '', lastEventTs: null });
  });

  it('start: 상태 live, 두 번 불러도 tick 타이머는 하나', () => {
    const { source, clock, statuses } = build();
    source.start();
    source.start();
    expect(source.getStatus()).toMatchObject({ state: 'live', detail: '시뮬레이션 재생 중' });
    expect(statuses.map((s) => s.state)).toEqual(['live']);
    expect(clock.pending()).toBe(1);
    expect(source.control.isPlaying()).toBe(true);
  });

  it('시작 전에는 시계가 흘러도 아무 일이 없다', () => {
    const { source, clock, batches } = build();
    clock.run(60_000);
    expect(batches).toEqual([]);
    expect(source.control.isPlaying()).toBe(false);
  });

  it('한 tick에서 나온 이벤트는 batch 1개로 낸다', () => {
    const { source, clock, batches } = build();
    source.start();
    clock.run(250);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.type)).toEqual(['task_created', 'task_started', 'task_completed']);
    clock.run(20_000);
    expect(batches).toHaveLength(1);                                     // 다음 이벤트(τ 60)까지는 비어 있는 batch도 내지 않는다
    clock.run(40_000);
    expect(batches).toHaveLength(2);
    // 시나리오가 끝나 하루 계획이 다음 날로 돌아가면 그 첫 3건도 같은 tick의 같은 batch에 실린다
    expect(batches[1]!.map((e) => e.task_id)).toEqual(['burst#1/b', 'burst#2/a', 'burst#2/a', 'burst#2/a']);
    for (const b of batches) expect(b.length).toBeGreaterThan(0);
  });

  it('시뮬레이터 이벤트도 같은 스키마 검사를 지난다: 어긋난 이벤트는 내지 않고 경고로 남긴다', () => {
    const lib = parseScenarioFiles({
      ...miniFiles,
      'burst.json': { ...miniFiles['burst.json'], steps: [{ ...miniFiles['burst.json'].steps[0]!, title: 'x'.repeat(2001) }, ...miniFiles['burst.json'].steps.slice(1)] },
    });
    const { source, clock, batches } = build({}, lib);
    source.start();
    clock.run(250);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.type)).toEqual(['task_started', 'task_completed']);        // 제목이 2000자를 넘는 생성 이벤트만 빠진다
    expect(source.warnings).toHaveLength(1);                                                        // 첫 사유(제목이 들어간 message 또는 payload.title)
    expect(source.warnings[0]).toMatch(/^형식이 맞지 않는 시뮬레이션 이벤트를 건너뜀: .+: 너무 깁니다\(최대 2000자\)$/);
    source.control.setScenario('burst-plan');
    expect(source.warnings).toEqual([]);                                                           // 시나리오를 바꾸면 새로 센다
  });

  it('상태의 lastEventTs는 가장 늦은 이벤트 ts이고, batch가 나갈 때마다 상태도 다시 알린다', () => {
    const { source, clock, statuses, events } = build();
    source.start();
    clock.run(250);
    const last = events().at(-1)!;
    expect(source.getStatus().lastEventTs).toBe(last.ts);
    expect(statuses.at(-1)).toMatchObject({ state: 'live', lastEventTs: last.ts });
    clock.run(60_000);
    expect(source.getStatus().lastEventTs).toBe(events().at(-1)!.ts);
    expect(events().at(-1)!.ts > last.ts).toBe(true);
  });

  it('한 tick에서 흘러가는 실제 시간은 60초까지만 반영한다(절전·백그라운드 뒤 몰아치지 않도록)', () => {
    const { source, clock } = build({ scenario: 'flat', tickMs: 600_000 });   // tick이 10분 늦게 온 것과 같다
    expect(source.control.clock()).toBe(`${DATE}T09:00:00+09:00`);
    source.start();
    clock.run(600_000);
    expect(source.control.clock()).toBe(`${DATE}T10:00:00+09:00`);   // 600초가 아니라 60초 × 1분/초 = 60분
  });

  it('시작 날짜를 안 주거나 잘못 주면 지금(KST) 날짜로 한다', () => {
    const now = (): number => Date.parse('2026-03-05T20:00:00Z');         // KST 2026-03-06 05:00
    const a = new SimulatorSource({ index, library: mini(), seed: 1, scenario: 'flat', now });
    expect(a.control.clock()).toBe('2026-03-06T09:00:00+09:00');
    const b = new SimulatorSource({ index, library: mini(), seed: 1, scenario: 'flat', now, startDate: '2026-13-45' });
    expect(b.control.clock()).toBe('2026-03-06T09:00:00+09:00');
    const c = new SimulatorSource({ index, library: mini(), seed: 1, scenario: 'flat', now, startDate: '내일' });
    expect(c.control.clock()).toBe('2026-03-06T09:00:00+09:00');
    const d = new SimulatorSource({ index, library: mini(), seed: 1, scenario: 'flat', now, startDate: '2027-01-02' });
    expect(d.control.clock()).toBe('2027-01-02T09:00:00+09:00');
  });

  it('경고: 시나리오 파일의 문제와 엔진의 경고를 함께 보여 준다', () => {
    const lib = parseScenarioFiles({ ...miniFiles, 'bad.json': 'oops' });
    const { source } = build({}, lib);
    expect(source.warnings.some((w) => w.startsWith('bad.json'))).toBe(true);
    const missing = build({ scenario: 'no-such-id' });
    expect(missing.source.warnings.some((w) => w.includes('no-such-id'))).toBe(true);
    expect(build().source.warnings).toEqual([]);
  });

  it('시나리오 목록은 라이브러리 메뉴의 사본이다', () => {
    const { source } = build({}, realLibrary);
    const list = source.control.listScenarios();
    expect(list.map((m) => m.id)).toEqual(realLibrary.menu.map((m) => m.id));
    expect(list[0]!.id).toBe('day');
    list[0]!.title = '바꿔 봄';
    expect(source.control.listScenarios()[0]!.title).not.toBe('바꿔 봄');
  });
});

describe('재생·정지', () => {
  it('stop: 타이머를 풀고 상태 idle, 이벤트가 더 나오지 않으며 start로 다시 시작할 수 있다', () => {
    const { source, clock, events, statuses } = build({ scenario: 'ask-plan' });
    const c0 = source.control.clock();
    source.start();
    clock.run(2000);
    const n = events().length;
    expect(n).toBeGreaterThan(0);
    const perSecond = msBetween(c0, source.control.clock()) / 2;   // 실제 1초에 흐르는 시뮬레이션 시간
    source.stop();
    expect(clock.pending()).toBe(0);
    expect(source.getStatus()).toMatchObject({ state: 'idle', detail: '시뮬레이션 정지' });
    expect(source.control.isPlaying()).toBe(false);
    clock.run(60_000);
    expect(events().length).toBe(n);

    const clockAtStop = source.control.clock();
    source.start();
    expect(clock.pending()).toBe(1);
    expect(source.getStatus()).toMatchObject({ state: 'live' });
    clock.run(1000);                                                     // 멈춰 있던 60초는 세지 않는다: 1초분만
    const gap = msBetween(clockAtStop, source.control.clock());
    expect(gap).toBeGreaterThanOrEqual(perSecond * 0.9);
    expect(gap).toBeLessThanOrEqual(perSecond * 1.1);
    expect(statuses.map((s) => s.state)).toContain('idle');
  });

  it('시작한 적 없는 소스의 stop은 상태를 바꾸지 않는다', () => {
    const { source, statuses } = build();
    source.stop();
    expect(statuses).toEqual([]);
    expect(source.getStatus().state).toBe('idle');
  });

  it('pause: 멈추기 직전까지 반영하고, 멈춘 동안 이벤트 0건·시계 정지, play하면 멈춘 시간은 세지 않는다', () => {
    const { source, clock, events } = build();
    source.start();
    clock.run(100);                                                      // 첫 tick(250ms) 전
    expect(events()).toEqual([]);
    source.control.pause();
    expect(events().map((e) => e.type)).toEqual(['task_created', 'task_started', 'task_completed']);
    expect(source.control.isPlaying()).toBe(false);
    expect(source.getStatus()).toMatchObject({ state: 'paused', detail: '일시정지' });

    const stopped = source.control.clock();
    const n = events().length;
    clock.run(600_000);
    expect(events().length).toBe(n);
    expect(source.control.clock()).toBe(stopped);

    source.control.play();
    expect(source.control.isPlaying()).toBe(true);
    expect(source.getStatus()).toMatchObject({ state: 'live', detail: '시뮬레이션 재생 중' });
    clock.run(1000);
    const gap = msBetween(stopped, source.control.clock());
    expect(gap).toBeGreaterThanOrEqual(9000);                            // 1초 = 10초(이 시나리오 비율)
    expect(gap).toBeLessThanOrEqual(11_000);
  });

  it('pause·play를 거듭 불러도 같은 상태 알림을 되풀이하지 않는다', () => {
    const { source, statuses } = build();
    source.start();
    source.control.play();
    expect(statuses.map((s) => s.state)).toEqual(['live']);
    source.control.pause();
    source.control.pause();
    expect(statuses.map((s) => s.state)).toEqual(['live', 'paused']);
    source.control.play();
    source.control.play();
    expect(statuses.map((s) => s.state)).toEqual(['live', 'paused', 'live']);
  });
});

describe('속도', () => {
  it('생성 옵션의 속도는 1·2·5 중 가장 가까운 값', () => {
    expect(build({ speed: 3 }).source.control.getSpeed()).toBe(2);
    expect(build({ speed: 4 }).source.control.getSpeed()).toBe(5);
    expect(build({ speed: 0 }).source.control.getSpeed()).toBe(1);
    expect(build({ speed: Number.NaN }).source.control.getSpeed()).toBe(1);
    expect(build({}).source.control.getSpeed()).toBe(1);
  });

  it('setSpeed: 가까운 값으로 바꾸고 숫자가 아니면 무시한다', () => {
    const { source } = build();
    source.control.setSpeed(5);
    expect(source.control.getSpeed()).toBe(5);
    source.control.setSpeed(Number.NaN);
    expect(source.control.getSpeed()).toBe(5);
    source.control.setSpeed(1.4);
    expect(source.control.getSpeed()).toBe(1);
    source.control.setSpeed(2.9);
    expect(source.control.getSpeed()).toBe(2);
  });

  it('실제 1초에 흐르는 시뮬레이션 시간은 속도에 비례하고, 바꾸기 전까지는 앞 속도로 센다', () => {
    const { source, clock } = build({ scenario: 'flat' });               // τ 1초 = 시뮬레이션 60초
    source.start();
    clock.run(1000);
    expect(source.control.clock()).toBe(`${DATE}T09:01:00+09:00`);
    source.control.setSpeed(5);
    clock.run(1000);
    expect(source.control.clock()).toBe(`${DATE}T09:06:00+09:00`);
    source.control.setSpeed(2);
    clock.run(1000);
    expect(source.control.clock()).toBe(`${DATE}T09:08:00+09:00`);
  });

  it('속도를 바꾸는 순간 지금까지의 이벤트는 앞 속도로 먼저 내보낸다', () => {
    const { source, clock, events } = build();
    source.start();
    clock.run(100);
    expect(events()).toEqual([]);
    source.control.setSpeed(5);
    expect(events()).toHaveLength(3);
  });
});

describe('화면 갱신 알림(subscribeTick)', () => {
  it('초당 최대 4회: 알림 사이는 250ms 이상이고, tick이 더 잦아도 넘지 않는다', () => {
    const { source, clock } = build({ scenario: 'flat', tickMs: 100 });
    const at: number[] = [];
    source.control.subscribeTick(() => { at.push(clock.now()); });
    source.start();
    clock.run(10_000);
    expect(at.length).toBeGreaterThanOrEqual(20);
    expect(at.length).toBeLessThanOrEqual(41);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(250);
  });

  it('tick이 250ms 간격이면 tick마다 알린다', () => {
    const { source, clock } = build({ scenario: 'flat' });
    let n = 0;
    source.control.subscribeTick(() => { n += 1; });
    source.start();
    expect(n).toBe(1);                                                   // 시작할 때 한 번
    clock.run(2000);
    expect(n).toBe(1 + 8);
  });

  it('재생 상태가 바뀌면 바로 알린다. 막 알린 직후라면 다음 tick에 알리고 그 뒤로는 멈춘 동안 알림이 없다', () => {
    const { source, clock } = build({ scenario: 'flat' });
    let n = 0;
    source.control.subscribeTick(() => { n += 1; });
    source.start();
    clock.run(1000);
    const base = n;
    source.control.pause();                                              // 마지막 알림(tick) 직후이므로 바로 알리지 않고 미룬다
    expect(n).toBe(base);
    clock.run(250);
    expect(n).toBe(base + 1);                                            // 다음 tick에 한 번
    clock.run(10_000);
    expect(n).toBe(base + 1);                                            // 멈춘 동안은 알림이 없다
    clock.run(10);
    source.control.play();                                               // 오래 지났으니 바로 알린다
    expect(n).toBe(base + 2);
  });

  it('구독 해지 뒤에는 알리지 않는다. 시작 전 조작은 바로 알린다', () => {
    const { source, clock } = build({ scenario: 'flat' });
    let n = 0;
    const off = source.control.subscribeTick(() => { n += 1; });
    source.control.setSpeed(5);                                          // 시작 전이라 tick이 없으므로 바로
    expect(n).toBe(1);
    source.start();
    expect(n).toBe(2);
    off();
    clock.run(5000);
    expect(n).toBe(2);
  });
});

describe('자동 승인 남은 시간', () => {
  function untilRequested(over: Partial<SimulatorOptions> = {}, library: ScenarioLibrary = mini()) {
    const sim = build({ scenario: 'ask-plan', ...over }, library);
    sim.source.start();
    let request: PbEvent | undefined;
    for (let i = 0; i < 4000 && !request; i += 1) {
      sim.clock.run(250);
      request = sim.events().find((e) => e.type === 'approval_requested');
    }
    if (!request) throw new Error('승인 요청이 나오지 않았습니다');
    return { ...sim, approvalId: (request.payload as { approval_id: string }).approval_id };
  }

  it('요청 직후 실제 20초 ÷ 속도, 시간이 지나면 줄고, 모르는 승인 번호는 null', () => {
    const { source, clock, approvalId } = untilRequested();
    const control = source.control;
    const d0 = control.autoApproveDue(approvalId)!;
    expect(d0).toBeGreaterThan(19_000);
    expect(d0).toBeLessThanOrEqual(20_000);
    clock.run(100);                                                      // tick 사이에도 줄어든다
    expect(Math.abs(d0 - 100 - control.autoApproveDue(approvalId)!)).toBeLessThanOrEqual(1);
    clock.run(4900);
    expect(Math.abs(d0 - 5000 - control.autoApproveDue(approvalId)!)).toBeLessThanOrEqual(1);
    expect(control.autoApproveDue('없는:승인')).toBeNull();
  });

  it('속도가 빠르면 실제 시간으로 짧아진다', () => {
    const { source, approvalId } = untilRequested({ speed: 5 });
    const d = source.control.autoApproveDue(approvalId)!;
    expect(d).toBeGreaterThan(3800);
    expect(d).toBeLessThanOrEqual(4000);
    source.control.setSpeed(2);
    const slower = source.control.autoApproveDue(approvalId)!;
    expect(Math.abs(slower - d * 2.5)).toBeLessThanOrEqual(3);
  });

  it('시간이 다 되면 자동 승인(auto true)이 나가고, 그 뒤 남은 시간은 null', () => {
    const { source, clock, approvalId, events } = untilRequested();
    clock.run(19_000);
    expect(events().some((e) => e.type === 'approval_decided')).toBe(false);
    clock.run(1500);
    const decided = events().filter((e) => e.type === 'approval_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({ approval_id: approvalId, decision: 'approve', auto: true });
    expect(source.control.autoApproveDue(approvalId)).toBeNull();
  });

  it('자동 승인을 끄면 null이고 대기가 이어지며, 다시 켜면 그때부터 20초', () => {
    const { source, clock, approvalId, events } = untilRequested();
    clock.run(10_000);
    source.control.setAutoApprove(false);
    expect(source.control.getAutoApprove()).toBe(false);
    expect(source.control.autoApproveDue(approvalId)).toBeNull();
    clock.run(120_000);
    expect(events().some((e) => e.type === 'approval_decided')).toBe(false);
    source.control.setAutoApprove(true);
    const d = source.control.autoApproveDue(approvalId)!;
    expect(d).toBeGreaterThan(19_000);
    expect(d).toBeLessThanOrEqual(20_000);
    clock.run(20_500);
    expect(events().filter((e) => e.type === 'approval_decided')).toHaveLength(1);
  });

  it('처음부터 자동 승인을 끄면 남은 시간이 없다', () => {
    const { source, approvalId } = untilRequested({ autoApprove: false });
    expect(source.control.getAutoApprove()).toBe(false);
    expect(source.control.autoApproveDue(approvalId)).toBeNull();
  });

  it('실제 시나리오(모닝 브리핑)도 같다', () => {
    const { source, approvalId } = untilRequested({ scenario: 'morning-briefing' }, realLibrary);
    const d = source.control.autoApproveDue(approvalId)!;
    expect(d).toBeGreaterThan(19_000);
    expect(d).toBeLessThanOrEqual(20_000);
  });
});

describe('decide(직접 승인·반려)', () => {
  function pending(over: Partial<SimulatorOptions> = {}) {
    const sim = build({ scenario: 'ask-plan', ...over });
    sim.source.start();
    let request: PbEvent | undefined;
    for (let i = 0; i < 400 && !request; i += 1) {
      sim.clock.run(250);
      request = sim.events().find((e) => e.type === 'approval_requested');
    }
    return { ...sim, approvalId: (request!.payload as { approval_id: string }).approval_id };
  }

  it('대기 중인 승인을 즉시 결정한다(auto false). 자동 승인 예약은 취소된다', () => {
    const { source, clock, batches, events, approvalId } = pending();
    const before = batches.length;
    source.decide(approvalId, 'approve');
    expect(batches.length).toBe(before + 1);
    const decided = batches.at(-1)!.at(-1)!;
    expect(decided).toMatchObject({ type: 'approval_decided', staff_id: 'ceo', executor: 'human', message: '대표 승인(시뮬레이션)', payload: { approval_id: approvalId, decision: 'approve', auto: false } });
    expect(source.control.autoApproveDue(approvalId)).toBeNull();
    clock.run(60_000);
    expect(events().filter((e) => e.type === 'approval_decided' && (e.payload as { approval_id: string }).approval_id === approvalId)).toHaveLength(1);
  });

  it('반려도 된다', () => {
    const { source, events, approvalId } = pending({ autoApprove: false });
    source.decide(approvalId, 'reject');
    const decided = events().find((e) => e.type === 'approval_decided')!;
    expect(decided).toMatchObject({ message: '대표 반려(시뮬레이션)', payload: { decision: 'reject', auto: false } });
  });

  it('대기 중이 아닌 번호·이미 결정한 번호·시작 전에는 아무 일도 없다', () => {
    const { source, batches, approvalId } = pending();
    const n = batches.length;
    source.decide('없는:번호', 'approve');
    expect(batches.length).toBe(n);
    source.decide(approvalId, 'approve');
    const m = batches.length;
    source.decide(approvalId, 'reject');
    expect(batches.length).toBe(m);
    const fresh = build({ scenario: 'ask-plan' });
    fresh.source.decide('ask#1/a:A1', 'approve');
    expect(fresh.batches).toEqual([]);
  });
});

describe('시나리오 바꾸기', () => {
  it('onReset 구독자에게 모두 알리고, 해지한 구독자에게는 알리지 않는다', () => {
    const { source } = build();
    let a = 0;
    let b = 0;
    source.onReset(() => { a += 1; });
    const offB = source.onReset(() => { b += 1; });
    source.control.setScenario('flat');
    expect([a, b]).toEqual([1, 1]);
    offB();
    source.control.setScenario('burst-plan');
    expect([a, b]).toEqual([2, 1]);
  });

  it('처음부터 다시 재생하고 시계도 처음으로 돌아간다. 이전 시나리오의 대기 이벤트는 버린다', () => {
    const { source, clock, events, resets } = build({ scenario: 'ask-plan' });
    source.start();
    clock.run(8000);
    const old = events().length;
    expect(old).toBeGreaterThan(0);
    source.control.setScenario('flat');
    expect(resets).toHaveLength(1);
    expect(source.control.getScenario()).toBe('flat');
    expect(source.control.clock()).toBe(`${DATE}T09:00:00+09:00`);
    clock.run(100_000);
    expect(events().length).toBe(old);                                   // flat은 한가한 구간뿐이라 새 이벤트가 없다
    expect(source.control.isPlaying()).toBe(true);
  });

  it('마지막 이벤트 시각도 처음부터 다시 센다(옛 시나리오의 더 늦은 시각을 남기지 않는다)', () => {
    const { source, clock, events, statuses } = build({ scenario: 'ask-plan' });
    source.start();
    clock.run(8000);
    const oldLast = source.getStatus().lastEventTs;
    expect(oldLast).not.toBeNull();
    source.control.setScenario('burst-plan');
    expect(source.getStatus().lastEventTs).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ lastEventTs: null });
    const before = events().length;
    clock.run(300);
    const fresh = events().slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(source.getStatus().lastEventTs).toBe(fresh.at(-1)!.ts);
    expect(source.getStatus().lastEventTs! < oldLast!).toBe(true);
  });

  it('없는 시나리오 id는 하루 압축 재생으로 되돌린다', () => {
    const { source } = build({}, realLibrary);
    source.control.setScenario('절대-없는-id');
    expect(source.control.getScenario()).toBe('day');
    expect(source.warnings.some((w) => w.includes('절대-없는-id'))).toBe(true);
  });
});
