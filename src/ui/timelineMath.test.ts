import { describe, expect, it } from 'vitest';
import { parseTs } from './format';
import {
  bucketMarks, cursorAtFraction, cursorAtMs, cursorFraction, densityHeights, fractionOf, LIVE_SNAP, stepCursor, timeRangeOf,
} from './timelineMath';

const START = '2026-10-17T06:00:00+09:00';
const END = '2026-10-17T07:00:00+09:00';
const range = timeRangeOf({ start: START, end: END })!;
const ms = (iso: string): number => parseTs(iso)!;

describe('timeRangeOf', () => {
  it('첫~마지막 시각, 비었거나 한 시각뿐이면 null', () => {
    expect(range.endMs - range.startMs).toBe(3600_000);
    expect(timeRangeOf({ start: null, end: null })).toBeNull();
    expect(timeRangeOf({ start: START, end: START })).toBeNull();
    expect(timeRangeOf({ start: END, end: START })).toBeNull();
    expect(timeRangeOf({ start: '엉터리', end: END })).toBeNull();
  });
});

describe('커서 ↔ 막대 위치', () => {
  it('실시간·읽을 수 없는 커서·범위 없음은 맨 끝(1)', () => {
    expect(cursorFraction('live', range)).toBe(1);
    expect(cursorFraction('엉터리', range)).toBe(1);
    expect(cursorFraction('2026-10-17T06:30:00+09:00', null)).toBe(1);
  });

  it('중간 시각은 비율로, 범위 밖은 0~1로 자른다', () => {
    expect(cursorFraction('2026-10-17T06:30:00+09:00', range)).toBeCloseTo(0.5, 6);
    expect(cursorFraction('2026-10-17T05:00:00+09:00', range)).toBe(0);
    expect(cursorFraction('2026-10-17T09:00:00+09:00', range)).toBe(1);
    expect(fractionOf(ms('2026-10-17T06:15:00+09:00'), range)).toBeCloseTo(0.25, 6);
  });

  it('막대를 끝 가까이까지 끌면 실시간, 그 밖에는 초 단위 KST 시각', () => {
    expect(cursorAtFraction(1, range)).toBe('live');
    expect(cursorAtFraction(LIVE_SNAP, range)).toBe('live');
    expect(cursorAtFraction(LIVE_SNAP - 0.01, range)).not.toBe('live');
    expect(cursorAtFraction(0, range)).toBe('2026-10-17T06:00:00+09:00');
    expect(cursorAtFraction(0.5, range)).toBe('2026-10-17T06:30:00+09:00');
    expect(cursorAtFraction(-3, range)).toBe('2026-10-17T06:00:00+09:00');
    expect(cursorAtMs(range.startMs - 10_000, range)).toBe('2026-10-17T06:00:00+09:00');
  });

  it('왔다 갔다 해도 위치가 1초 안에서 일치한다', () => {
    for (const f of [0.1, 0.25, 0.4, 0.77, 0.9]) {
      const c = cursorAtFraction(f, range);
      expect(c).not.toBe('live');
      expect(Math.abs(cursorFraction(c, range) - f)).toBeLessThan(1 / 3600 + 1e-9);
    }
  });
});

describe('키보드 한 칸', () => {
  it('←는 범위의 1%만큼 과거로, →는 최신 쪽으로 가다 끝에서 실시간', () => {
    const left = stepCursor('live', range, -1);
    expect(left).toBe('2026-10-17T06:59:24+09:00');            // 3600초의 1% = 36초
    expect(stepCursor(left, range, 1)).toBe('live');
    expect(stepCursor('2026-10-17T06:30:00+09:00', range, 1)).toBe('2026-10-17T06:30:36+09:00');
    expect(stepCursor('2026-10-17T06:30:00+09:00', range, -1, true)).toBe('2026-10-17T06:24:00+09:00');
  });

  it('처음보다 앞으로는 가지 않고, 범위가 아주 짧아도 최소 1초씩 움직인다', () => {
    expect(stepCursor('2026-10-17T06:00:10+09:00', range, -1, true)).toBe('2026-10-17T06:00:00+09:00');
    const tiny = timeRangeOf({ start: '2026-10-17T06:00:00+09:00', end: '2026-10-17T06:00:20+09:00' })!;
    expect(stepCursor('2026-10-17T06:00:10+09:00', tiny, -1)).toBe('2026-10-17T06:00:09+09:00');
  });
});

describe('눈금·밀도', () => {
  it('같은 칸·같은 종류는 하나로 묶고 건수를 센다. 범위 밖과 읽을 수 없는 시각은 버린다', () => {
    const marks = [                                              // 한 칸 = 15초(1시간 ÷ 240)
      { ts: '2026-10-17T06:10:05+09:00', kind: 'approval' as const },
      { ts: '2026-10-17T06:10:08+09:00', kind: 'approval' as const },
      { ts: '2026-10-17T06:10:07+09:00', kind: 'blocked' as const },
      { ts: '2026-10-17T06:50:05+09:00', kind: 'approval' as const },
      { ts: '2026-10-17T08:00:00+09:00', kind: 'approval' as const },
      { ts: '엉터리', kind: 'blocked' as const },
    ];
    const out = bucketMarks(marks, range, 240);
    expect(out.filter((m) => m.kind === 'approval').map((m) => m.count)).toEqual([2, 1]);
    expect(out.filter((m) => m.kind === 'blocked')).toHaveLength(1);
    expect(out.every((m) => m.frac > 0 && m.frac < 1)).toBe(true);
    expect([...out].sort((a, b) => a.frac - b.frac)).toEqual(out);
    expect(bucketMarks(marks, null)).toEqual([]);
  });

  it('밀도 막대는 가장 많은 칸을 1로 맞춘다', () => {
    expect(densityHeights([0, 2, 4, 1])).toEqual([0, 0.5, 1, 0.25]);
    expect(densityHeights([0, 0])).toEqual([0, 0]);
    expect(densityHeights([])).toEqual([]);
  });
});
