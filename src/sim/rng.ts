// 시드 난수(mulberry32). 같은 시드면 같은 수열이 나오므로 시뮬레이션을 다시 재생할 수 있다(docs/DESIGN.md §5 '결정성').

/** 0 이상 1 미만 난수를 돌려주는 함수 */
export type Random = () => number;

export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 목록에서 하나(빈 목록이면 undefined). 난수를 하나 쓴다. */
export function pick<T>(rand: Random, items: readonly T[]): T | undefined {
  if (!items.length) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

/** min 이상 max 이하의 정수(양 끝 포함). 난수를 하나 쓴다. */
export function int(rand: Random, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.min(hi - lo, Math.floor(rand() * (hi - lo + 1)));
}

/** 가중치에 비례해 하나. 가중치 합이 0 이하이면 undefined(난수를 쓰지 않는다). 음수·NaN 가중치는 0으로 본다. */
export function weighted<T>(rand: Random, items: readonly T[], weightFn: (item: T) => number): T | undefined {
  let total = 0;
  const weights = items.map((item) => {
    const w = weightFn(item);
    const clean = Number.isFinite(w) && w > 0 ? w : 0;
    total += clean;
    return clean;
  });
  if (total <= 0) return undefined;
  let r = rand() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i]!;
    if (r < 0) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i -= 1) if (weights[i]! > 0) return items[i];   // 부동소수 오차 대비
  return undefined;
}

export interface Rng {
  next: Random;
  pick<T>(items: readonly T[]): T | undefined;
  int(min: number, max: number): number;
  weighted<T>(items: readonly T[], weightFn: (item: T) => number): T | undefined;
  /** 확률 p로 true. 난수를 하나 쓴다. */
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    pick: (items) => pick(next, items),
    int: (min, max) => int(next, min, max),
    weighted: (items, weightFn) => weighted(next, items, weightFn),
    chance: (p) => next() < p,
  };
}
