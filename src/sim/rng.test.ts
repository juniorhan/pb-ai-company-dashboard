import { describe, expect, it } from 'vitest';
import { createRng, int, mulberry32, pick, weighted } from './rng';

/** 널리 알려진 mulberry32 정의를 다른 모양으로 다시 쓴 기준 구현 */
function referenceMulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 부른 횟수를 세는 난수 */
function counting(seed: number): { rand: () => number; calls: () => number } {
  const inner = mulberry32(seed);
  let n = 0;
  return { rand: () => { n += 1; return inner(); }, calls: () => n };
}

describe('mulberry32', () => {
  it('기준 구현과 같은 수열을 낸다', () => {
    for (const seed of [0, 1, 42, 123456789, 999999999, 2 ** 31 + 5]) {
      const a = mulberry32(seed);
      const b = referenceMulberry32(seed);
      for (let i = 0; i < 200; i += 1) expect(a()).toBe(b());
    }
  });

  it('같은 시드는 같은 수열, 다른 시드는 다른 수열', () => {
    const a = Array.from({ length: 20 }, mulberry32(7));
    const b = Array.from({ length: 20 }, mulberry32(7));
    const c = Array.from({ length: 20 }, mulberry32(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('0 이상 1 미만이고 고르게 퍼진다', () => {
    const rand = mulberry32(2026);
    let sum = 0;
    const buckets = new Array<number>(10).fill(0);
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const x = rand();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
      buckets[Math.floor(x * 10)]! += 1;
    }
    expect(sum / N).toBeGreaterThan(0.48);
    expect(sum / N).toBeLessThan(0.52);
    for (const count of buckets) expect(count).toBeGreaterThan(N / 10 - 300);
  });
});

describe('pick', () => {
  it('빈 목록은 undefined이고 난수를 쓰지 않는다', () => {
    const c = counting(1);
    expect(pick(c.rand, [])).toBeUndefined();
    expect(c.calls()).toBe(0);
  });

  it('난수를 하나 쓰고, 모든 항목이 고르게 나온다', () => {
    const c = counting(5);
    const items = ['a', 'b', 'c', 'd'];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 4000; i += 1) counts[pick(c.rand, items)!]! += 1;
    expect(c.calls()).toBe(4000);
    for (const k of items) expect(counts[k]!).toBeGreaterThan(850);
  });

  it('난수가 1에 아주 가까워도 범위를 넘지 않는다', () => {
    expect(pick(() => 0.9999999999, ['x', 'y'])).toBe('y');
    expect(pick(() => 0, ['x', 'y'])).toBe('x');
  });
});

describe('int', () => {
  it('양 끝을 포함한 정수, 난수 하나', () => {
    const c = counting(9);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const v = int(c.rand, 5, 8);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([5, 6, 7, 8]);
    expect(c.calls()).toBe(500);
  });

  it('같은 값·뒤바뀐 범위·소수 경계', () => {
    expect(int(mulberry32(1), 7, 7)).toBe(7);
    const swapped = new Set(Array.from({ length: 200 }, mulberry32(3)).map((r) => int(() => r, 12, 10)));
    expect([...swapped].every((v) => v >= 10 && v <= 12)).toBe(true);
    const fractional = Array.from({ length: 200 }, mulberry32(4)).map((r) => int(() => r, 1.2, 3.8));
    expect(Math.min(...fractional)).toBe(2);
    expect(Math.max(...fractional)).toBe(3);
    expect(int(() => 0.9999999999, 0, 3)).toBe(3);
  });
});

describe('weighted', () => {
  it('가중치에 비례해 고른다(가중치 0은 절대 안 나온다)', () => {
    const rand = mulberry32(11);
    const items = [{ id: 'a', w: 3 }, { id: 'b', w: 2 }, { id: 'c', w: 1 }, { id: 'd', w: 0 }];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    const N = 12000;
    for (let i = 0; i < N; i += 1) counts[weighted(rand, items, (x) => x.w)!.id]! += 1;
    expect(counts.d).toBe(0);
    expect(counts.a! / N).toBeGreaterThan(0.47);
    expect(counts.a! / N).toBeLessThan(0.53);
    expect(counts.b! / N).toBeGreaterThan(0.30);
    expect(counts.b! / N).toBeLessThan(0.37);
    expect(counts.c! / N).toBeGreaterThan(0.14);
    expect(counts.c! / N).toBeLessThan(0.20);
  });

  it('음수·NaN·무한대 가중치는 0으로 본다', () => {
    const rand = mulberry32(12);
    const items = ['neg', 'nan', 'inf', 'ok'];
    const w = (x: string): number => ({ neg: -5, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, ok: 1 })[x]!;
    for (let i = 0; i < 200; i += 1) expect(weighted(rand, items, w)).toBe('ok');
  });

  it('가중치 합이 0이면 undefined이고 난수를 쓰지 않는다. 빈 목록도 마찬가지', () => {
    const c = counting(2);
    expect(weighted(c.rand, ['a', 'b'], () => 0)).toBeUndefined();
    expect(weighted(c.rand, [], () => 1)).toBeUndefined();
    expect(c.calls()).toBe(0);
  });

  it('난수 하나로 고르고, 난수가 1에 아주 가까워도 마지막 유효 항목을 돌려준다', () => {
    const c = counting(3);
    weighted(c.rand, ['a', 'b'], () => 1);
    expect(c.calls()).toBe(1);
    expect(weighted(() => 0.99999999999, ['a', 'b', 'z'], (x) => (x === 'z' ? 0 : 1))).toBe('b');
  });
});

describe('createRng', () => {
  it('next는 mulberry32와 같은 수열', () => {
    const r = createRng(77);
    const m = mulberry32(77);
    for (let i = 0; i < 50; i += 1) expect(r.next()).toBe(m());
  });

  it('pick·int·weighted·chance가 같은 난수 수열을 이어서 쓴다(재현 가능)', () => {
    const run = (): unknown[] => {
      const r = createRng(99);
      return [r.pick(['x', 'y', 'z']), r.int(1, 100), r.weighted(['p', 'q'], (v) => (v === 'p' ? 1 : 3)), r.chance(0.5), r.next()];
    };
    expect(run()).toEqual(run());
  });

  it('chance(0)은 늘 false, chance(1)은 늘 true', () => {
    const r = createRng(5);
    for (let i = 0; i < 100; i += 1) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
    }
  });
});
