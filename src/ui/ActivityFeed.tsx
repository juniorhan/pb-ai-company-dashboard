// 활동 피드(docs/DESIGN.md §4.5): 필터 한 줄(본부·종류·실행 주체) + 최신이 위인 줄 목록(최대 200줄).
// 스크롤이 위에 있지 않을 때 새 이벤트가 오면 '새 활동 n건' 단추. 행위자 이름을 누르면 상세 패널.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListFilter, X } from 'lucide-react';
import { EXECUTOR_LABEL, EXECUTORS } from '../types';
import type { DashboardView, Executor, FeedItem, OrgIndex } from '../types';
import { useUi } from './context';
import { formatClock } from './format';
import { deptColorOf, deptStyle, ExecutorPill, feedIconLabel, StatusIcon } from './primitives';
import {
  describeEvent, EMPTY_FEED_FILTER, eventIconKind, FEED_KINDS, FEED_LIMIT, feedKindOf, feedSubtitle, filterFeed, isFeedFilterActive,
} from './selectors';
import type { FeedFilter, FeedKind } from './selectors';
import { firstSegment } from './textFit';

interface RowProps { item: FeedItem; index: OrgIndex; subtitle: string; onSelect(id: string): void }

/** 줄 하나. item·subtitle이 그대로면 다시 그리지 않는다(새 이벤트가 와도 기존 줄은 그대로). */
const FeedRow = memo(function FeedRow({ item, index, subtitle, onSelect }: RowProps) {
  const e = item.event;
  const color = deptColorOf(index, index.actorDept(e.staff_id));
  const icon = eventIconKind(e);
  const actor = index.actorName(e.staff_id);
  return (
    <li className="feed-row" data-kind={feedKindOf(e)} style={deptStyle(color)} title={e.message || undefined}>
      <time className="feed-time num" dateTime={e.ts}>{formatClock(e.ts)}</time>
      <span className="feed-bar" aria-hidden="true" />
      <div className="feed-main">
        <p className="feed-line">
          <button type="button" className="link feed-actor" data-actor-id={e.staff_id} title={`${actor} — 상세 보기`} onClick={() => onSelect(e.staff_id)}>{actor}</button>
          <span className="feed-action">{describeEvent(e, index)}</span>
        </p>
        {subtitle && <p className="feed-title">{subtitle}</p>}
      </div>
      <div className="feed-tail">
        <ExecutorPill executor={e.executor} />
        {icon ? (
          <span className="feed-icon" role="img" aria-label={feedIconLabel(icon)} title={feedIconLabel(icon)}><StatusIcon kind={icon} size={13} /></span>
        ) : (
          <span className="feed-icon" aria-hidden="true" />
        )}
      </div>
    </li>
  );
});

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function filterSummary(f: FeedFilter, index: OrgIndex): string {
  const parts: string[] = [];
  if (f.depts.length === 1) parts.push(firstSegment(index.depts.get(f.depts[0]!)?.name ?? f.depts[0]!));
  else if (f.depts.length > 1) parts.push(`본부 ${f.depts.length}`);
  if (f.kind !== 'all') parts.push(FEED_KINDS.find((k) => k.id === f.kind)?.label ?? f.kind);
  if (f.executors.length === 1) parts.push(EXECUTOR_LABEL[f.executors[0]!]);
  else if (f.executors.length > 1) parts.push(`주체 ${f.executors.length}`);
  return parts.join(' · ');
}

const FEED_FILTER_ID = 'feed-filter-panel';

export function ActivityFeed({ view, index }: { view: DashboardView; index: OrgIndex }) {
  const { select } = useUi();
  const { state } = view;
  const rewinding = view.cursor !== 'live';
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FEED_FILTER);
  const [open, setOpen] = useState(false);
  const active = isFeedFilterActive(filter);

  const items = useMemo(() => filterFeed(state.feed, filter, index), [state.feed, filter, index]);
  const topSeq = items[0]?.seq ?? 0;

  // 스크롤이 위가 아니면 새로 들어온 줄 수를 센다. 위를 떠나는 순간의 맨 위 줄 번호를 기억한다.
  const listRef = useRef<HTMLOListElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [seen, setSeen] = useState(0);
  const atTopRef = useRef(true);
  const topSeqRef = useRef(0);
  useEffect(() => { topSeqRef.current = topSeq; });
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop <= 8;
    if (top === atTopRef.current) return;
    atTopRef.current = top;
    if (!top) setSeen(topSeqRef.current);
    setAtTop(top);
  }, []);
  const toTop = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
    atTopRef.current = true;
    setAtTop(true);
  }, []);
  // 필터를 바꾸거나 되감기를 시작·끝낼 때는 맨 위로.
  useEffect(() => { toTop(); }, [filter, rewinding, toTop]);

  const newCount = atTop || rewinding ? 0 : items.reduce((n, it) => (it.seq > seen ? n + 1 : n), 0);
  const total = state.feed.length;
  const summary = filterSummary(filter, index);
  const clear = (): void => setFilter(EMPTY_FEED_FILTER);

  return (
    <section className="feed" aria-labelledby="feed-title">
      <header className="panel-head">
        <h2 id="feed-title" className="panel-title">활동 피드</h2>
        <span className="panel-count num">{active ? `${items.length}/${Math.min(total, 300)}줄` : `${items.length}줄`}</span>
      </header>

      <div className="feed-filterbar">
        <button
          type="button"
          className="btn btn-quiet btn-sm feed-filter-toggle"
          aria-expanded={open}
          aria-controls={FEED_FILTER_ID}
          data-active={active}
          onClick={() => setOpen((v) => !v)}
        >
          <ListFilter size={14} aria-hidden="true" />필터
        </button>
        <span className="feed-filter-summary" data-active={active}>{active ? summary : '전체 활동'}</span>
        {active && (
          <button type="button" className="btn btn-quiet btn-sm" aria-label="필터 해제" onClick={clear}>
            <X size={13} aria-hidden="true" />해제
          </button>
        )}
      </div>

      {open && (
        <div id={FEED_FILTER_ID} className="feed-filters" role="group" aria-label="활동 필터">
          <div className="filter-row">
            <span className="filter-label">본부</span>
            <div className="chips">
              {index.org.depts.map((d) => {
                const on = filter.depts.includes(d.id);
                return (
                  <button key={d.id} type="button" className="chip" aria-pressed={on} title={d.name} onClick={() => setFilter((f) => ({ ...f, depts: toggle(f.depts, d.id) }))}>
                    <span className="dept-dot" style={deptStyle(deptColorOf(index, d.id))} aria-hidden="true" />{firstSegment(d.name)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="filter-row">
            <span className="filter-label">종류</span>
            <div className="chips" role="group" aria-label="종류(하나만 고름)">
              {FEED_KINDS.map((k) => (
                <button key={k.id} type="button" className="chip" aria-pressed={filter.kind === k.id} onClick={() => setFilter((f) => ({ ...f, kind: k.id as FeedKind }))}>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-row">
            <span className="filter-label">주체</span>
            <div className="chips">
              {EXECUTORS.map((x: Executor) => (
                <button key={x} type="button" className="chip" aria-pressed={filter.executors.includes(x)} onClick={() => setFilter((f) => ({ ...f, executors: toggle(f.executors, x) }))}>
                  {EXECUTOR_LABEL[x]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="feed-body">
        <div className="feed-newwrap" aria-live="polite">
          {newCount > 0 && (
            <button type="button" className="feed-new" onClick={toTop}>{`새 활동 ${newCount}건`}</button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="feed-empty">
            {total === 0 ? (
              <p>아직 기록된 활동이 없습니다</p>
            ) : (
              <>
                <p>조건에 맞는 활동이 없습니다</p>
                <button type="button" className="btn btn-quiet btn-sm" onClick={clear}>필터 해제</button>
              </>
            )}
          </div>
        ) : (
          <ol ref={listRef} className="feed-list" onScroll={onScroll} aria-label={`활동 ${items.length}줄, 최신이 위`}>
            {items.map((it) => (
              <FeedRow key={it.seq} item={it} index={index} subtitle={feedSubtitle(state, it.event)} onSelect={select} />
            ))}
          </ol>
        )}
      </div>
      {items.length >= FEED_LIMIT && <p className="feed-cap">{`최근 ${FEED_LIMIT}줄까지만 보여 줍니다`}</p>}
    </section>
  );
}
