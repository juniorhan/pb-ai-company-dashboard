// 이벤트 보관·정렬·중복 제거·스냅숏. 되감기(stateAt)와 타임라인(range·density·marks)의 기반이다(docs/DESIGN.md §2).
//
// - event_id가 같은 이벤트는 버린다. 정렬은 ts(Date.parse) 오름차순, 같은 ts는 받은 순서.
// - 마지막 ts보다 이르지 않으면 끝에 붙이고 최신 상태에 바로 적용한다. 과거 ts가 끼면 그 자리에 넣고 그 앞 스냅숏부터 다시 계산한다.
// - snapshotEvery건마다 상태 스냅숏(그릇만 복사, 잎은 공유)을 둬서 stateAt은 가장 가까운 스냅숏부터 재생한다.
// - maxEvents를 넘으면 오래된 이벤트부터 버리되, 버린 이벤트까지 반영한 상태를 기준 상태(base)로 남겨 latest·stateAt이 바뀌지 않게 한다.
// - 버린 구간 안의 시각(버린 이벤트 중 가장 늦은 시각보다 이른)으로 늦게 온 이벤트는 기준 상태 뒤에 붙이면 시간순 재생이 깨지므로 받지 않고 센다(stale).
import { applyInPlace, cloneShell, initialState } from './reducer';
import type { DashboardState, OrgIndex, PbEvent } from '../types';

export interface EventLogOptions { snapshotEvery?: number; maxEvents?: number }
export interface EventMark { ts: string; kind: 'approval' | 'blocked' }

const DEFAULT_SNAPSHOT_EVERY = 100;
const DEFAULT_MAX_EVENTS = 20000;
const MAX_MARKS = 300;

interface Snapshot { n: number; state: DashboardState }     // n건을 적용한 뒤의 상태
interface Item { e: PbEvent; t: number }

/** times[i] > t 인 첫 위치(= t 이하인 이벤트 수) */
function upperBound(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class EventLog {
  private readonly index: OrgIndex;
  private readonly snapshotEvery: number;
  private readonly maxEvents: number;
  private evs: PbEvent[] = [];
  private times: number[] = [];
  private seen = new Set<string>();
  private base: DashboardState;                 // evs[0] 앞까지(버린 이벤트 포함) 반영한 상태
  private baseTime = Number.NEGATIVE_INFINITY;  // 버린 이벤트 중 가장 늦은 시각. 이보다 이른 이벤트는 받지 않는다
  private staleCount = 0;
  private snaps: Snapshot[] = [];               // n 오름차순, n ≥ 1
  private working: DashboardState;              // 모든 이벤트를 반영한 작업용 상태(밖으로 내보내지 않는다)
  private latestCache: DashboardState | null = null;
  private eventsCache: readonly PbEvent[] | null = null;

  constructor(index: OrgIndex, opts: EventLogOptions = {}) {
    this.index = index;
    this.snapshotEvery = Math.max(1, Math.floor(opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY));
    this.maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? DEFAULT_MAX_EVENTS));
    this.base = initialState(index);
    this.working = cloneShell(this.base);
  }

  get size(): number {
    return this.evs.length;
  }

  /** 보관 구간보다 이른 시각이라 반영하지 않은 이벤트 수(누적, clear하면 0) */
  get stale(): number {
    return this.staleCount;
  }

  add(batch: PbEvent[]): { added: number; duplicates: number; stale: number } {
    let duplicates = 0;
    let stale = 0;
    const fresh: Item[] = [];
    let latestTime = this.times.length ? this.times[this.times.length - 1]! : Number.NEGATIVE_INFINITY;
    for (const e of batch) {
      if (this.seen.has(e.event_id)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(e.event_id);
      let t = Date.parse(e.ts);
      if (Number.isNaN(t)) t = Number.isFinite(latestTime) ? latestTime : 0;   // 읽을 수 없는 시각은 끝에 붙인다
      if (t < this.baseTime) {
        stale += 1;
        continue;
      }
      if (t > latestTime) latestTime = t;
      fresh.push({ e, t });
    }
    this.staleCount += stale;
    if (!fresh.length) return { added: 0, duplicates, stale };
    fresh.sort((a, b) => a.t - b.t);        // 안정 정렬: 같은 시각은 받은 순서

    const lastTime = this.times.length ? this.times[this.times.length - 1]! : Number.NEGATIVE_INFINITY;
    if (fresh[0]!.t >= lastTime) {
      for (const { e, t } of fresh) {
        this.evs.push(e);
        this.times.push(t);
        applyInPlace(this.working, e, this.index);
        this.snapshotIfDue();
      }
    } else {
      const p = upperBound(this.times, fresh[0]!.t);
      const tailE = this.evs.splice(p);
      const tailT = this.times.splice(p);
      let i = 0;
      let j = 0;
      while (i < tailE.length || j < fresh.length) {
        const takeExisting = j >= fresh.length || (i < tailE.length && tailT[i]! <= fresh[j]!.t);   // 같은 시각이면 먼저 있던 것이 앞
        if (takeExisting) {
          this.evs.push(tailE[i]!);
          this.times.push(tailT[i]!);
          i += 1;
        } else {
          this.evs.push(fresh[j]!.e);
          this.times.push(fresh[j]!.t);
          j += 1;
        }
      }
      this.rebuildFrom(p);
    }

    this.trim();
    this.latestCache = null;
    this.eventsCache = null;
    return { added: fresh.length, duplicates, stale };
  }

  /** 모든 이벤트를 반영한 최신 상태. 바뀌지 않았으면 같은 객체. */
  latest(): DashboardState {
    if (!this.latestCache) this.latestCache = cloneShell(this.working);
    return this.latestCache;
  }

  /** ts 이하인 마지막 이벤트까지 반영한 상태 */
  stateAt(ts: string): DashboardState {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return this.latest();
    const k = upperBound(this.times, t);
    if (k >= this.evs.length) return this.latest();
    return this.replayTo(k);
  }

  range(): { start: string | null; end: string | null } {
    return { start: this.evs[0]?.ts ?? null, end: this.evs[this.evs.length - 1]?.ts ?? null };
  }

  events(): readonly PbEvent[] {
    if (!this.eventsCache) this.eventsCache = this.evs.slice();
    return this.eventsCache;
  }

  /** 첫 이벤트~마지막 이벤트 시각을 bins칸으로 나눈 이벤트 수 */
  density(bins = 60): number[] {
    const n = Math.max(1, Math.floor(bins));
    const out = new Array<number>(n).fill(0);
    const len = this.times.length;
    if (!len) return out;
    const t0 = this.times[0]!;
    const span = this.times[len - 1]! - t0;
    for (let i = 0; i < len; i += 1) {
      const slot = span > 0 ? Math.min(n - 1, Math.floor(((this.times[i]! - t0) / span) * n)) : 0;
      out[slot]! += 1;
    }
    return out;
  }

  /** 승인 요청·막힘 눈금(최근 300건, 오래된 것부터) */
  marks(): EventMark[] {
    const out: EventMark[] = [];
    for (let i = this.evs.length - 1; i >= 0 && out.length < MAX_MARKS; i -= 1) {
      const e = this.evs[i]!;
      if (e.type === 'approval_requested') out.push({ ts: e.ts, kind: 'approval' });
      else if (e.type === 'task_blocked') out.push({ ts: e.ts, kind: 'blocked' });
    }
    return out.reverse();
  }

  clear(): void {
    this.evs = [];
    this.times = [];
    this.seen = new Set();
    this.snaps = [];
    this.base = initialState(this.index);
    this.baseTime = Number.NEGATIVE_INFINITY;
    this.staleCount = 0;
    this.working = cloneShell(this.base);
    this.latestCache = null;
    this.eventsCache = null;
  }

  /* ───────────── 내부 ───────────── */

  /** 방금 적용한 이벤트까지 snapshotEvery건이 쌓였으면 스냅숏을 둔다. */
  private snapshotIfDue(): void {
    const n = this.evs.length;
    const lastN = this.snaps.length ? this.snaps[this.snaps.length - 1]!.n : 0;
    if (n - lastN >= this.snapshotEvery) this.snaps.push({ n, state: cloneShell(this.working) });
  }

  /** k건을 적용한 상태(새 복사본). k는 1 이상 evs.length 미만이거나 0. */
  private replayTo(k: number): DashboardState {
    let from: Snapshot = { n: 0, state: this.base };
    for (let i = this.snaps.length - 1; i >= 0; i -= 1) {
      if (this.snaps[i]!.n <= k) {
        from = this.snaps[i]!;
        break;
      }
    }
    const st = cloneShell(from.state);
    for (let i = from.n; i < k; i += 1) applyInPlace(st, this.evs[i]!, this.index);
    return st;
  }

  /** 위치 p 앞의 이벤트는 그대로이고 p부터 바뀌었을 때 작업용 상태와 스냅숏을 다시 만든다. */
  private rebuildFrom(p: number): void {
    while (this.snaps.length && this.snaps[this.snaps.length - 1]!.n > p) this.snaps.pop();
    const from: Snapshot = this.snaps.length ? this.snaps[this.snaps.length - 1]! : { n: 0, state: this.base };
    this.working = cloneShell(from.state);
    let lastN = from.n;
    for (let i = from.n; i < this.evs.length; i += 1) {
      applyInPlace(this.working, this.evs[i]!, this.index);
      if (i + 1 - lastN >= this.snapshotEvery) {
        this.snaps.push({ n: i + 1, state: cloneShell(this.working) });
        lastN = i + 1;
      }
    }
  }

  /** maxEvents를 넘은 만큼 오래된 이벤트를 버리고, 버린 것까지 반영한 상태를 기준 상태로 삼는다. */
  private trim(): void {
    const excess = this.evs.length - this.maxEvents;
    if (excess <= 0) return;
    this.base = this.replayTo(excess);
    this.baseTime = Math.max(this.baseTime, this.times[excess - 1]!);     // times는 오름차순: 버리는 것 중 마지막이 가장 늦다
    this.evs.splice(0, excess);
    this.times.splice(0, excess);
    this.snaps = this.snaps.filter((s) => s.n > excess).map((s) => ({ n: s.n - excess, state: s.state }));
    // 버린 이벤트의 id도 한동안 기억해 늦게 다시 와도 중복으로 막는다(무한히 늘지 않게 상한을 둔다)
    const keepIds = this.maxEvents * 4;
    if (this.seen.size > keepIds) {
      let drop = this.seen.size - this.maxEvents * 2;
      for (const id of this.seen) {
        if (drop <= 0) break;
        this.seen.delete(id);
        drop -= 1;
      }
    }
  }
}
