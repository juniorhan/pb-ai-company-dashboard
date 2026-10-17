import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { parseEvent } from '../data/schema';
import { CEO_ID, STAFF_STATUS_LABEL } from '../types';
import type { Scenario, ScenarioStep } from '../types';
import { ScenarioRun, collectActorRefs, scenarioRealSeconds } from './compile';
import type { EventDraft } from './compile';

const index = indexOrg(parseOrg(bundledOrg));
const [S1, S2, S3] = index.org.staff.slice(0, 3).map((s) => s.id) as [string, string, string];
const name = (id: string): string => index.actorName(id);

const scenario = (steps: ScenarioStep[], id = 'demo'): Scenario => ({ id, title: '시험', description: '', start: '09:00', virtual_minutes: 30, steps });
const newRun = (steps: ScenarioStep[], runNo = 1, warn: (m: string) => void = () => undefined): ScenarioRun => new ScenarioRun(scenario(steps), runNo, index, 0, warn);

/** 끝까지 돌려 낸 초안 목록. 승인 대기가 오면 decision으로 결정한다. */
function drive(run: ScenarioRun, decision: 'approve' | 'reject' = 'approve', auto = true): { drafts: EventDraft[]; taus: number[] } {
  const drafts: EventDraft[] = [];
  const taus: number[] = [];
  let tau = 0;
  for (let i = 0; i < 500 && !run.isDone(); i += 1) {
    if (run.pendingApprovalId()) {
      tau += 20;
      drafts.push(run.decide(decision, auto, tau)!);
      taus.push(tau);
      continue;
    }
    tau = run.nextDue()!;
    drafts.push(run.take(tau)!);
    taus.push(tau);
  }
  return { drafts, taus };
}

const create = (task: string, over: Partial<Extract<ScenarioStep, { do: 'create' }>> = {}): ScenarioStep =>
  ({ after: 0, do: 'create', task, title: `제목 ${task}`, actor: S1, executor: 'claude', ...over });

describe('식별자', () => {
  it('작업 id는 `시나리오id#회차/로컬id`', () => {
    const run = newRun([create('a')], 3);
    expect(run.taskId('a')).toBe('demo#3/a');
    expect(run.take(0)!.task_id).toBe('demo#3/a');
  });

  it('승인 id는 `작업 id:A<n>` — 작업별 1부터', () => {
    const approval = (task: string): ScenarioStep => ({ after: 1, do: 'approval', task, summary: '요약', on_approve: [], on_reject: [] });
    const run = newRun([create('a'), create('b'), approval('a'), approval('b'), approval('a')]);
    const { drafts } = drive(run);
    const ids = drafts.filter((d) => d.type === 'approval_requested').map((d) => (d.payload as { approval_id: string }).approval_id);
    expect(ids).toEqual(['demo#1/a:A1', 'demo#1/b:A1', 'demo#1/a:A2']);
    const decided = drafts.filter((d) => d.type === 'approval_decided').map((d) => (d.payload as { approval_id: string }).approval_id);
    expect(decided).toEqual(ids);
  });
});

describe('기본 문구와 payload', () => {
  const full: ScenarioStep[] = [
    create('a', { actor: S1, title: '모닝 브리핑 원고', parent: undefined, duty: 'com-01-T05', manual_minutes: 45 }),
    create('b', { actor: S2, parent: 'a', executor: 'aside' }),
    { after: 1, do: 'start', task: 'a' },
    { after: 1, do: 'handoff', task: 'a', to: S2, executor: 'codex' },
    { after: 1, do: 'review', task: 'a', reviewer: S3, executor: 'script' },
    { after: 1, do: 'block', task: 'a', reason: '검사 대기' },
    { after: 1, do: 'complete', task: 'a' },
    { after: 1, do: 'complete', task: 'b', outcome: 'rejected', human_minutes: 3 },
    { after: 1, do: 'status', actor: S1, status: 'offline' },
    { after: 1, do: 'approval', task: 'b', summary: '게시 승인 요청', on_approve: [], on_reject: [] },
  ];
  const { drafts } = drive(newRun(full));

  it('create: 제목이 든 기본 문구, payload는 있는 칸만(부모는 전체 작업 id로)', () => {
    expect(drafts[0]).toEqual({
      type: 'task_created', staff_id: S1, executor: 'claude', task_id: 'demo#1/a', message: '작업 생성: 모닝 브리핑 원고',
      payload: { title: '모닝 브리핑 원고', duty: 'com-01-T05', manual_minutes: 45 },
    });
    expect(drafts[1]!.payload).toEqual({ title: '제목 b', parent_task_id: 'demo#1/a' });
    expect(Object.keys(drafts[1]!.payload!)).not.toContain('duty');
  });

  it('start·handoff·review·block·complete·status·approval 기본 문구', () => {
    expect(drafts[2]).toMatchObject({ type: 'task_started', message: '작업 시작' });
    expect(drafts[2]!.payload).toBeUndefined();
    expect(drafts[3]).toMatchObject({ type: 'task_handoff', staff_id: S1, executor: 'codex', message: `${name(S2)}에게 전달`, payload: { to: S2, kind: 'work' } });
    expect(drafts[4]).toMatchObject({ type: 'task_review_requested', staff_id: S2, executor: 'script', message: `${name(S3)}에게 검토 요청`, payload: { reviewer: S3 } });
    expect(drafts[5]).toMatchObject({ type: 'task_blocked', staff_id: S3, message: '검사 대기', payload: { reason: '검사 대기' } });
    expect(drafts[6]).toMatchObject({ type: 'task_completed', staff_id: S3, message: '완료' });
    expect(drafts[6]!.payload).toBeUndefined();
    expect(drafts[7]).toMatchObject({ type: 'task_completed', staff_id: S2, message: '반려로 종료', payload: { outcome: 'rejected', human_minutes: 3 } });
    expect(drafts[8]).toEqual({
      type: 'staff_status_changed', staff_id: S1, executor: 'script', task_id: null, message: STAFF_STATUS_LABEL.offline, payload: { status: 'offline' },
    });
    expect(drafts[9]).toMatchObject({ type: 'approval_requested', message: '게시 승인 요청', payload: { approval_id: 'demo#1/b:A1', summary: '게시 승인 요청' } });
  });

  it('message를 주면 그대로 쓴다(빈 문자열도)', () => {
    const run = newRun([create('a', { message: '직접 쓴 문구' }), { after: 0, do: 'start', task: 'a', message: '' }]);
    expect(run.take(0)!.message).toBe('직접 쓴 문구');
    expect(run.take(0)!.message).toBe('');
  });

  it('complete는 outcome·human_minutes 중 있는 것만 payload에 넣는다', () => {
    const run = newRun([create('a'), create('b'), create('c'), { after: 0, do: 'complete', task: 'a', outcome: 'done' }, { after: 0, do: 'complete', task: 'b', human_minutes: 0 }, { after: 0, do: 'complete', task: 'c' }]);
    const out = drive(run).drafts.slice(3);
    expect(out[0]!.payload).toEqual({ outcome: 'done' });
    expect(out[1]!.payload).toEqual({ human_minutes: 0 });
    expect(out[2]!.payload).toBeUndefined();
  });

  it('모든 초안이 이벤트 스키마를 통과한다(id·ts를 붙이면)', () => {
    for (const [i, d] of drafts.entries()) {
      const r = parseEvent({ ...d, event_id: `x-${i}`, ts: '2026-10-17T09:00:00+09:00' });
      expect(r.ok, `${i}: ${JSON.stringify(d)} ${r.ok ? '' : r.error}`).toBe(true);
    }
  });
});

describe('생략 규칙(현재 담당자·실행 주체는 실행기가 직접 추적)', () => {
  it('start·block·complete·approval의 actor·executor를 비우면 작업의 현재 담당자·실행 주체', () => {
    const run = newRun([
      create('a', { actor: S1, executor: 'aside' }),
      { after: 0, do: 'start', task: 'a' },
      { after: 0, do: 'block', task: 'a', reason: 'r' },
      { after: 0, do: 'approval', task: 'a', summary: 's', on_approve: [], on_reject: [] },
    ]);
    const { drafts } = drive(run);
    for (const d of drafts.slice(1, 4)) expect(d).toMatchObject({ staff_id: S1, executor: 'aside' });
  });

  it('전달 뒤에는 받은 쪽이 담당자, 전달에 쓴 실행 주체가 작업의 실행 주체', () => {
    const run = newRun([
      create('a', { actor: S1, executor: 'aside' }),
      { after: 0, do: 'handoff', task: 'a', to: S2, executor: 'codex' },
      { after: 0, do: 'start', task: 'a' },
      { after: 0, do: 'complete', task: 'a' },
    ]);
    const { drafts } = drive(run);
    expect(drafts[1]).toMatchObject({ staff_id: S1, executor: 'codex' });
    expect(drafts[2]).toMatchObject({ type: 'task_started', staff_id: S2, executor: 'codex' });
    expect(drafts[3]).toMatchObject({ type: 'task_completed', staff_id: S2, executor: 'codex' });
  });

  it('검토 요청 뒤에는 검토자가 담당자', () => {
    const run = newRun([create('a', { actor: S1 }), { after: 0, do: 'review', task: 'a', reviewer: S2, executor: 'script' }, { after: 0, do: 'complete', task: 'a' }]);
    const { drafts } = drive(run);
    expect(drafts[1]).toMatchObject({ staff_id: S1, payload: { reviewer: S2 } });
    expect(drafts[2]).toMatchObject({ staff_id: S2, executor: 'script' });
  });

  it('start에 actor를 주면 그 사람이 새 담당자가 되고, executor를 주면 실행 주체가 바뀐다', () => {
    const run = newRun([create('a', { actor: S1, executor: 'claude' }), { after: 0, do: 'start', task: 'a', actor: S2, executor: 'codex' }, { after: 0, do: 'complete', task: 'a' }]);
    const { drafts } = drive(run);
    expect(drafts[1]).toMatchObject({ staff_id: S2, executor: 'codex' });
    expect(drafts[2]).toMatchObject({ staff_id: S2, executor: 'codex' });
  });

  it('handoff의 from·review의 actor를 주면 현재 담당자 대신 그 사람', () => {
    const run = newRun([
      create('a', { actor: S1 }),
      { after: 0, do: 'handoff', task: 'a', to: S3, executor: 'claude', from: S2 },
      { after: 0, do: 'review', task: 'a', reviewer: S1, executor: 'claude', actor: S2 },
    ]);
    const { drafts } = drive(run);
    expect(drafts[1]).toMatchObject({ staff_id: S2, payload: { to: S3 } });
    expect(drafts[2]).toMatchObject({ staff_id: S2 });
  });

  it('승인 요청·결정은 작업의 담당자·실행 주체를 바꾸지 않는다(리듀서와 같게)', () => {
    const run = newRun([
      create('a', { actor: S1, executor: 'aside' }),
      { after: 0, do: 'approval', task: 'a', summary: 's', executor: 'script', on_approve: [{ after: 0, do: 'complete', task: 'a' }], on_reject: [] },
    ]);
    const { drafts } = drive(run);
    expect(drafts[1]).toMatchObject({ type: 'approval_requested', staff_id: S1, executor: 'script' });
    expect(drafts[3]).toMatchObject({ type: 'task_completed', staff_id: S1, executor: 'aside' });
  });

  it('status 단계의 executor 기본값은 script, 줄 수도 있다', () => {
    const run = newRun([{ after: 0, do: 'status', actor: S1, status: 'idle' }, { after: 0, do: 'status', actor: S2, status: 'blocked', executor: 'human' }]);
    const { drafts } = drive(run);
    expect(drafts[0]).toMatchObject({ executor: 'script', task_id: null });
    expect(drafts[1]).toMatchObject({ executor: 'human', payload: { status: 'blocked' } });
  });
});

describe('승인 단계', () => {
  const steps: ScenarioStep[] = [
    create('a', { actor: S1 }),
    { after: 5, do: 'approval', task: 'a', summary: '요약', on_approve: [{ after: 2, do: 'start', task: 'a', message: '승인 뒤' }], on_reject: [{ after: 3, do: 'complete', task: 'a', outcome: 'rejected', message: '반려 뒤' }] },
    { after: 4, do: 'complete', task: 'a', message: '본 단계 마지막' },
  ];

  it('approval_requested를 내고 멈춘다: 다음 단계 시각·peek·take가 없다', () => {
    const run = newRun(steps);
    run.take(0);
    expect(run.pendingApprovalId()).toBeNull();
    const req = run.take(5)!;
    expect(req.type).toBe('approval_requested');
    expect(run.pendingApprovalId()).toBe('demo#1/a:A1');
    expect(run.nextDue()).toBeNull();
    expect(run.peek()).toBeNull();
    expect(run.take(99)).toBeNull();
    expect(run.isDone()).toBe(false);
  });

  it.each([
    ['approve', true, '시뮬레이션 자동 승인'],
    ['approve', false, '대표 승인(시뮬레이션)'],
    ['reject', false, '대표 반려(시뮬레이션)'],
  ] as const)('결정 %s(자동 %s): approval_decided(ceo·human), 문구 `%s`', (decision, auto, message) => {
    const run = newRun(steps);
    run.take(0);
    run.take(5);
    const d = run.decide(decision, auto, 25)!;
    expect(d).toEqual({
      type: 'approval_decided', staff_id: CEO_ID, executor: 'human', task_id: 'demo#1/a', message,
      payload: { approval_id: 'demo#1/a:A1', decision, auto },
    });
    expect(run.pendingApprovalId()).toBeNull();
  });

  it('승인하면 on_approve를 실행한 뒤 남은 본 단계로 간다(결정 시각부터 센다)', () => {
    const run = newRun(steps);
    run.take(0);
    run.take(5);
    run.decide('approve', true, 25);
    expect(run.nextDue()).toBe(27);                                    // 결정 25 + on_approve 첫 단계 after 2
    expect(run.take(27)!.message).toBe('승인 뒤');
    expect(run.nextDue()).toBe(31);                                    // 본 단계 마지막 after 4
    expect(run.take(31)!.message).toBe('본 단계 마지막');
    expect(run.isDone()).toBe(true);
  });

  it('반려하면 on_reject를 실행한 뒤 남은 본 단계로 간다', () => {
    const { drafts } = drive(newRun(steps), 'reject', false);
    expect(drafts.map((d) => d.message)).toEqual(['작업 생성: 제목 a', '요약', '대표 반려(시뮬레이션)', '반려 뒤', '본 단계 마지막']);
  });

  it('분기가 비어 있어도 본 단계가 이어진다', () => {
    const run = newRun([create('a'), { after: 1, do: 'approval', task: 'a', summary: 's', on_approve: [], on_reject: [] }, { after: 4, do: 'complete', task: 'a' }]);
    run.take(0);
    run.take(1);
    run.decide('approve', false, 30);
    expect(run.nextDue()).toBe(34);
  });

  it('승인 분기 안에 또 승인이 있으면 중첩해서 처리한다', () => {
    const inner: ScenarioStep = { after: 1, do: 'approval', task: 'a', summary: '두 번째', on_approve: [{ after: 1, do: 'complete', task: 'a', message: '안쪽 승인 뒤' }], on_reject: [] };
    const run = newRun([create('a'), { after: 1, do: 'approval', task: 'a', summary: '첫 번째', on_approve: [inner], on_reject: [] }, { after: 1, do: 'start', task: 'a', message: '끝' }]);
    const { drafts } = drive(run);
    expect(drafts.map((d) => d.message)).toEqual([
      '작업 생성: 제목 a', '첫 번째', '시뮬레이션 자동 승인', '두 번째', '시뮬레이션 자동 승인', '안쪽 승인 뒤', '끝',
    ]);
    expect(drafts.filter((d) => d.type === 'approval_requested').map((d) => (d.payload as { approval_id: string }).approval_id)).toEqual(['demo#1/a:A1', 'demo#1/a:A2']);
  });

  it('대기 중인 승인이 없으면 decide는 null', () => {
    const run = newRun(steps);
    expect(run.decide('approve', false, 1)).toBeNull();
    run.take(0);
    expect(run.decide('approve', false, 1)).toBeNull();
  });
});

describe('시간', () => {
  it('첫 단계는 시작 τ + after, 이어지는 단계는 앞 단계를 실행한 τ + after', () => {
    const run = new ScenarioRun(scenario([create('a', { after: 3 }), { after: 4, do: 'start', task: 'a' }, { after: 0, do: 'complete', task: 'a' }]), 1, index, 100);
    expect(run.nextDue()).toBe(103);
    run.take(103);
    expect(run.nextDue()).toBe(107);
    run.take(110);                                                      // 늦게 실행해도 그 시각부터 센다
    expect(run.nextDue()).toBe(110);
  });

  it('scenarioRealSeconds = 본 단계 + on_approve 단계(중첩 포함)의 after 합, on_reject는 세지 않는다', () => {
    const s = scenario([
      create('a', { after: 1 }),
      { after: 2, do: 'approval', task: 'a', summary: 's', on_reject: [{ after: 100, do: 'complete', task: 'a' }], on_approve: [
        { after: 4, do: 'start', task: 'a' },
        { after: 8, do: 'approval', task: 'a', summary: 't', on_approve: [{ after: 16, do: 'complete', task: 'a' }], on_reject: [{ after: 1000, do: 'complete', task: 'a' }] },
      ] },
      { after: 32, do: 'complete', task: 'a' },
    ]);
    expect(scenarioRealSeconds(s)).toBe(1 + 2 + 4 + 8 + 16 + 32);
  });
});

describe('collectActorRefs', () => {
  it('모든 행위자 지정(승인 분기 안 포함)을 모은다', () => {
    const refs = collectActorRefs([
      create('a', { actor: { duty: 'd1' } }),
      { after: 0, do: 'start', task: 'a', actor: 's-start' },
      { after: 0, do: 'start', task: 'a' },
      { after: 0, do: 'handoff', task: 'a', to: 'to1', executor: 'claude', from: 'from1' },
      { after: 0, do: 'review', task: 'a', reviewer: 'rev1', executor: 'claude', actor: 'rev-actor' },
      { after: 0, do: 'status', actor: 'st1', status: 'idle' },
      { after: 0, do: 'block', task: 'a', reason: 'r', actor: 'blk' },
      { after: 0, do: 'complete', task: 'a', actor: 'cmp' },
      { after: 0, do: 'approval', task: 'a', summary: 's', actor: 'apr', on_approve: [{ after: 0, do: 'handoff', task: 'a', to: 'in-ok', executor: 'claude' }], on_reject: [{ after: 0, do: 'status', actor: 'in-rej', status: 'idle' }] },
    ]);
    const key = (r: unknown): string => JSON.stringify(r);
    expect(refs.map(key).sort()).toEqual([{ duty: 'd1' }, 's-start', 'to1', 'from1', 'rev1', 'rev-actor', 'st1', 'blk', 'cmp', 'apr', 'in-ok', 'in-rej'].map(key).sort());
  });
});

describe('경고', () => {
  it('행위자를 못 찾으면 unassigned로 두고 같은 지정은 한 번만 경고한다', () => {
    const warnings: string[] = [];
    const run = newRun([
      create('a', { actor: { duty: 'NO-SUCH' } }),
      { after: 0, do: 'start', task: 'a' },
      { after: 0, do: 'handoff', task: 'a', to: { duty: 'NO-SUCH' }, executor: 'claude' },
      { after: 0, do: 'handoff', task: 'a', to: 'zzz-99-e99', executor: 'claude' },
      { after: 0, do: 'handoff', task: 'a', to: 'zzz-99-e99', executor: 'claude' },
    ], 1, (m) => warnings.push(m));
    const { drafts } = drive(run);
    expect(drafts[0]!.staff_id).toBe('unassigned:NO-SUCH');
    expect(drafts[3]).toMatchObject({ payload: { to: 'unassigned:zzz-99-e99' } });
    expect(warnings).toEqual(['행위자를 찾지 못함: {"duty":"NO-SUCH"}', '행위자를 찾지 못함: zzz-99-e99']);
  });

  it('만들지 않은 작업을 쓰면 경고하고(작업당 한 번) 미배정 담당자로 이어 간다', () => {
    const warnings: string[] = [];
    const run = newRun([{ after: 0, do: 'start', task: 'ghost' }, { after: 0, do: 'complete', task: 'ghost' }], 1, (m) => warnings.push(m));
    const { drafts } = drive(run);
    expect(warnings).toEqual(['만들지 않은 작업을 쓰는 단계: demo/ghost']);
    expect(drafts[0]).toMatchObject({ staff_id: 'unassigned:ghost', executor: 'script' });
  });
});

describe('busyActors·peek', () => {
  it('끝나지 않은 작업의 담당자, status로 대기가 아니게 둔 행위자가 바쁘다', () => {
    const run = newRun([
      create('a', { actor: S1 }),
      { after: 0, do: 'handoff', task: 'a', to: S2, executor: 'claude' },
      { after: 0, do: 'status', actor: S3, status: 'offline' },
      { after: 0, do: 'approval', task: 'a', summary: 's', on_approve: [{ after: 0, do: 'status', actor: S3, status: 'idle' }], on_reject: [] },
      { after: 0, do: 'complete', task: 'a' },
    ]);
    expect([...run.busyActors()]).toEqual([]);
    run.take(0);
    expect([...run.busyActors()].sort()).toEqual([S1]);
    run.take(0);
    expect([...run.busyActors()].sort()).toEqual([S2]);                 // 넘긴 사람은 풀린다
    run.take(0);
    expect([...run.busyActors()].sort()).toEqual([S2, S3].sort());      // offline으로 둔 사람도 바쁘다
    run.take(0);
    expect(run.pendingApprovalId()).not.toBeNull();
    expect(run.busyActors().has(S2)).toBe(true);                        // 승인을 기다리는 동안에도 담당자는 바쁘다
    run.decide('approve', true, 1);
    run.take(1);                                                        // status idle
    expect([...run.busyActors()]).toEqual([S2]);
    run.take(1);
    expect([...run.busyActors()]).toEqual([]);
  });

  it('peek는 상태를 바꾸지 않고, 이어서 take하면 같은 초안이 나온다', () => {
    const run = newRun([create('a', { actor: S1 }), { after: 3, do: 'handoff', task: 'a', to: S2, executor: 'codex' }]);
    run.take(0);
    const a = run.peek()!;
    const b = run.peek()!;
    expect(a.draft).toEqual(b.draft);
    expect(a.actors).toEqual([S1, S2]);
    expect([...run.busyActors()]).toEqual([S1]);
    expect(run.take(3)).toEqual(a.draft);
    expect([...run.busyActors()]).toEqual([S2]);
  });
});
