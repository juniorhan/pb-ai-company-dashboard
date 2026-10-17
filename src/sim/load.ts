// 시나리오 파일(src/scenarios/*.json) 읽기·검사. 새 JSON 파일을 넣으면 코드를 고치지 않아도 메뉴에 나온다(docs/DESIGN.md §5).
// - steps가 있으면 시나리오, segments가 있으면 하루 계획, 파일 이름이 idle.json이면 한가한 활동 설정이다.
// - 틀린 파일은 건너뛰고 경고(`파일명: 사유`)만 남긴다. 하루 계획이 없는 시나리오를 가리키면 그 구간만 뺀다.
import { z } from 'zod';
import { describeIssue } from '../data/schema';
import { EXECUTORS, STAFF_STATUSES } from '../types';
import type { DayPlan, DaySegment, Executor, IdleConfig, Scenario, ScenarioInfo, ScenarioStep, StaffStatus } from '../types';

export interface ScenarioLibrary {
  scenarios: Map<string, Scenario>;
  plans: Map<string, DayPlan>;
  idle: IdleConfig;
  warnings: string[];
  menu: ScenarioInfo[];
}

/** idle.json이 없거나 틀렸을 때 쓰는 값 */
export const DEFAULT_IDLE: IdleConfig = {
  rate_per_min: 6,
  duration_seconds: [8, 20],
  review_chance: 0.3,
  weights: { active: 3, building: 2, planned: 1, paused: 0 },
  manual_minutes: [5, 25],
};

const DEFAULT_ORDER = 999;

/* ───────────── 스키마 ───────────── */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const text = z.string().min(1);
const idText = z.string().regex(ID_RE, '영문·숫자·._- 로 된 식별자여야 합니다');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 형식(00:00~23:59)이어야 합니다');
const nonNeg = z.number().min(0);
const executor = z.enum(EXECUTORS as [Executor, ...Executor[]]);
const staffStatus = z.enum(STAFF_STATUSES as [StaffStatus, ...StaffStatus[]]);

const actorRef = z.union([
  text,
  z.strictObject({ duty: text.optional(), staff: text.optional(), team: text.optional() })
    .refine((o) => Boolean(o.duty ?? o.staff ?? o.team), 'duty·staff·team 중 하나는 있어야 합니다'),
]);

const base = { after: nonNeg, message: z.string().optional() };

const StepSchema: z.ZodType<ScenarioStep> = z.lazy(() =>
  z.discriminatedUnion('do', [
    z.strictObject({
      ...base, do: z.literal('create'), task: idText, title: text, actor: actorRef, executor,
      parent: idText.optional(), duty: text.optional(), manual_minutes: nonNeg.optional(),
    }),
    z.strictObject({ ...base, do: z.literal('start'), task: idText, actor: actorRef.optional(), executor: executor.optional() }),
    z.strictObject({
      ...base, do: z.literal('handoff'), task: idText, to: actorRef, executor,
      kind: z.enum(['work', 'review', 'revision', 'publish']).optional(), from: actorRef.optional(),
    }),
    z.strictObject({ ...base, do: z.literal('review'), task: idText, reviewer: actorRef, executor, actor: actorRef.optional() }),
    z.strictObject({
      ...base, do: z.literal('approval'), task: idText, summary: text, actor: actorRef.optional(), executor: executor.optional(),
      on_approve: z.array(StepSchema), on_reject: z.array(StepSchema),
    }),
    z.strictObject({ ...base, do: z.literal('block'), task: idText, reason: text, actor: actorRef.optional(), executor: executor.optional() }),
    z.strictObject({
      ...base, do: z.literal('complete'), task: idText, actor: actorRef.optional(), executor: executor.optional(),
      outcome: z.enum(['done', 'rejected']).optional(), human_minutes: nonNeg.optional(),
    }),
    z.strictObject({ ...base, do: z.literal('status'), actor: actorRef, status: staffStatus, executor: executor.optional() }),
  ]),
) as unknown as z.ZodType<ScenarioStep>;

const ScenarioSchema = z.strictObject({
  id: idText,
  title: text,
  description: z.string(),
  order: z.number().optional(),
  start: hhmm,
  virtual_minutes: z.number().positive(),
  steps: z.array(StepSchema).min(1),
});

const SegmentSchema = z.union([
  z.strictObject({ idle: z.literal(true), until: hhmm, real_seconds: z.number().positive() }),
  z.strictObject({ scenario: idText }),
]);

const PlanSchema = z.strictObject({
  id: idText,
  title: text,
  description: z.string(),
  order: z.number().optional(),
  start: hhmm,
  segments: z.array(SegmentSchema).min(1),
});

const range = (label: string, minValue: number) =>
  z.tuple([z.number().min(minValue), z.number().min(minValue)]).refine(([a, b]) => a <= b, `${label}은 [작은 값, 큰 값] 순서여야 합니다`);

const IdleSchema = z.strictObject({
  rate_per_min: nonNeg,
  duration_seconds: range('duration_seconds', 1),
  review_chance: z.number().min(0).max(1),
  weights: z.strictObject({ active: nonNeg, building: nonNeg, planned: nonNeg, paused: nonNeg }),
  manual_minutes: range('manual_minutes', 0),
});

/* ───────────── 의미 검사 ───────────── */

/** 작업은 만든 뒤에만 쓸 수 있고, 같은 작업을 두 번 만들지 않는다. 문제가 있으면 한 줄 사유. */
function checkTasks(steps: readonly ScenarioStep[], created: ReadonlySet<string>, where: string): string | null {
  const known = new Set(created);
  for (let i = 0; i < steps.length; i += 1) {
    const st = steps[i]!;
    const at = `${where}.${i}`;
    if (st.do === 'create') {
      if (known.has(st.task)) return `${at}: 작업 '${st.task}'을 두 번 만들었습니다`;
      if (st.parent !== undefined && !known.has(st.parent)) return `${at}: 만들지 않은 부모 작업 '${st.parent}'`;
      known.add(st.task);
      continue;
    }
    if (st.do === 'status') continue;
    if (!known.has(st.task)) return `${at}: 만들지 않은 작업 '${st.task}'을 씁니다`;
    if (st.do === 'approval') {
      const a = checkTasks(st.on_approve, known, `${at}.on_approve`);
      if (a) return a;
      const r = checkTasks(st.on_reject, known, `${at}.on_reject`);
      if (r) return r;
    }
  }
  return null;
}

/* ───────────── 읽기 ───────────── */

const baseName = (key: string): string => key.replace(/\\/g, '/').split('/').pop() ?? key;

function firstIssues(error: z.ZodError): string {
  return error.issues.slice(0, 2).map((i) => describeIssue(i, '파일')).join('; ');
}

const order = (o: { order?: number; id: string }): [number, string] => [o.order ?? DEFAULT_ORDER, o.id];

/**
 * 파일 경로 → 파일 내용 목록을 시나리오 라이브러리로 바꾼다(순수 함수). 키는 파일 경로, 값은 JSON을 읽은 객체.
 * 같은 입력이면 파일 순서와 관계없이 같은 결과가 나온다(파일 이름 순으로 처리).
 */
export function parseScenarioFiles(files: Record<string, unknown>): ScenarioLibrary {
  const warnings: string[] = [];
  const scenarios = new Map<string, Scenario>();
  const planCandidates = new Map<string, { plan: DayPlan; file: string }>();
  let idle: IdleConfig = DEFAULT_IDLE;

  const keys = Object.keys(files).sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b));
  for (const key of keys) {
    const file = baseName(key);
    const value = files[key];
    const warn = (why: string): void => { warnings.push(`${file}: ${why}`); };

    if (file === 'idle.json') {
      const r = IdleSchema.safeParse(value);
      if (r.success) idle = r.data as IdleConfig;
      else {
        warn(`${firstIssues(r.error)} — 기본값을 씁니다`);
        idle = DEFAULT_IDLE;
      }
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warn('JSON 객체가 아닙니다');
      continue;
    }
    const hasSteps = 'steps' in value;
    const hasSegments = 'segments' in value;
    if (hasSteps && hasSegments) {
      warn('steps(시나리오)와 segments(하루 계획)가 함께 있어 건너뜁니다');
      continue;
    }
    if (hasSteps) {
      const r = ScenarioSchema.safeParse(value);
      if (!r.success) {
        warn(firstIssues(r.error));
        continue;
      }
      const sc = r.data as unknown as Scenario;
      const problem = checkTasks(sc.steps, new Set(), 'steps');
      if (problem) {
        warn(problem);
        continue;
      }
      if (scenarios.has(sc.id) || planCandidates.has(sc.id)) {
        warn(`id '${sc.id}'가 이미 있어 건너뜁니다`);
        continue;
      }
      scenarios.set(sc.id, sc);
      continue;
    }
    if (hasSegments) {
      const r = PlanSchema.safeParse(value);
      if (!r.success) {
        warn(firstIssues(r.error));
        continue;
      }
      const plan = r.data as unknown as DayPlan;
      if (scenarios.has(plan.id) || planCandidates.has(plan.id)) {
        warn(`id '${plan.id}'가 이미 있어 건너뜁니다`);
        continue;
      }
      planCandidates.set(plan.id, { plan, file });
      continue;
    }
    warn('시나리오(steps)도 하루 계획(segments)도 아닙니다');
  }

  // 하루 계획: 없는 시나리오를 가리키는 구간은 빼고 경고. 남는 구간이 없으면 계획을 건너뛴다.
  const plans = new Map<string, DayPlan>();
  for (const { plan, file } of planCandidates.values()) {
    const segments: DaySegment[] = [];
    for (const seg of plan.segments) {
      if ('scenario' in seg && !scenarios.has(seg.scenario)) {
        warnings.push(`${file}: 없는 시나리오 '${seg.scenario}'를 가리키는 구간을 뺍니다`);
        continue;
      }
      segments.push(seg);
    }
    if (!segments.length) {
      warnings.push(`${file}: 쓸 수 있는 구간이 없어 건너뜁니다`);
      continue;
    }
    plans.set(plan.id, { ...plan, segments });
  }

  const infos: { info: ScenarioInfo; key: [number, string] }[] = [];
  for (const p of plans.values()) infos.push({ info: { id: p.id, title: p.title, description: p.description }, key: order(p) });
  for (const s of scenarios.values()) infos.push({ info: { id: s.id, title: s.title, description: s.description }, key: order(s) });
  infos.sort((a, b) => a.key[0] - b.key[0] || (a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0));

  return { scenarios, plans, idle, warnings, menu: infos.map((x) => x.info) };
}

// 새 JSON 파일을 폴더에 넣기만 하면 읽힌다(Vite가 빌드·시험 때 파일 목록을 만든다).
const scenarioModules = import.meta.glob('../scenarios/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

/** 번들된 src/scenarios/*.json 전부를 읽은 라이브러리 */
export function loadScenarioLibrary(): ScenarioLibrary {
  return parseScenarioFiles(scenarioModules);
}
