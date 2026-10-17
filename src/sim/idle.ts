// 한가한 활동(docs/DESIGN.md §5): 큰 흐름이 없을 때도 직원들이 담당 업무를 조금씩 처리하는 모습.
// 시드 난수로 직원을 운영 상태 가중치에 따라 고르고, 담당 업무 제목으로 '생성 → 시작 → (확률적으로 검증자에게 검토) → 완료'를 돈다.
// 시간은 1배속 실제 초(τ)로 센다. 시각·이벤트 id는 엔진이 붙인다.
import type { Executor, IdleConfig, OrgIndex, OrgStaff } from '../types';
import type { EventDraft } from './compile';
import type { Rng } from './rng';

export type IdleStepKind = 'start' | 'review' | 'complete';
export interface IdleScheduleItem { taskId: string; step: IdleStepKind; at: number }   // at: 작업을 만든 뒤 τ초

interface IdleTask {
  id: string;
  worker: string;
  holder: string;             // 지금 그 작업을 쥔 직원(검토 중이면 검토자)
  executor: Executor;         // 지금 그 작업을 수행하는 주체
  withReview: boolean;
}

const nonHuman = (list: readonly Executor[]): Executor[] => list.filter((x) => x !== 'human');

/** 다음 새 작업까지 걸리는 τ초(지수 분포). 분당 작업 수 × factor가 0 이하이면 null */
export function nextSpawnDelay(config: IdleConfig, factor: number, rng: Rng): number | null {
  const lambda = (config.rate_per_min / 60) * factor;
  if (!(lambda > 0)) return null;
  return -Math.log(1 - rng.next()) / lambda;
}

export class IdleActivity {
  private readonly index: OrgIndex;
  private readonly config: IdleConfig;
  private readonly rng: Rng;
  private readonly staff: readonly OrgStaff[];
  private readonly tasks = new Map<string, IdleTask>();
  private n = 0;

  constructor(index: OrgIndex, config: IdleConfig, rng: Rng) {
    this.index = index;
    this.config = config;
    this.rng = rng;
    this.staff = index.org.staff;            // 조직 직원만(확장 대기 직책·대표·AI 총괄 제외)
  }

  /** 한가한 작업을 쥔 직원이 있는가 */
  isHolder(staffId: string): boolean {
    for (const t of this.tasks.values()) if (t.holder === staffId) return true;
    return false;
  }

  /** 진행 중인 한가한 작업 수 */
  get active(): number {
    return this.tasks.size;
  }

  /**
   * 새 작업 1건을 만든다. 쉬는(busy가 아닌) 직원이 없으면 null.
   * 난수는 항상 같은 순서로 쓴다: 직원 → 업무 → 실행 주체 → 기준 분 → 길이 → 검토 여부.
   */
  spawn(isBusy: (id: string) => boolean): { drafts: EventDraft[]; schedule: IdleScheduleItem[] } | null {
    const w = this.config.weights;
    const candidates = this.staff.filter((s) => !isBusy(s.id));
    const worker = this.rng.weighted(candidates, (s) => w[s.status] ?? 0);
    if (!worker) return null;
    const duty = this.rng.pick(worker.duties);
    const executor: Executor = this.rng.pick(nonHuman(worker.executors)) ?? 'claude';
    const manual = this.rng.int(this.config.manual_minutes[0], this.config.manual_minutes[1]);
    const duration = this.rng.int(this.config.duration_seconds[0], this.config.duration_seconds[1]);
    const withReview = this.rng.chance(this.config.review_chance);

    this.n += 1;
    const id = `idle#${this.n}`;
    const title = duty?.title ?? '정기 점검';
    this.tasks.set(id, { id, worker: worker.id, holder: worker.id, executor, withReview });
    const payload: Record<string, unknown> = { title };
    if (duty) payload.duty = duty.id;
    payload.manual_minutes = manual;
    const schedule: IdleScheduleItem[] = [{ taskId: id, step: 'start', at: duration * 0.15 }];
    if (withReview) schedule.push({ taskId: id, step: 'review', at: duration * 0.6 });
    schedule.push({ taskId: id, step: 'complete', at: duration });
    return {
      drafts: [{ type: 'task_created', staff_id: worker.id, executor, task_id: id, message: `작업 생성: ${title}`, payload }],
      schedule,
    };
  }

  /** 예정된 단계를 실행한다. 이미 끝났거나 강제로 끝난 작업이면 아무것도 내지 않는다. */
  fire(taskId: string, step: IdleStepKind, isBusy: (id: string) => boolean): EventDraft[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    if (step === 'start') {
      return [{ type: 'task_started', staff_id: t.worker, executor: t.executor, task_id: t.id, message: '작업 시작' }];
    }
    if (step === 'review') {
      if (!t.withReview || t.holder !== t.worker) return [];
      const me = this.index.staff.get(t.worker);
      const reviewerId = me?.checker_staff.find((id) => this.index.staff.has(id) && !isBusy(id));
      if (!reviewerId) return [];            // 검토자가 모두 바쁘면 본인이 끝낸다
      const reviewer = this.index.staff.get(reviewerId)!;
      const executor: Executor = nonHuman(reviewer.executors)[0] ?? 'codex';
      t.holder = reviewerId;
      t.executor = executor;
      return [{
        type: 'task_review_requested', staff_id: t.worker, executor, task_id: t.id,
        message: `${this.index.actorName(reviewerId)}에게 검토 요청`, payload: { reviewer: reviewerId },
      }];
    }
    this.tasks.delete(t.id);
    return [{ type: 'task_completed', staff_id: t.holder, executor: t.executor, task_id: t.id, message: '완료' }];
  }

  /** 그 직원이 쥔 한가한 작업을 곧바로 끝낸다(시나리오가 그 직원을 써야 할 때). 없으면 빈 목록 */
  finishHolder(staffId: string): EventDraft[] {
    for (const t of this.tasks.values()) {
      if (t.holder !== staffId) continue;
      this.tasks.delete(t.id);
      return [{ type: 'task_completed', staff_id: t.holder, executor: t.executor, task_id: t.id, message: '다른 작업으로 전환' }];
    }
    return [];
  }
}
