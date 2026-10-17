// 타임라인(되감기) 계산 도우미(순수 함수): 시각 ↔ 막대 위치(0~1), 키보드 한 칸, 눈금 묶기.
import type { DashboardView } from '../types';
import { parseTs, toKstIso } from './format';

export interface TimeRange { startMs: number; endMs: number }
export type Cursor = 'live' | string;

/** 막대 맨 끝 0.5% 안은 '실시간'으로 붙는다(끌어서 끝까지 가면 실시간으로 돌아오게). */
export const LIVE_SNAP = 0.995;
/** 눈금은 막대를 이 칸 수로 나눠 칸마다 종류별 1개로 묶는다(DOM이 눈금 수만큼 늘지 않게). */
export const MARK_BUCKETS = 240;

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 받은 이벤트의 첫~마지막 시각. 하나도 없거나 한 시각뿐이면 null(되감기 못 함). */
export function timeRangeOf(range: DashboardView['range']): TimeRange | null {
  const startMs = parseTs(range.start);
  const endMs = parseTs(range.end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

export function fractionOf(ms: number, r: TimeRange): number {
  return clamp01((ms - r.startMs) / (r.endMs - r.startMs));
}

/** 커서의 막대 위치. 실시간이거나 읽을 수 없으면 맨 끝(1). */
export function cursorFraction(cursor: Cursor, r: TimeRange | null): number {
  if (!r || cursor === 'live') return 1;
  const t = parseTs(cursor);
  return t === null ? 1 : fractionOf(t, r);
}

/** 밀리초 → 커서. 끝 가까이면 'live', 처음보다 앞이면 처음. 커서는 초 단위(KST ISO)다. */
export function cursorAtMs(ms: number, r: TimeRange): Cursor {
  const span = r.endMs - r.startMs;
  if (ms >= r.startMs + span * LIVE_SNAP) return 'live';
  return toKstIso(Math.max(r.startMs, Math.floor(ms / 1000) * 1000));
}

export function cursorAtFraction(frac: number, r: TimeRange): Cursor {
  return cursorAtMs(r.startMs + clamp01(frac) * (r.endMs - r.startMs), r);
}

/** 키보드 한 칸: 범위의 1%(최소 1초). big이면 10%. direction −1은 과거로, +1은 최신으로. */
export function stepCursor(cursor: Cursor, r: TimeRange, direction: -1 | 1, big = false): Cursor {
  const span = r.endMs - r.startMs;
  const step = Math.max(1000, span * (big ? 0.1 : 0.01));
  const nowMs = cursor === 'live' ? r.endMs : parseTs(cursor) ?? r.endMs;
  return cursorAtMs(nowMs + direction * step, r);
}

export interface MarkBucket { kind: 'approval' | 'blocked'; frac: number; count: number; ts: string }

/** 승인·막힘 눈금을 칸으로 묶는다. 같은 칸·같은 종류는 1개(건수는 count). 막대 왼쪽부터. */
export function bucketMarks(marks: DashboardView['marks'], r: TimeRange | null, buckets: number = MARK_BUCKETS): MarkBucket[] {
  if (!r) return [];
  const map = new Map<string, MarkBucket>();
  for (const m of marks) {
    const t = parseTs(m.ts);
    if (t === null || t < r.startMs || t > r.endMs) continue;
    const bin = Math.min(buckets - 1, Math.floor(fractionOf(t, r) * buckets));
    const key = `${m.kind}:${bin}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { kind: m.kind, frac: (bin + 0.5) / buckets, count: 1, ts: m.ts });
  }
  return [...map.values()].sort((a, b) => a.frac - b.frac || a.kind.localeCompare(b.kind));
}

/** 밀도 막대 높이(0~1): 가장 많은 칸을 1로. 전부 0이면 전부 0. */
export function densityHeights(density: readonly number[]): number[] {
  const max = density.reduce((m, v) => Math.max(m, v), 0);
  return density.map((v) => (max > 0 ? v / max : 0));
}
