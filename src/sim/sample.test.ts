// 예시 이벤트 기록(public/sample/events.sample.jsonl) 확인: 고정 seed·고정 날짜로 모닝 브리핑 1회분(자동 승인 포함, 한가한 활동 없음)을
// 만들어 파일과 같은지 본다. 파일을 다시 만들려면 `UPDATE_SAMPLE=1` 로 이 시험을 한 번 돌린다.
// 화면 코드용 타입 설정(src)에는 Node 타입이 없어서, 파일 읽기·쓰기는 모듈 이름을 변수로 불러 쓴다(시험은 Node에서 돌아간다).
import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { applyInPlace, cloneShell, initialState } from '../core/reducer';
import { indexOrg, parseOrg } from '../data/org';
import { parseEvent, parseEventText } from '../data/schema';
import type { PbEvent } from '../types';
import { SimEngine } from './engine';
import { DEFAULT_IDLE, parseScenarioFiles } from './load';

const SEED = 2026;
const DATE = '2026-10-17';
const SCENARIO = 'morning-briefing';
const SAMPLE_URL = new URL('../../public/sample/events.sample.jsonl', import.meta.url);

interface FsLike {
  existsSync(path: URL): boolean;
  mkdirSync(path: URL, options: { recursive: boolean }): void;
  readFileSync(path: URL, encoding: 'utf8'): string;
  writeFileSync(path: URL, data: string, encoding: 'utf8'): void;
}
async function nodeFs(): Promise<FsLike> {
  const name = 'node:fs';
  return (await import(/* @vite-ignore */ name)) as FsLike;
}
const updateRequested = (): boolean =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_SAMPLE === '1';

const index = indexOrg(parseOrg(bundledOrg));

/** 시나리오 파일은 그대로, 한가한 활동 설정만 `분당 0건`으로 바꾼 라이브러리 */
function quietLibrary() {
  const files: Record<string, unknown> = { ...import.meta.glob('../scenarios/*.json', { eager: true, import: 'default' }) };
  for (const key of Object.keys(files)) {
    if (key.endsWith('/idle.json')) files[key] = { ...DEFAULT_IDLE, rate_per_min: 0 };
  }
  return parseScenarioFiles(files);
}

/** 모닝 브리핑 1회차(둘째 회차 첫 이벤트가 나오기 직전까지)의 이벤트 */
function generate(): PbEvent[] {
  const library = quietLibrary();
  expect(library.warnings).toEqual([]);
  const engine = new SimEngine({ index, library, seed: SEED, scenario: SCENARIO, startDate: DATE, autoApprove: true });
  const events: PbEvent[] = [];
  for (let tau = 0; tau < 1000; tau += 1) {
    for (const e of engine.advance(1)) {
      if (e.task_id?.startsWith(`${SCENARIO}#2/`)) return events;
      events.push(e);
    }
  }
  throw new Error('모닝 브리핑 둘째 회차가 시작되지 않았습니다');
}

const toJsonl = (events: PbEvent[]): string => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

async function readSample(): Promise<string> {
  const fs = await nodeFs();
  expect(fs.existsSync(SAMPLE_URL), 'public/sample/events.sample.jsonl 이 없습니다 — UPDATE_SAMPLE=1 로 이 시험을 한 번 돌려 만드세요').toBe(true);
  return fs.readFileSync(SAMPLE_URL, 'utf8');
}

describe('예시 이벤트 기록', () => {
  const events = generate();
  const expected = toJsonl(events);

  it('고정 seed·날짜로 만든 모닝 브리핑 1회분과 같다 (다시 만들기: UPDATE_SAMPLE=1)', async () => {
    if (updateRequested()) {
      const fs = await nodeFs();
      fs.mkdirSync(new URL('./', SAMPLE_URL), { recursive: true });
      fs.writeFileSync(SAMPLE_URL, expected, 'utf8');
    }
    const actual = (await readSample()).replace(/\r\n/g, '\n');
    expect(actual).toBe(expected);
  });

  it('같은 입력이면 매번 같은 기록이 나온다', () => {
    expect(toJsonl(generate())).toBe(expected);
  });

  it('모든 줄이 스키마를 지키고 ts는 줄지 않으며 날짜는 시작 날짜 하루뿐이다', async () => {
    const parsed = parseEventText(await readSample());
    expect(parsed.bad).toBe(0);
    expect(parsed.errors).toEqual([]);
    expect(parsed.events.length).toBeGreaterThan(20);
    expect(parsed.events).toEqual(events);
    let prev = '';
    for (const e of parsed.events) {
      expect(parseEvent(e).ok).toBe(true);
      expect(e.ts >= prev).toBe(true);
      prev = e.ts;
    }
    expect(new Set(parsed.events.map((e) => e.ts.slice(0, 10)))).toEqual(new Set([DATE]));
    expect(new Set(parsed.events.map((e) => e.event_id)).size).toBe(parsed.events.length);
  });

  it('한가한 활동 없이 모닝 브리핑 작업만 있고, 자동 승인이 들어 있으며, 끝까지 마무리된다', () => {
    expect(events.every((e) => e.task_id?.startsWith(`${SCENARIO}#1/`))).toBe(true);
    const requested = events.filter((e) => e.type === 'approval_requested');
    const decided = events.filter((e) => e.type === 'approval_decided');
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(decided).toHaveLength(requested.length);
    for (const d of decided) expect(d.payload).toMatchObject({ auto: true, decision: 'approve' });

    const state = cloneShell(initialState(index));
    for (const e of events) applyInPlace(state, e, index);
    expect(state.warnings).toEqual([]);
    const tasks = Object.values(state.tasks);
    expect(tasks.length).toBeGreaterThan(3);
    for (const t of tasks) expect(['completed', 'rejected'], `${t.id}: ${t.status}`).toContain(t.status);
    expect(Object.values(state.approvals).filter((a) => a.status === 'pending')).toEqual([]);
  });

  it('가상 시연 기록답게 종목·매매 문구가 없고 실제 경로·비밀값 꼴도 없다', async () => {
    const text = await readSample();
    expect(text).not.toMatch(/매수|매도|목표가|추천 종목/);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/\b(?:sk|ghp|xox[bp])[-_][A-Za-z0-9]{10,}/);
    expect(text).not.toMatch(/\r/);
  });
});
