// 승인 관문 레인(docs/DESIGN.md §4.4): 대표 승인 대기 목록. [승인][반려]는 source.decide가 있을 때(시뮬레이션)만 보인다.
import { useRef } from 'react';
import { Check, X } from 'lucide-react';
import type { DashboardView, EventSource, OrgIndex } from '../types';
import { useUi } from './context';
import { formatClock, formatWaited, parseTs } from './format';
import { useNow, useSimTick } from './hooks';
import { DeptDot, deptColorOf } from './primitives';
import { pendingApprovals, recentDecisions } from './selectors';

export function ApprovalLane({ view, index, source }: { view: DashboardView; index: OrgIndex; source: EventSource }) {
  const { select } = useUi();
  const { state } = view;
  const control = source.control;
  const sim = useSimTick(control);
  const rewinding = view.cursor !== 'live';
  const isSim = view.source.kind === 'sim';
  const isFile = view.source.kind === 'file';
  const canDecide = typeof source.decide === 'function';
  const pending = pendingApprovals(state);
  const decisions = recentDecisions(state, 3);
  // 기다린 시간의 '지금': 되감기 중이면 그 시점, 시뮬레이션이면 시뮬레이션 시계, 파일이면 기록의 마지막 시각, 실연결이면 현재 시각.
  const realNow = useNow(1000, !control && !rewinding && !isFile);
  const nowMs = rewinding ? parseTs(view.cursor) : control ? parseTs(sim?.clock ?? control.clock()) : isFile ? parseTs(state.lastTs) : realNow;
  const maxDue = useRef<Record<string, number>>({});

  return (
    <section className="lane" aria-labelledby="lane-title">
      <header className="panel-head">
        <h2 id="lane-title" className="panel-title">{`대표 승인 대기 (${pending.length})`}</h2>
      </header>
      <p className="lane-note" data-tone={isSim ? 'sim' : 'readonly'}>
        {isSim ? '체험용 시뮬레이션 — 실제 승인이 아닙니다' : '읽기 전용 — 실제 승인은 대시보드 밖에서 대표가 합니다'}
      </p>

      {pending.length === 0 ? (
        <p className="lane-empty">대기 중인 승인이 없습니다</p>
      ) : (
        <ul className="ap-list">
          {pending.map((a) => {
            const taskTitle = state.tasks[a.taskId]?.title ?? a.taskId;
            const waited = nowMs !== null && parseTs(a.requestedAt) !== null ? formatWaited(nowMs - parseTs(a.requestedAt)!) : null;
            const due = !rewinding && control ? control.autoApproveDue(a.id) : null;
            if (due !== null) maxDue.current[a.id] = Math.max(maxDue.current[a.id] ?? 0, due);
            const pct = due !== null && (maxDue.current[a.id] ?? 0) > 0 ? Math.min(100, (due / maxDue.current[a.id]!) * 100) : 0;
            const color = deptColorOf(index, index.actorDept(a.requestedBy));
            return (
              <li key={a.id} className="ap-item">
                <p className="ap-title">{taskTitle}</p>
                <p className="ap-by">
                  <DeptDot color={color} />
                  <button type="button" className="link" onClick={() => select(a.requestedBy)}>{index.actorName(a.requestedBy)}</button>
                  {waited && <span className="ap-wait">{`· ${waited} 대기`}</span>}
                </p>
                {a.summary && <p className="ap-summary">{a.summary}</p>}
                {due !== null && (
                  <div className="ap-auto">
                    <div className="ap-auto-bar" role="progressbar" aria-label="자동 승인까지 남은 시간" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><span style={{ width: `${pct}%` }} /></div>
                    <span className="ap-auto-text">{`${Math.ceil(due / 1000)}초 뒤 자동 승인(시연)`}</span>
                  </div>
                )}
                {canDecide && (
                  <div className="ap-actions">
                    <button type="button" className="btn btn-approve" aria-label={`${taskTitle} 승인`} disabled={rewinding} title={rewinding ? '되감기 중에는 결정할 수 없습니다' : undefined} onClick={() => source.decide?.(a.id, 'approve')}>
                      <Check size={14} aria-hidden="true" />승인
                    </button>
                    <button type="button" className="btn btn-reject" aria-label={`${taskTitle} 반려`} disabled={rewinding} title={rewinding ? '되감기 중에는 결정할 수 없습니다' : undefined} onClick={() => source.decide?.(a.id, 'reject')}>
                      <X size={14} aria-hidden="true" />반려
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {decisions.length > 0 && (
        <details className="ap-recent">
          <summary>{`최근 결정 (${decisions.length})`}</summary>
          <ul>
            {decisions.map((a) => (
              <li key={a.id} data-decision={a.status}>
                {a.status === 'approved' ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                <span className="ap-recent-text">
                  <b>{a.status === 'approved' ? (a.auto ? '자동 승인(시연)' : '승인') : '반려'}</b>
                  {` · ${state.tasks[a.taskId]?.title ?? a.taskId}`}
                </span>
                <time className="num">{formatClock(a.decidedAt)}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
