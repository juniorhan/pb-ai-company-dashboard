// 소스(EventSource) → 이벤트 보관(EventLog) → 화면용 DashboardView. 화면은 이 스토어와 EventSource 인터페이스만 쓴다(AGENTS.md §4).
// useSyncExternalStore에 그대로 넘길 수 있게 subscribe·getView는 this에 기대지 않는 클로저다.
import { EventLog } from './eventlog';
import type { DashboardState, DashboardStore, DashboardView, EventSource, OrgIndex, SourceStatus } from '../types';

export interface OrgMeta { origin: 'live' | 'bundled'; generatedAt: string; hash: string }

const NOTIFY_GAP_MS = 50;       // 알림은 묶어서 초당 최대 20회

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

export function createDashboardStore(index: OrgIndex, source: EventSource, orgMeta: OrgMeta): DashboardStore {
  const log = new EventLog(index);
  const listeners = new Set<() => void>();
  const unsubscribers: (() => void)[] = [];

  let status: SourceStatus = { state: 'idle', detail: '', lastEventTs: null };
  let cursor: 'live' | string = 'live';
  let version = 0;                          // 이벤트 기록이 바뀔 때마다 +1
  let view: DashboardView | null = null;    // null이면 다음 getView에서 새로 만든다
  let cursorCache: { cursor: string; version: number; state: DashboardState } | null = null;
  let disposed = false;

  // 알림 묶기: requestAnimationFrame이 있으면 그것으로(최소 간격 50ms), 없으면 setTimeout 50ms
  let pending = false;
  let lastNotifyAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;

  function buildState(): DashboardState {
    if (cursor === 'live') return log.latest();
    if (cursorCache && cursorCache.cursor === cursor && cursorCache.version === version) return cursorCache.state;
    const state = log.stateAt(cursor);
    // 커서 뒤에 새 이벤트가 와도 그 시점의 상태는 같다(적용한 이벤트 수 seq가 같다) — 같은 객체를 돌려 화면이 다시 그려지지 않게 한다
    if (cursorCache && cursorCache.cursor === cursor && cursorCache.state.seq === state.seq) {
      cursorCache.version = version;
      return cursorCache.state;
    }
    cursorCache = { cursor, version, state };
    return state;
  }

  /** 보관 구간보다 이른 이벤트를 건너뛰었으면 소스 상태 설명에 덧붙인다(조용히 버리지 않는다). */
  function sourceStatus(): SourceStatus {
    if (!log.stale) return status;
    const note = `보관 구간보다 이른 이벤트 ${log.stale}건은 반영하지 않음`;
    return { ...status, detail: status.detail ? `${status.detail} · ${note}` : note };
  }

  function buildView(): DashboardView {
    return {
      state: buildState(),
      cursor,
      range: log.range(),
      density: log.density(60),
      marks: log.marks(),
      source: { kind: source.kind, label: source.label, live: source.live, status: sourceStatus() },
      org: orgMeta,
    };
  }

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function fire(): void {
    pending = false;
    timer = null;
    frame = null;
    if (disposed) return;
    lastNotifyAt = nowMs();
    emit();
  }

  function schedule(): void {
    if (pending || disposed) return;
    pending = true;
    if (typeof requestAnimationFrame === 'function') {
      const step = (): void => {
        if (disposed) return;
        if (nowMs() - lastNotifyAt < NOTIFY_GAP_MS) frame = requestAnimationFrame(step);
        else fire();
      };
      frame = requestAnimationFrame(step);
    } else {
      timer = setTimeout(fire, NOTIFY_GAP_MS);
    }
  }

  function changed(): void {
    view = null;
    schedule();
  }

  unsubscribers.push(
    source.subscribe((batch) => {
      if (disposed) return;
      const result = log.add(batch);
      if (result.added > 0) {
        version += 1;
        changed();
      } else if (result.stale > 0) {
        changed();                          // 상태는 그대로, 소스 상태 설명(건너뛴 건수)만 바뀐다
      }
    }),
  );
  unsubscribers.push(
    source.onStatus((next) => {
      if (disposed) return;
      status = next;
      changed();
    }),
  );
  if (source.onReset) {
    unsubscribers.push(
      source.onReset(() => {
        if (disposed) return;
        log.clear();
        cursor = 'live';
        cursorCache = null;
        version += 1;
        changed();
      }),
    );
  }

  return {
    index,
    source,
    getView() {
      if (!view) view = buildView();
      return view;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCursor(next) {
      if (disposed || next === cursor) return;
      if (next !== 'live' && Number.isNaN(Date.parse(next))) return;     // 읽을 수 없는 시각은 무시
      cursor = next;
      view = null;
      emit();                                                            // 사용자가 끄는 중이라 묶지 않고 바로 알린다
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribers) off();
      unsubscribers.length = 0;
      if (timer !== null) clearTimeout(timer);
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      timer = null;
      frame = null;
      listeners.clear();
      source.stop();
    },
  };
}
