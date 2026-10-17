import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE, loadScenarioLibrary, parseScenarioFiles } from './load';

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ after: 1, do: 'start', task: 'a', ...over });
const create = (task = 'a', over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ after: 0, do: 'create', task, title: `작업 ${task}`, actor: { duty: 'x-01-T01' }, executor: 'claude', ...over });

const scenario = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sc1', title: '시나리오 1', description: '설명', start: '09:00', virtual_minutes: 30,
  steps: [create('a'), step({ do: 'complete' })],
  ...over,
});
const plan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'plan1', title: '계획 1', description: '설명', start: '08:00',
  segments: [{ idle: true, until: '09:00', real_seconds: 10 }, { scenario: 'sc1' }],
  ...over,
});

describe('parseScenarioFiles — 정상', () => {
  it('시나리오·하루 계획·한가한 활동 설정을 읽는다', () => {
    const idle = { rate_per_min: 12, duration_seconds: [4, 9], review_chance: 0.5, weights: { active: 1, building: 1, planned: 1, paused: 1 }, manual_minutes: [1, 2] };
    const lib = parseScenarioFiles({ '../scenarios/sc1.json': scenario(), '../scenarios/plan1.json': plan(), '../scenarios/idle.json': idle });
    expect(lib.warnings).toEqual([]);
    expect([...lib.scenarios.keys()]).toEqual(['sc1']);
    expect([...lib.plans.keys()]).toEqual(['plan1']);
    expect(lib.idle).toEqual(idle);
    expect(lib.scenarios.get('sc1')!.steps).toHaveLength(2);
  });

  it('idle.json이 없거나 틀리면 기본값(분당 6, 8~20초, 0.3, 가중치 3/2/1/0, 5~25분)', () => {
    expect(DEFAULT_IDLE).toEqual({ rate_per_min: 6, duration_seconds: [8, 20], review_chance: 0.3, weights: { active: 3, building: 2, planned: 1, paused: 0 }, manual_minutes: [5, 25] });
    expect(parseScenarioFiles({ 'a/sc1.json': scenario() }).idle).toEqual(DEFAULT_IDLE);
    const lib = parseScenarioFiles({ 'a/idle.json': { rate_per_min: -1 } });
    expect(lib.idle).toEqual(DEFAULT_IDLE);
    expect(lib.warnings).toHaveLength(1);
    expect(lib.warnings[0]).toMatch(/^idle\.json: /);
    for (const bad of [{ ...DEFAULT_IDLE, duration_seconds: [20, 8] }, { ...DEFAULT_IDLE, review_chance: 2 }, { ...DEFAULT_IDLE, extra: 1 }, [], null, 'x']) {
      const l = parseScenarioFiles({ 'a/idle.json': bad });
      expect(l.idle, JSON.stringify(bad)).toEqual(DEFAULT_IDLE);
      expect(l.warnings, JSON.stringify(bad)).toHaveLength(1);
    }
  });

  it('메뉴 = 계획 + 시나리오를 order(없으면 999) → id 순으로', () => {
    const lib = parseScenarioFiles({
      'z.json': scenario({ id: 'zeta', order: 20 }),
      'y.json': scenario({ id: 'beta' }),                                    // order 없음 = 999
      'x.json': scenario({ id: 'alpha' }),                                   // order 없음 = 999
      'w.json': plan({ id: 'day', order: 0, segments: [{ scenario: 'zeta' }] }),
      'v.json': scenario({ id: 'early', order: 5 }),
    });
    expect(lib.warnings).toEqual([]);
    expect(lib.menu.map((m) => m.id)).toEqual(['day', 'early', 'zeta', 'alpha', 'beta']);
    expect(lib.menu[0]).toEqual({ id: 'day', title: '계획 1', description: '설명' });
  });

  it('새 JSON 파일이 하나 늘면 코드 수정 없이 메뉴에 늘어난다', () => {
    const files: Record<string, unknown> = { 'a.json': scenario({ id: 'one' }) };
    const before = parseScenarioFiles(files).menu.map((m) => m.id);
    files['b.json'] = scenario({ id: 'two' });
    const after = parseScenarioFiles(files).menu.map((m) => m.id);
    expect(after).toEqual([...before, 'two']);
  });

  it('파일 순서가 달라도, 경로 구분자가 \\여도 결과가 같다', () => {
    const files = { 'x/plan1.json': plan(), 'x/sc1.json': scenario(), 'x/idle.json': { ...DEFAULT_IDLE, rate_per_min: 3 } };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const a = parseScenarioFiles(files);
    const b = parseScenarioFiles(reversed);
    expect(a.menu).toEqual(b.menu);
    expect(a.idle).toEqual(b.idle);
    const win = parseScenarioFiles({ 'src\\scenarios\\sc1.json': scenario(), 'src\\scenarios\\idle.json': { ...DEFAULT_IDLE, rate_per_min: 3 } });
    expect(win.idle.rate_per_min).toBe(3);
    expect(win.warnings).toEqual([]);
  });

  it('승인 단계의 on_approve·on_reject(중첩 포함)도 검사한다', () => {
    const approval = { after: 1, do: 'approval', task: 'a', summary: '요약', on_approve: [{ after: 1, do: 'complete', task: 'a' }], on_reject: [] };
    const ok = parseScenarioFiles({ 'a.json': scenario({ steps: [create('a'), approval] }) });
    expect(ok.warnings).toEqual([]);
    const nested = parseScenarioFiles({
      'a.json': scenario({ steps: [create('a'), { ...approval, on_approve: [{ ...approval, on_approve: [{ after: 0, do: 'complete', task: 'a', executor: 'robot' }] }] }] }),
    });
    expect(nested.scenarios.size).toBe(0);
    expect(nested.warnings[0]).toContain('steps.1.on_approve.0.on_approve.0.executor');
  });
});

describe('parseScenarioFiles — 틀린 파일은 건너뛰고 경고(`파일명: 사유`)', () => {
  const one = (file: unknown): string[] => parseScenarioFiles({ '../scenarios/bad.json': file }).warnings;

  it('JSON 객체가 아니거나 시나리오도 계획도 아닌 파일', () => {
    expect(one(null)).toEqual(['bad.json: JSON 객체가 아닙니다']);
    expect(one([])).toEqual(['bad.json: JSON 객체가 아닙니다']);
    expect(one('text')).toEqual(['bad.json: JSON 객체가 아닙니다']);
    expect(one({ id: 'x' })).toEqual(['bad.json: 시나리오(steps)도 하루 계획(segments)도 아닙니다']);
    expect(one({ ...scenario(), segments: [] })[0]).toContain('함께 있어');
  });

  it('필수 칸 없음·잘못된 값·오타 칸', () => {
    const missingTitle = { ...scenario() } as Record<string, unknown>;
    delete missingTitle.title;
    expect(one(missingTitle)[0]).toMatch(/^bad\.json: title: /);
    expect(one(scenario({ start: '25:00' }))[0]).toContain('start');
    expect(one(scenario({ start: '9:00' }))[0]).toContain('start');
    expect(one(scenario({ virtual_minutes: 0 }))[0]).toContain('virtual_minutes');
    expect(one(scenario({ steps: [] }))[0]).toContain('steps');
    expect(one(scenario({ id: 'bad id/x' }))[0]).toContain('id');
    expect(one(scenario({ virtual_minute: 30 }))[0]).toContain('virtual_minute');           // 오타 칸
    expect(one(scenario({ steps: [create('a', { exector: 'claude' })] }))[0]).toContain('steps.0');
  });

  it('단계 문제: 모르는 do · 없는 executor · 음수 after · 잘못된 행위자', () => {
    expect(one(scenario({ steps: [{ after: 0, do: 'teleport', task: 'a' }] }))[0]).toContain('steps.0.do');
    expect(one(scenario({ steps: [create('a', { executor: undefined })] }))[0]).toContain('steps.0.executor');
    expect(one(scenario({ steps: [create('a', { executor: 'gpt' })] }))[0]).toContain('steps.0.executor');
    expect(one(scenario({ steps: [create('a', { after: -1 })] }))[0]).toContain('steps.0.after');
    expect(one(scenario({ steps: [create('a', { actor: {} })] }))[0]).toContain('steps.0.actor');
    expect(one(scenario({ steps: [create('a', { actor: 5 })] }))[0]).toContain('steps.0.actor');
    expect(one(scenario({ steps: [create('a'), { after: 1, do: 'status', actor: 'x', status: 'dancing' }] }))[0]).toContain('steps.1.status');
    expect(one(scenario({ steps: [create('a'), { after: 1, do: 'handoff', task: 'a', executor: 'claude' }] }))[0]).toContain('steps.1.to');
  });

  it('작업 흐름 문제: 만들기 전에 씀 · 두 번 만듦 · 없는 부모 · 분기 안 작업은 분기 밖에서 못 씀', () => {
    expect(one(scenario({ steps: [step({ task: 'ghost' })] }))[0]).toContain('만들지 않은 작업');
    expect(one(scenario({ steps: [create('a'), create('a')] }))[0]).toContain('두 번 만들었습니다');
    expect(one(scenario({ steps: [create('a', { parent: 'nope' })] }))[0]).toContain('부모');
    const approval = { after: 1, do: 'approval', task: 'a', summary: '요약', on_approve: [create('inner')], on_reject: [] };
    expect(one(scenario({ steps: [create('a'), approval, step({ task: 'inner' })] }))[0]).toContain("'inner'");
    expect(one(scenario({ steps: [create('a'), { ...approval, on_approve: [], on_reject: [step({ task: 'nope' })] }] }))[0]).toContain('on_reject');
    expect(parseScenarioFiles({ 'a.json': scenario({ steps: [create('a'), approval, step({ task: 'a' })] }) }).warnings).toEqual([]);
    expect(parseScenarioFiles({ 'a.json': scenario({ steps: [create('a'), create('b', { parent: 'a' }), { after: 1, do: 'status', actor: 'x', status: 'idle' }] }) }).warnings).toEqual([]);
  });

  it('하루 계획 문제: 구간 모양 · 시각 형식', () => {
    expect(one(plan({ segments: [] }))[0]).toContain('segments');
    expect(one(plan({ segments: [{ idle: true, until: '9am', real_seconds: 5 }] }))[0]).toContain('segments.0');
    expect(one(plan({ segments: [{ idle: true, until: '09:00', real_seconds: 0 }] }))[0]).toContain('segments.0');
    expect(one(plan({ segments: [{ idle: false, until: '09:00', real_seconds: 5 }] }))[0]).toContain('segments.0');
    expect(one(plan({ start: '7' }))[0]).toContain('start');
  });

  it('틀린 파일 하나가 다른 파일을 막지 않는다', () => {
    const lib = parseScenarioFiles({ 'a.json': scenario({ start: 'x' }), 'b.json': scenario({ id: 'good' }), 'c.json': plan({ segments: [{ scenario: 'good' }] }) });
    expect(lib.warnings).toHaveLength(1);
    expect(lib.warnings[0]).toMatch(/^a\.json: /);
    expect([...lib.scenarios.keys()]).toEqual(['good']);
    expect([...lib.plans.keys()]).toEqual(['plan1']);
  });

  it('id가 겹치면 파일 이름이 뒤인 쪽을 건너뛴다', () => {
    const lib = parseScenarioFiles({ 'a.json': scenario({ id: 'same', title: '먼저' }), 'b.json': scenario({ id: 'same', title: '나중' }), 'c.json': plan({ id: 'same' }) });
    expect(lib.scenarios.get('same')!.title).toBe('먼저');
    expect(lib.plans.size).toBe(0);
    expect(lib.warnings).toHaveLength(2);
    expect(lib.warnings.every((w) => w.includes('이미 있어'))).toBe(true);
  });

  it('없는 시나리오를 가리키는 하루 계획 구간은 빼고 경고', () => {
    const lib = parseScenarioFiles({
      'sc1.json': scenario(),
      'p.json': plan({ segments: [{ scenario: 'ghost' }, { idle: true, until: '10:00', real_seconds: 5 }, { scenario: 'sc1' }, { scenario: 'ghost2' }] }),
    });
    expect(lib.warnings).toEqual(["p.json: 없는 시나리오 'ghost'를 가리키는 구간을 뺍니다", "p.json: 없는 시나리오 'ghost2'를 가리키는 구간을 뺍니다"]);
    expect(lib.plans.get('plan1')!.segments).toEqual([{ idle: true, until: '10:00', real_seconds: 5 }, { scenario: 'sc1' }]);
  });

  it('남는 구간이 없으면 계획 자체를 건너뛴다(메뉴에도 없다)', () => {
    const lib = parseScenarioFiles({ 'p.json': plan({ segments: [{ scenario: 'ghost' }] }) });
    expect(lib.plans.size).toBe(0);
    expect(lib.menu).toEqual([]);
    expect(lib.warnings).toHaveLength(2);
  });
});

describe('loadScenarioLibrary (번들된 src/scenarios/*.json)', () => {
  it('경고 없이 읽히고 day가 메뉴 맨 앞', () => {
    const lib = loadScenarioLibrary();
    expect(lib.warnings).toEqual([]);
    expect(lib.menu[0]!.id).toBe('day');
    expect(lib.scenarios.size).toBeGreaterThan(0);
    expect(lib.idle.rate_per_min).toBeGreaterThan(0);
  });

  it('부를 때마다 같은 내용', () => {
    expect(loadScenarioLibrary().menu).toEqual(loadScenarioLibrary().menu);
  });
});
