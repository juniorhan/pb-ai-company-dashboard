// 요약 띠(docs/DESIGN.md §4.7): 카드 6개. 상태별 인원 · 진행 중 작업 · 승인 대기 · 막힘 · 실행 주체별(오늘) · AI가 대신한 업무(오늘).
import { useMemo } from 'react';
import { OctagonAlert } from 'lucide-react';
import { EXECUTOR_LABEL, STAFF_STATUS_LABEL, STAFF_STATUSES } from '../types';
import type { DashboardView, OrgIndex } from '../types';
import { formatDuration } from './format';
import { StatusIcon } from './primitives';
import { blockedTaskCount, executorStats, openTaskCount, pendingApprovals, staffStatusCounts } from './selectors';

export function SummaryStrip({ view, index }: { view: DashboardView; index: OrgIndex }) {
  const { state } = view;
  const counts = useMemo(() => staffStatusCounts(index, state), [index, state]);
  const total = index.org.staff.length;
  const open = useMemo(() => openTaskCount(state), [state]);
  const pending = useMemo(() => pendingApprovals(state).length, [state]);
  const blocked = useMemo(() => blockedTaskCount(state), [state]);
  const stats = useMemo(() => executorStats(state), [state]);
  const maxCreated = Math.max(1, ...stats.map((s) => s.created));
  const { completed, savedMinutes } = state.metrics;
  const barLabel = STAFF_STATUSES.map((s) => `${STAFF_STATUS_LABEL[s]} ${counts[s]}명`).join(', ');
  const footnote = view.source.kind === 'sim' ? '시뮬레이션 수치 · 추정' : '추정 — 기준 분 표 기준';

  return (
    <section className="summary" aria-label="요약">
      <div className="card card-status">
        <h2 className="card-title">{`상태별 인원 · 전체 ${total}명`}</h2>
        <div className="statbar" role="img" aria-label={barLabel}>
          {STAFF_STATUSES.map((s) => (counts[s] > 0 ? <span key={s} className="statbar-seg" data-status={s} style={{ flexGrow: counts[s] }} /> : null))}
        </div>
        <ul className="statlegend">
          {STAFF_STATUSES.map((s) => (
            <li key={s} data-status={s}>
              <StatusIcon kind={s} size={13} />
              <span className="statlegend-label">{STAFF_STATUS_LABEL[s]}</span>
              <span className="num">{counts[s]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card card-metric">
        <h2 className="card-title">진행 중 작업</h2>
        <p className="metric"><span className="big num">{open}</span><span className="unit">건</span></p>
        <p className="card-foot">완료·반려 종료 제외</p>
      </div>

      <div className="card card-metric" data-alert={pending > 0 ? 'warning' : undefined}>
        <h2 className="card-title">승인 대기</h2>
        <p className="metric"><span className="big num">{pending}</span><span className="unit">건</span></p>
        <p className="card-foot">대표 결정을 기다리는 일</p>
      </div>

      <div className="card card-metric" data-alert={blocked > 0 ? 'critical' : undefined}>
        <h2 className="card-title">막힘</h2>
        <p className="metric">
          {blocked > 0 && <OctagonAlert className="metric-icon" size={22} strokeWidth={2.2} aria-label="막힘 있음" />}
          <span className="big num">{blocked}</span><span className="unit">건</span>
        </p>
        <p className="card-foot">{blocked > 0 ? '확인이 필요한 작업' : '막힌 작업 없음'}</p>
      </div>

      <div className="card card-exec">
        <h2 className="card-title">실행 주체별 · 오늘 생성 <span className="card-title-sub">(괄호: 지금 진행)</span></h2>
        <ul className="execbars">
          {stats.map((s) => (
            <li key={s.executor}>
              <span className="exec-name">{EXECUTOR_LABEL[s.executor]}</span>
              <span className="exec-bar" aria-hidden="true"><span style={{ width: `${(s.created / maxCreated) * 100}%` }} /></span>
              <span className="num exec-n">{s.created}<span className="exec-run">{`(${s.running})`}</span></span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card card-saved">
        <h2 className="card-title">AI가 대신한 업무 · 오늘</h2>
        <p className="metric"><span className="label-pre">완료</span><span className="big num">{completed}</span><span className="unit">건</span></p>
        <p className="saved-line">{`절약 추정 ${formatDuration(savedMinutes)}`}</p>
        <p className="card-foot">{footnote}</p>
      </div>
    </section>
  );
}
