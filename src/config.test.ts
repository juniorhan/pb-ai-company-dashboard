// readConfig: URL 쿼리 → AppConfig. 잘못된 값은 모두 기본값으로 돌아가는지 본다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('readConfig 기본값', () => {
  it('쿼리가 없으면 시뮬레이션·하루 압축 재생·1배속·자동 승인', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_456);
    expect(readConfig('')).toEqual({
      source: 'sim', url: null, intervalMs: 5000, scenario: 'day', speed: 1, view: 'office', seed: 123_456, autoApprove: true,
    });
  });

  it('seed가 없으면 부를 때마다 현재 시각에서 정한다(0 이상 10억 미만 정수)', () => {
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(5_000_000_001);
    expect(readConfig('').seed).toBe(1);
    spy.mockReturnValue(5_000_000_002);
    expect(readConfig('').seed).toBe(2);
    spy.mockRestore();
    const real = readConfig('').seed;
    expect(Number.isInteger(real)).toBe(true);
    expect(real).toBeGreaterThanOrEqual(0);
    expect(real).toBeLessThan(1e9);
  });

  it('인자를 안 주면 현재 주소의 쿼리(location.search)를 읽고, location이 없으면 기본값', () => {
    expect(readConfig().source).toBe('sim');
    vi.stubGlobal('location', { search: '?source=jsonl&speed=5' });
    expect(readConfig()).toMatchObject({ source: 'jsonl', speed: 5 });
  });

  it('앞의 ? 는 있어도 없어도 같다', () => {
    expect(readConfig('?view=org').view).toBe('org');
    expect(readConfig('view=org').view).toBe('org');
  });
});

describe('source', () => {
  it('sim·jsonl·file·ws만 받는다', () => {
    for (const s of ['sim', 'jsonl', 'file', 'ws']) expect(readConfig(`?source=${s}`).source).toBe(s);
    for (const bad of ['', 'SIM', 'http', 'bogus', 'sim,jsonl']) expect(readConfig(`?source=${bad}`).source).toBe('sim');
  });
});

describe('url', () => {
  it('jsonl: http(s) 주소와 사이트 안 상대 경로만 받는다', () => {
    const ok = [
      'https://example.com/events.jsonl', 'http://127.0.0.1:5173/__pbai/events', '/__pbai/events', 'events.jsonl',
      './data/events.jsonl', '../x/events.jsonl', 'a/b/c.jsonl?token=1&x=2',
    ];
    for (const u of ok) expect(readConfig(`?source=jsonl&url=${encodeURIComponent(u)}`).url, u).toBe(u);
  });

  it('jsonl: 다른 방식·역슬래시·공백·조각은 받지 않는다', () => {
    const bs = String.fromCharCode(92);                                  // 역슬래시 한 글자
    const bad = [
      'javascript:alert(1)', 'data:text/plain,hello', 'file:///etc/passwd', 'ftp://example.com/x', 'wss://example.com/x',
      '//evil.example/x', `${bs}${bs}evil.example${bs}x`, `/${bs}evil.example`, 'https://a b', 'events.jsonl#frag',
      ['C', ':', '/', 'dir', '/events.jsonl'].join(''), '   ',
    ];
    for (const u of bad) expect(readConfig(`?source=jsonl&url=${encodeURIComponent(u)}`).url, u).toBeNull();
  });

  it('ws: ws(s) 주소만 받는다', () => {
    for (const u of ['wss://example.com/live', 'ws://localhost:8080', 'WS://LOCALHOST:1']) {
      expect(readConfig(`?source=ws&url=${encodeURIComponent(u)}`).url, u).toBe(u);
    }
    for (const u of ['https://example.com', '/events', 'wss://', 'wss://a b', 'javascript:1']) {
      expect(readConfig(`?source=ws&url=${encodeURIComponent(u)}`).url, u).toBeNull();
    }
  });

  it('sim·file에서는 ws·http(s)·상대 경로 모두 받아 두고, 이상한 값은 null', () => {
    expect(readConfig(`?source=sim&url=${encodeURIComponent('wss://a.example/x')}`).url).toBe('wss://a.example/x');
    expect(readConfig(`?source=file&url=${encodeURIComponent('/a.jsonl')}`).url).toBe('/a.jsonl');
    expect(readConfig(`?source=sim&url=${encodeURIComponent('javascript:1')}`).url).toBeNull();
  });

  it('앞뒤 공백은 지우고, 비어 있으면 null', () => {
    expect(readConfig(`?source=jsonl&url=${encodeURIComponent('  /a.jsonl  ')}`).url).toBe('/a.jsonl');
    expect(readConfig('?source=jsonl&url=').url).toBeNull();
    expect(readConfig('?source=jsonl').url).toBeNull();
  });
});

describe('interval', () => {
  it('초 단위로 받아 ms로 바꾸고 1~300초로 자른다', () => {
    const ms = (q: string): number => readConfig(q).intervalMs;
    expect(ms('?interval=10')).toBe(10_000);
    expect(ms('?interval=2.5')).toBe(2500);
    expect(ms('?interval=1')).toBe(1000);
    expect(ms('?interval=0')).toBe(1000);
    expect(ms('?interval=-5')).toBe(1000);
    expect(ms('?interval=300')).toBe(300_000);
    expect(ms('?interval=1000')).toBe(300_000);
  });

  it('숫자가 아니면 기본 5초', () => {
    for (const bad of ['', 'abc', 'NaN', 'Infinity', '5초', ' ']) expect(readConfig(`?interval=${bad}`).intervalMs, bad).toBe(5000);
  });
});

describe('scenario', () => {
  it('영문·숫자·._- 로 된 식별자만 받는다', () => {
    for (const ok of ['day', 'morning-briefing', 'report_digest', 'a.b', 'X1']) expect(readConfig(`?scenario=${ok}`).scenario).toBe(ok);
    for (const bad of ['', 'a b', '../x', '-day', '.hidden', '하루', 'a/b', '<script>']) {
      expect(readConfig(`?scenario=${encodeURIComponent(bad)}`).scenario, bad).toBe('day');
    }
  });
});

describe('speed', () => {
  it('1·2·5만, 그 밖은 1', () => {
    for (const s of [1, 2, 5]) expect(readConfig(`?speed=${s}`).speed).toBe(s);
    expect(readConfig('?speed=5.0').speed).toBe(5);
    for (const bad of ['0', '3', '10', '-1', '1.5', 'abc', '']) expect(readConfig(`?speed=${bad}`).speed, bad).toBe(1);
  });
});

describe('view', () => {
  it('office·org만, 그 밖은 office', () => {
    expect(readConfig('?view=org').view).toBe('org');
    expect(readConfig('?view=office').view).toBe('office');
    for (const bad of ['', 'ORG', 'map', 'office,org']) expect(readConfig(`?view=${bad}`).view, bad).toBe('office');
  });
});

describe('seed', () => {
  it('정수는 그대로(음수는 절댓값), 아니면 기본값', () => {
    vi.spyOn(Date, 'now').mockReturnValue(777_000_000_042);
    expect(readConfig('?seed=42').seed).toBe(42);
    expect(readConfig('?seed=0').seed).toBe(0);
    expect(readConfig('?seed=-7').seed).toBe(7);
    expect(readConfig('?seed=1e3').seed).toBe(1000);
    for (const bad of ['1.5', 'abc', '', 'NaN', 'Infinity']) expect(readConfig(`?seed=${bad}`).seed, bad).toBe(42);
  });
});

describe('auto', () => {
  it('auto=0 이면 자동 승인을 끈다. 그 밖의 값은 켜 둔 그대로', () => {
    expect(readConfig('?auto=0').autoApprove).toBe(false);
    for (const v of ['1', 'false', 'off', '', '00']) expect(readConfig(`?auto=${v}`).autoApprove, v).toBe(true);
    expect(readConfig('').autoApprove).toBe(true);
  });
});

describe('여러 값 함께', () => {
  it('서로 영향 없이 각자 읽는다', () => {
    const c = readConfig('?source=jsonl&url=%2Fa.jsonl&interval=30&scenario=anomaly&speed=2&view=org&seed=9&auto=0');
    expect(c).toEqual({ source: 'jsonl', url: '/a.jsonl', intervalMs: 30_000, scenario: 'anomaly', speed: 2, view: 'org', seed: 9, autoApprove: false });
  });

  it('같은 키가 여러 번이면 첫 값을 쓴다', () => {
    expect(readConfig('?speed=2&speed=5').speed).toBe(2);
  });
});
