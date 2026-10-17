// createSource: 설정(AppConfig)에 맞는 소스가 만들어지는지, jsonl 기본 주소가 개발·배포에서 맞게 갈리는지 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import type { AppConfig, PbEvent, SourceStatus } from '../types';
import { StaticSource } from './base';
import { createFileSource as reExported } from './file';
import { createFileSource, createSource, defaultJsonlUrl } from './index';
import { JsonlPollingSource } from './jsonl';
import { SimulatorSource } from './simulator';
import { WebSocketSource } from './websocket';

const index = indexOrg(parseOrg(bundledOrg));
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({
  source: 'sim', url: null, intervalMs: 5000, scenario: 'day', speed: 1, view: 'office', seed: 7, autoApprove: true, ...over,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T03:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function collect(source: { subscribe(h: (b: PbEvent[]) => void): () => void; onStatus(h: (s: SourceStatus) => void): () => void }) {
  const events: PbEvent[] = [];
  const statuses: SourceStatus[] = [];
  source.subscribe((b) => { events.push(...b); });
  source.onStatus((s) => { statuses.push(s); });
  return { events, statuses };
}

describe('createSource: sim', () => {
  it('SimulatorSource를 만들고 설정(속도·시나리오·자동 승인)을 따른다', () => {
    const source = createSource(cfg({ speed: 5, scenario: 'morning-briefing', autoApprove: false }), index);
    expect(source).toBeInstanceOf(SimulatorSource);
    expect(source).toMatchObject({ kind: 'sim', live: false });
    expect(source.control!.getSpeed()).toBe(5);
    expect(source.control!.getScenario()).toBe('morning-briefing');
    expect(source.control!.getAutoApprove()).toBe(false);
    expect(typeof source.decide).toBe('function');
    expect((source as SimulatorSource).warnings).toEqual([]);          // 번들된 시나리오는 경고가 없다
    expect(source.control!.listScenarios()[0]!.id).toBe('day');
  });

  it('seed가 같으면 같은 이벤트 열, 다르면 다른 열', () => {
    const run = (seed: number): PbEvent[] => {
      const source = createSource(cfg({ seed, scenario: 'idle-morning' }), index);
      const { events } = collect(source);
      source.start();
      vi.advanceTimersByTime(60_000);
      source.stop();
      return events;
    };
    const a = run(11);
    expect(a.length).toBeGreaterThan(5);
    expect(run(11)).toEqual(a);
    expect(run(12).map((e) => e.staff_id)).not.toEqual(a.map((e) => e.staff_id));
  });

  it('알 수 없는 source 값도 시뮬레이션으로 만든다', () => {
    expect(createSource(cfg({ source: 'bogus' as AppConfig['source'] }), index)).toBeInstanceOf(SimulatorSource);
  });
});

describe('createSource: jsonl', () => {
  it('JsonlPollingSource(읽기 전용)를 만든다', () => {
    const source = createSource(cfg({ source: 'jsonl', url: '/a.jsonl', intervalMs: 7000 }), index);
    expect(source).toBeInstanceOf(JsonlPollingSource);
    expect(source).toMatchObject({ kind: 'jsonl', live: true });
    expect(source.control).toBeUndefined();
    expect(source.decide).toBeUndefined();
  });

  it('url과 간격을 설정대로 쓴다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    });
    const source = createSource(cfg({ source: 'jsonl', url: '/data/my.jsonl', intervalMs: 7000 }), index);
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['/data/my.jsonl']);
    await vi.advanceTimersByTimeAsync(6999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    source.stop();
  });

  it('url이 없으면 개발 서버에서는 /__pbai/events, 배포에서는 가짜 기록 샘플을 읽는다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    });
    vi.stubEnv('BASE_URL', '/pb-ai-company-dashboard/');

    vi.stubEnv('DEV', true);
    expect(defaultJsonlUrl()).toBe('/pb-ai-company-dashboard/__pbai/events');
    const dev = createSource(cfg({ source: 'jsonl' }), index);
    dev.start();
    await vi.advanceTimersByTimeAsync(0);
    dev.stop();

    vi.stubEnv('DEV', false);
    expect(defaultJsonlUrl()).toBe('/pb-ai-company-dashboard/sample/events.sample.jsonl');
    const prod = createSource(cfg({ source: 'jsonl' }), index);
    prod.start();
    await vi.advanceTimersByTimeAsync(0);
    prod.stop();

    expect(calls).toEqual(['/pb-ai-company-dashboard/__pbai/events', '/pb-ai-company-dashboard/sample/events.sample.jsonl']);
  });

  it('기본 주소는 BASE_URL 뒤에 붙는다(기본 base는 /)', () => {
    vi.stubEnv('BASE_URL', '/');
    vi.stubEnv('DEV', true);
    expect(defaultJsonlUrl()).toBe('/__pbai/events');
    vi.stubEnv('DEV', false);
    expect(defaultJsonlUrl()).toBe('/sample/events.sample.jsonl');
  });
});

describe('createSource: ws', () => {
  it('주소가 있으면 WebSocketSource를 만든다(연결은 start할 때)', () => {
    const source = createSource(cfg({ source: 'ws', url: 'wss://example.test/live' }), index);
    expect(source).toBeInstanceOf(WebSocketSource);
    expect(source).toMatchObject({ kind: 'ws', live: true });
    expect(source.control).toBeUndefined();
  });

  it('주소가 없으면 안내만 하는 빈 소스(상태 error)', () => {
    const source = createSource(cfg({ source: 'ws' }), index);
    expect(source).toBeInstanceOf(StaticSource);
    expect(source).toMatchObject({ kind: 'ws', live: true });
    const { events, statuses } = collect(source);
    source.start();
    expect(events).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ state: 'error' });
    expect(statuses.at(-1)!.detail).toContain('wss://');
    expect(statuses.at(-1)!.detail).toContain('주소가 없습니다');
  });
});

describe('createSource: file', () => {
  it('파일을 열기 전의 빈 소스(상태 idle, 파일을 열어 주세요)', () => {
    const source = createSource(cfg({ source: 'file' }), index);
    expect(source).toMatchObject({ kind: 'file', live: false, label: '파일' });
    expect(source.control).toBeUndefined();
    const { events, statuses } = collect(source);
    source.start();
    expect(events).toEqual([]);
    expect(statuses.at(-1)).toEqual({ state: 'idle', detail: '파일을 열어 주세요', lastEventTs: null });
  });

  it('createFileSource를 다시 내보낸다', () => {
    expect(createFileSource).toBe(reExported);
  });
});
