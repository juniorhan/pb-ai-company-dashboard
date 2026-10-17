import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import type { IdleConfig, Org, OrgStaff } from '../types';
import { DEFAULT_IDLE } from './load';
import { IdleActivity, nextSpawnDelay } from './idle';
import { createRng } from './rng';

const org = parseOrg(bundledOrg);
const index = indexOrg(org);
const none = (): boolean => false;

const config = (over: Partial<IdleConfig> = {}): IdleConfig => ({ ...DEFAULT_IDLE, ...over });
const onlyThis = (id: string) => (other: string): boolean => other !== id;

const withChecker = org.staff.find((s) => s.status !== 'paused' && s.checker_staff.some((c) => index.staff.has(c)))!;
const withDuties = org.staff.find((s) => s.status !== 'paused' && s.duties.length > 0)!;

/** 직원 한 명의 항목을 바꾼 조직 색인 */
function indexWith(id: string, patch: Partial<OrgStaff>): ReturnType<typeof indexOrg> {
  const copy: Org = structuredClone(org);
  const s = copy.staff.find((x) => x.id === id)!;
  Object.assign(s, patch);
  return indexOrg(copy);
}

describe('nextSpawnDelay', () => {
  it('빈도가 0 이하면 null', () => {
    const rng = createRng(1);
    expect(nextSpawnDelay(config({ rate_per_min: 0 }), 1, rng)).toBeNull();
    expect(nextSpawnDelay(config({ rate_per_min: 6 }), 0, rng)).toBeNull();
    expect(nextSpawnDelay(config({ rate_per_min: 6 }), -1, rng)).toBeNull();
  });

  it('평균 간격은 60 ÷ 분당 작업 수 ÷ 배율 (지수 분포)', () => {
    const mean = (rate: number, factor: number): number => {
      const rng = createRng(77);
      let sum = 0;
      let min = Number.POSITIVE_INFINITY;
      const N = 20000;
      const cfg = config({ rate_per_min: rate });
      for (let i = 0; i < N; i += 1) {
        const d = nextSpawnDelay(cfg, factor, rng)!;
        sum += d;                                                       // 유한하지 않은 값이 하나라도 있으면 합이 유한하지 않다
        if (d < min) min = d;
      }
      expect(Number.isFinite(sum)).toBe(true);
      expect(min).toBeGreaterThanOrEqual(0);
      return sum / N;
    };
    expect(mean(6, 1)).toBeGreaterThan(9.2);
    expect(mean(6, 1)).toBeLessThan(10.8);
    expect(mean(6, 0.5)).toBeGreaterThan(18.4);                         // 시나리오가 도는 동안은 빈도 절반 → 간격 2배
    expect(mean(6, 0.5)).toBeLessThan(21.6);
    expect(mean(30, 1)).toBeGreaterThan(1.8);
    expect(mean(30, 1)).toBeLessThan(2.2);
  });
});

describe('spawn', () => {
  it('조직 직원 한 명의 새 작업: 생성 이벤트와 일정(시작 → 완료)', () => {
    const idle = new IdleActivity(index, config({ review_chance: 0 }), createRng(5));
    const out = idle.spawn(none)!;
    expect(out.drafts).toHaveLength(1);
    const d = out.drafts[0]!;
    const worker = index.staff.get(d.staff_id)!;
    expect(worker).toBeDefined();
    expect(d.type).toBe('task_created');
    expect(d.task_id).toBe('idle#1');
    expect(d.message).toBe(`작업 생성: ${(d.payload as { title: string }).title}`);
    const payload = d.payload as { title: string; duty?: string; manual_minutes: number };
    if (worker.duties.length) {
      expect(worker.duties.some((x) => x.id === payload.duty && x.title === payload.title)).toBe(true);
    } else {
      expect(payload.title).toBe('정기 점검');
      expect(payload.duty).toBeUndefined();
    }
    expect(Number.isInteger(payload.manual_minutes)).toBe(true);
    expect(payload.manual_minutes).toBeGreaterThanOrEqual(5);
    expect(payload.manual_minutes).toBeLessThanOrEqual(25);
    const nonHuman = worker.executors.filter((e) => e !== 'human');
    expect(nonHuman.length ? nonHuman : ['claude']).toContain(d.executor);

    expect(out.schedule.map((s) => s.step)).toEqual(['start', 'complete']);
    const duration = out.schedule[1]!.at;
    expect(duration).toBeGreaterThanOrEqual(8);
    expect(duration).toBeLessThanOrEqual(20);
    expect(out.schedule[0]!.at).toBeCloseTo(duration * 0.15, 10);
    expect(out.schedule.every((s) => s.taskId === 'idle#1')).toBe(true);
  });

  it('작업 id는 idle#1, idle#2 … 로 이어진다', () => {
    const idle = new IdleActivity(index, config(), createRng(6));
    const ids = Array.from({ length: 5 }, () => idle.spawn(none)!.drafts[0]!.task_id);
    expect(ids).toEqual(['idle#1', 'idle#2', 'idle#3', 'idle#4', 'idle#5']);
    expect(idle.active).toBe(5);
  });

  it('review_chance가 1이면 일정에 검토가 끼고, 0이면 끼지 않는다', () => {
    const always = new IdleActivity(index, config({ review_chance: 1 }), createRng(7)).spawn(none)!;
    expect(always.schedule.map((s) => s.step)).toEqual(['start', 'review', 'complete']);
    expect(always.schedule[1]!.at).toBeCloseTo(always.schedule[2]!.at * 0.6, 10);
    const never = new IdleActivity(index, config({ review_chance: 0 }), createRng(7)).spawn(none)!;
    expect(never.schedule.map((s) => s.step)).toEqual(['start', 'complete']);
  });

  it('운영 상태 가중치대로 고른다(가중치 0인 상태는 안 뽑힌다)', () => {
    const idle = new IdleActivity(index, config({ weights: { active: 0, building: 5, planned: 0, paused: 0 } }), createRng(8));
    for (let i = 0; i < 80; i += 1) {
      const d = idle.spawn(none)!.drafts[0]!;
      expect(index.staff.get(d.staff_id)!.status).toBe('building');
    }
    const empty = new IdleActivity(index, config({ weights: { active: 0, building: 0, planned: 0, paused: 0 } }), createRng(8));
    expect(empty.spawn(none)).toBeNull();
  });

  it('기본 가중치(3/2/1/0)에서 운영 중 직원이 더 자주, 일시 중지는 한 번도 안 뽑힌다', () => {
    const idle = new IdleActivity(index, config(), createRng(9));
    const counts: Record<string, number> = { active: 0, building: 0, planned: 0, paused: 0 };
    for (let i = 0; i < 1500; i += 1) counts[index.staff.get(idle.spawn(none)!.drafts[0]!.staff_id)!.status]! += 1;
    expect(counts.paused).toBe(0);
    expect(counts.active!).toBeGreaterThan(counts.planned!);
  });

  it('바쁜 직원은 고르지 않고, 모두 바쁘면 null', () => {
    const idle = new IdleActivity(index, config(), createRng(10));
    for (let i = 0; i < 30; i += 1) expect(idle.spawn(onlyThis(withDuties.id))!.drafts[0]!.staff_id).toBe(withDuties.id);
    expect(idle.spawn(() => true)).toBeNull();
  });

  it('대표·AI 총괄은 고르지 않는다(조직 직원만)', () => {
    const idle = new IdleActivity(index, config(), createRng(11));
    for (let i = 0; i < 300; i += 1) {
      const id = idle.spawn(none)!.drafts[0]!.staff_id;
      expect(index.staff.has(id)).toBe(true);
    }
  });

  it('담당 업무가 없으면 `정기 점검`, 업무 id는 넣지 않는다', () => {
    const idx = indexWith(withDuties.id, { duties: [] });
    const idle = new IdleActivity(idx, config(), createRng(12));
    const d = idle.spawn(onlyThis(withDuties.id))!.drafts[0]!;
    expect(d.payload).toMatchObject({ title: '정기 점검' });
    expect(Object.keys(d.payload!)).not.toContain('duty');
    expect(d.message).toBe('작업 생성: 정기 점검');
  });

  it('실행 주체: human은 뺀 것 중에서, 없으면 claude', () => {
    const humanOnly = new IdleActivity(indexWith(withDuties.id, { executors: ['human'] }), config(), createRng(13));
    expect(humanOnly.spawn(onlyThis(withDuties.id))!.drafts[0]!.executor).toBe('claude');
    const none0 = new IdleActivity(indexWith(withDuties.id, { executors: [] }), config(), createRng(13));
    expect(none0.spawn(onlyThis(withDuties.id))!.drafts[0]!.executor).toBe('claude');
    const mixed = new IdleActivity(indexWith(withDuties.id, { executors: ['human', 'codex'] }), config(), createRng(13));
    for (let i = 0; i < 20; i += 1) expect(mixed.spawn(onlyThis(withDuties.id))!.drafts[0]!.executor).toBe('codex');
  });

  it('같은 시드면 같은 작업 열', () => {
    const run = (): unknown => {
      const idle = new IdleActivity(index, config(), createRng(2026));
      return Array.from({ length: 25 }, () => idle.spawn(none));
    };
    expect(run()).toEqual(run());
  });
});

describe('fire · finishHolder', () => {
  const start = (idx = index, cfg = config({ review_chance: 1 })): { idle: IdleActivity; id: string; worker: OrgStaff } => {
    const idle = new IdleActivity(idx, cfg, createRng(21));
    const d = idle.spawn(onlyThis(withChecker.id))!.drafts[0]!;
    return { idle, id: d.task_id!, worker: idx.staff.get(withChecker.id)! };
  };

  it('start: 본인이 작업 시작', () => {
    const { idle, id, worker } = start();
    const [d] = idle.fire(id, 'start', none);
    expect(d).toMatchObject({ type: 'task_started', staff_id: worker.id, task_id: id, message: '작업 시작' });
  });

  it('review: 검증자 중 바쁘지 않은 첫 직원에게 검토 요청, 검토자가 완료', () => {
    const { idle, id, worker } = start();
    const reviewerId = worker.checker_staff.find((c) => index.staff.has(c))!;
    expect(idle.isHolder(worker.id)).toBe(true);
    const [r] = idle.fire(id, 'review', none);
    const reviewer = index.staff.get(reviewerId)!;
    const expectedExecutor = reviewer.executors.filter((e) => e !== 'human')[0] ?? 'codex';
    expect(r).toMatchObject({
      type: 'task_review_requested', staff_id: worker.id, executor: expectedExecutor, task_id: id,
      message: `${index.actorName(reviewerId)}에게 검토 요청`, payload: { reviewer: reviewerId },
    });
    expect(idle.isHolder(worker.id)).toBe(false);
    expect(idle.isHolder(reviewerId)).toBe(true);
    const [c] = idle.fire(id, 'complete', none);
    expect(c).toMatchObject({ type: 'task_completed', staff_id: reviewerId, executor: expectedExecutor, task_id: id, message: '완료' });
    expect(idle.active).toBe(0);
  });

  it('검토자가 모두 바쁘면 검토를 건너뛰고 본인이 완료', () => {
    const { idle, id, worker } = start();
    const checkers = new Set(worker.checker_staff);
    expect(idle.fire(id, 'review', (who) => checkers.has(who))).toEqual([]);
    expect(idle.isHolder(worker.id)).toBe(true);
    const [c] = idle.fire(id, 'complete', none);
    expect(c).toMatchObject({ staff_id: worker.id, message: '완료' });
  });

  it('검증자가 없거나 조직에 없으면 검토 없이 본인이 완료', () => {
    const idx = indexWith(withChecker.id, { checker_staff: ['zzz-99-e99'] });
    const { idle, id, worker } = start(idx);
    expect(idle.fire(id, 'review', none)).toEqual([]);
    expect(idle.fire(id, 'complete', none)[0]).toMatchObject({ staff_id: worker.id });
  });

  it('검토를 잡지 않은 작업(review_chance 0)에 review가 와도 아무 일 없다', () => {
    const { idle, id } = start(index, config({ review_chance: 0 }));
    expect(idle.fire(id, 'review', none)).toEqual([]);
  });

  it('끝났거나 모르는 작업은 아무것도 내지 않는다', () => {
    const { idle, id } = start();
    idle.fire(id, 'complete', none);
    expect(idle.fire(id, 'complete', none)).toEqual([]);
    expect(idle.fire(id, 'start', none)).toEqual([]);
    expect(idle.fire('idle#999', 'start', none)).toEqual([]);
  });

  it('finishHolder: 그 직원이 쥔 작업을 곧바로 끝내고(다른 작업으로 전환), 이후 예정된 단계는 무시된다', () => {
    const { idle, id, worker } = start();
    expect(idle.finishHolder('zzz')).toEqual([]);
    const [d] = idle.finishHolder(worker.id);
    expect(d).toMatchObject({ type: 'task_completed', staff_id: worker.id, task_id: id, message: '다른 작업으로 전환' });
    expect(idle.isHolder(worker.id)).toBe(false);
    expect(idle.fire(id, 'start', none)).toEqual([]);
    expect(idle.fire(id, 'review', none)).toEqual([]);
    expect(idle.fire(id, 'complete', none)).toEqual([]);
    expect(idle.finishHolder(worker.id)).toEqual([]);
  });

  it('finishHolder: 검토 중이면 검토자가 쥔 작업을 끝낸다', () => {
    const { idle, id, worker } = start();
    const reviewerId = worker.checker_staff.find((c) => index.staff.has(c))!;
    idle.fire(id, 'review', none);
    expect(idle.finishHolder(worker.id)).toEqual([]);                  // 이미 넘겼으니 원래 담당자는 쥐고 있지 않다
    const [d] = idle.finishHolder(reviewerId);
    expect(d).toMatchObject({ staff_id: reviewerId, task_id: id, message: '다른 작업으로 전환' });
  });
});
