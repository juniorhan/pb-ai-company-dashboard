// 타임라인(되감기, docs/DESIGN.md §4.9): 받은 이벤트의 첫~마지막 시각 막대 + 60칸 밀도 + 승인·막힘 눈금.
// 끌거나 ←/→(Shift·PageUp/Down은 10%), Home(처음)/End(실시간). 되감기 중에도 새 이벤트는 계속 쌓인다.
import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { History } from 'lucide-react';
import type { DashboardStore, DashboardView } from '../types';
import { formatClock, formatClockShort, formatDateTimeKo, formatMonthDay, toKstIso } from './format';
import { bucketMarks, cursorAtFraction, cursorFraction, densityHeights, stepCursor, timeRangeOf } from './timelineMath';

/** 실시간 연결·시뮬레이션은 '실시간', 파일은 '최신 기록'. */
function liveWord(kind: DashboardView['source']['kind']): string {
  return kind === 'file' ? '최신 기록' : '실시간';
}

/** 되감기 중 본문 위에 붙는 띠. 늘 같은 자리(본문 맨 위)에 둔다. */
export function RewindBanner({ view, store }: { view: DashboardView; store: DashboardStore }) {
  if (view.cursor === 'live') return null;
  return (
    <div className="rewind-banner" data-keep-drawer title={formatDateTimeKo(view.cursor)}>
      <History size={15} aria-hidden="true" />
      <span className="rewind-text">{`되감기 중 · ${formatClock(view.cursor)} 시점`}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => store.setCursor('live')}>
        {`${liveWord(view.source.kind)}으로`}
      </button>
    </div>
  );
}

export function Timeline({ view, store }: { view: DashboardView; store: DashboardStore }) {
  const { range, cursor, density, marks } = view;
  const r = useMemo(() => timeRangeOf(range), [range]);
  const frac = cursorFraction(cursor, r);
  const rewinding = cursor !== 'live';
  const word = liveWord(view.source.kind);
  const heights = useMemo(() => densityHeights(density), [density]);
  const ticks = useMemo(() => bucketMarks(marks, r), [marks, r]);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const fracAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 1;
  };
  const apply = (f: number): void => {
    if (r) store.setCursor(cursorAtFraction(f, r));
  };
  const schedule = (f: number): void => {
    pending.current = f;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null) apply(next);
    });
  };
  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!r || e.button !== 0) return;
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 포인터 캡처를 못 해도 끌기는 동작한다 */ }
    e.currentTarget.focus();
    apply(fracAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) schedule(fracAt(e.clientX));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
    if (pending.current !== null) { const f = pending.current; pending.current = null; apply(f); }
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!r) return;
    let next: string | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = stepCursor(cursor, r, -1, e.shiftKey);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = stepCursor(cursor, r, 1, e.shiftKey);
        break;
      case 'PageDown':
        next = stepCursor(cursor, r, -1, true);
        break;
      case 'PageUp':
        next = stepCursor(cursor, r, 1, true);
        break;
      case 'Home':
        next = toKstIso(r.startMs);
        break;
      case 'End':
        next = 'live';
        break;
      default:
        return;
    }
    e.preventDefault();
    store.setCursor(next);
  };

  const sameDay = !r || formatMonthDay(range.start) === formatMonthDay(range.end);
  const edge = (ts: string | null): string => (sameDay ? formatClockShort(ts) : `${formatMonthDay(ts)} ${formatClockShort(ts)}`);
  const valueText = rewinding ? `${formatClock(cursor)} 시점` : word;

  return (
    <section className="timeline" aria-label="타임라인(되감기)" data-keep-drawer data-rewinding={rewinding}>
      <div className="tl-row">
        <div className="tl-state">
          {rewinding ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => store.setCursor('live')}>{`${word}으로`}</button>
          ) : (
            <span className="tl-live"><span className="tl-live-dot" aria-hidden="true" />{word}</span>
          )}
        </div>
        <time className="tl-edge num" dateTime={range.start ?? undefined} title={formatDateTimeKo(range.start)}>{edge(range.start)}</time>
        <div
          ref={trackRef}
          className="tl-track"
          role="slider"
          tabIndex={0}
          aria-label="타임라인 되감기"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
          aria-valuetext={valueText}
          aria-disabled={!r}
          data-disabled={!r}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          <svg className="tl-density" viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {heights.map((h, i) => (h > 0 ? <rect key={i} x={i + 0.1} y={24 - Math.max(1.5, h * 24)} width={0.8} height={Math.max(1.5, h * 24)} /> : null))}
          </svg>
          <div className="tl-rail"><div className="tl-fill" style={{ width: `${frac * 100}%` }} /></div>
          {ticks.map((t) => (
            <span
              key={`${t.kind}:${t.frac}`}
              className={`tl-tick tl-tick-${t.kind}`}
              style={{ left: `${t.frac * 100}%` }}
              title={`${t.kind === 'approval' ? '승인 요청' : '막힘'}${t.count > 1 ? ` ${t.count}건` : ''} · ${formatClock(t.ts)}`}
            />
          ))}
          <div className="tl-thumb" style={{ left: `${frac * 100}%` }} aria-hidden="true" />
        </div>
        <time className="tl-edge num" dateTime={range.end ?? undefined} title={formatDateTimeKo(range.end)}>{edge(range.end)}</time>
      </div>
      <p className="tl-legend">
        <span className="tl-key"><span className="tl-tick-sample tl-tick-approval" aria-hidden="true" />승인 요청</span>
        <span className="tl-key"><span className="tl-tick-sample tl-tick-blocked" aria-hidden="true" />막힘</span>
        <span className="tl-hint">{r ? `막대를 끌거나 ←/→ 키로 되감기 · End = ${word}` : '기록이 쌓이면 되감기를 쓸 수 있습니다'}</span>
      </p>
    </section>
  );
}
