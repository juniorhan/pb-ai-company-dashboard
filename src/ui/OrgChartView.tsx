// 조직도 보기(HTML, docs/DESIGN.md §4.3): 대표이사 → AI 총괄 → 본부 격자(접기/펼치기) → 팀 → 직원 카드.
import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { CEO_ID, STAFF_STATUS_LABEL, STAFF_STATUSES } from '../types';
import type { DashboardState, DashboardView, OrgIndex, OrgStaff } from '../types';
import { useUi } from './context';
import { usePersistentState } from './hooks';
import { INTERNAL_CHECK_DEPT_ID } from './officeLayout';
import { deptColorOf, ExecutorPill, OpTag, PersonIcon, StatusChip, StatusIcon, deptStyle } from './primitives';
import { currentTaskOf, runningByExecutor, staffAriaLabel, staffStatusCounts, statusOf } from './selectors';

export const COLLAPSED_KEY = 'pbai.collapsed';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function StaffCard({ staff, color, state, selected, onSelect }: { staff: OrgStaff; color: string; state: DashboardState; selected: boolean; onSelect(id: string): void }) {
  const status = statusOf(state, staff.id);
  const task = currentTaskOf(state, staff.id);
  return (
    <button
      type="button"
      className={`staff-card${selected ? ' is-selected' : ''}`}
      data-actor-id={staff.id}
      data-staff-id={staff.id}
      data-status={status}
      aria-label={staffAriaLabel(staff, status, task?.title ?? null)}
      onClick={() => onSelect(staff.id)}
    >
      <span className="sc-row">
        <PersonIcon op={staff.status} color={color} dim={status === 'offline'} size={20} />
        <span className="sc-name">{staff.name}</span>
        <StatusChip status={status} />
      </span>
      <span className="sc-row sc-sub">
        <OpTag status={staff.status} />
        <span className={`sc-execs${task ? ' is-active' : ''}`}>
          {task ? <ExecutorPill executor={task.executor} /> : staff.executors.map((e) => <ExecutorPill key={e} executor={e} />)}
        </span>
        <span className={`sc-task${task ? '' : ' is-idle'}`}>{task ? task.title : '대기'}</span>
      </span>
    </button>
  );
}

export function OrgChartView({ view, index }: { view: DashboardView; index: OrgIndex }) {
  const { selectedId, select } = useUi();
  const { state } = view;
  const { org } = index;
  const [collapsed, setCollapsed] = usePersistentState<string[]>(COLLAPSED_KEY, [], isStringArray);
  const running = useMemo(() => runningByExecutor(state), [state]);
  const allClosed = collapsed.length >= org.depts.length && org.depts.every((d) => collapsed.includes(d.id));

  const toggle = (id: string): void => setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="orgchart">
      <button type="button" className={`ceo-card${selectedId === CEO_ID ? ' is-selected' : ''}`} data-actor-id={CEO_ID} onClick={() => select(CEO_ID)} aria-label={`${org.ceo.title}, 사람, 승인 결정`}>
        <span className="ceo-card-head">
          <PersonIcon op="active" color="var(--ink)" size={30} />
          <span className="ceo-card-title">{org.ceo.title}</span>
          <span className="role-chip">사람 · 승인 결정</span>
        </span>
        <span className="ceo-card-holds">
          {org.ceo.holds.map((h) => <span key={h} className="role-chip role-chip-quiet">{h}</span>)}
        </span>
        <span className="ceo-card-owner">
          <span className="owner-label">대표 영역(직원 업무 아님)</span>
          <span className="owner-items">{org.ceo.owner_only.map((o) => <span key={o.task} className="owner-item">{o.title}</span>)}</span>
        </span>
      </button>

      <div className="connector" aria-hidden="true" />

      <section className="hq-row" aria-label="AI 총괄">
        {org.hq.map((h) => (
          <button key={h.id} type="button" className={`hq-card${selectedId === h.id ? ' is-selected' : ''}`} data-actor-id={h.id} data-actor-kind="hq" onClick={() => select(h.id)} title={h.role}>
            <span className="hq-card-top">
              <span className="hq-badge" aria-hidden="true">AI</span>
              <span className="hq-card-name">{h.name}</span>
              <StatusChip status={statusOf(state, h.id)} />
            </span>
            <span className="hq-card-role">{h.role}</span>
            <span className="hq-card-run">{`지금 작업 ${running[h.executor]}건`}</span>
          </button>
        ))}
      </section>

      <div className="connector" aria-hidden="true" />

      <div className="org-toolbar">
        <button type="button" className="btn btn-quiet" onClick={() => setCollapsed([])} disabled={collapsed.length === 0}>모두 펼치기</button>
        <button type="button" className="btn btn-quiet" onClick={() => setCollapsed(org.depts.map((d) => d.id))} disabled={allClosed}>모두 접기</button>
      </div>

      <div className="dept-grid">
        {org.depts.map((dept) => {
          const color = deptColorOf(index, dept.id);
          const counts = staffStatusCounts(index, state, dept.id);
          const members = org.staff.filter((s) => s.dept === dept.id).length;
          const isCollapsed = collapsed.includes(dept.id);
          const bodyId = `dept-body-${dept.id}`;
          return (
            <article key={dept.id} className="dept" style={deptStyle(color)} data-dept={dept.id} data-collapsed={isCollapsed}>
              <header className="dept-head">
                <button type="button" className="dept-toggle" aria-expanded={!isCollapsed} aria-controls={bodyId} onClick={() => toggle(dept.id)}>
                  <ChevronDown className="chev" size={16} aria-hidden="true" />
                  <span className="dept-name">{dept.name}</span>
                </button>
                <p className="dept-meta">{`${dept.head} · ${members}명`}</p>
                <ul className="mini-legend" aria-label="상태별 인원">
                  {STAFF_STATUSES.filter((s) => counts[s] > 0).map((s) => (
                    <li key={s} data-status={s}><StatusIcon kind={s} size={12} />{STAFF_STATUS_LABEL[s]}<span className="num">{counts[s]}</span></li>
                  ))}
                </ul>
                {dept.id === INTERNAL_CHECK_DEPT_ID && <p className="dept-note">내부 검사이며 실제 준법 승인이 아님</p>}
              </header>
              {!isCollapsed && (
                <div id={bodyId} className="dept-body">
                  {(index.teamsByDept.get(dept.id) ?? []).map((team) => (
                    <section key={team.id} className="team" aria-label={team.name}>
                      <h3 className="team-head" title={team.role}>
                        <span className="team-name">{team.name}</span>
                        <span className="team-id">{team.id}</span>
                      </h3>
                      <ul className="staff-list">
                        {(index.staffByTeam.get(team.id) ?? []).map((s) => (
                          <li key={s.id}><StaffCard staff={s} color={color} state={state} selected={selectedId === s.id} onSelect={select} /></li>
                        ))}
                        {(index.expansionByTeam.get(team.id) ?? []).map((e, i) => (
                          <li key={`${team.id}-x${i}`} className="exp-card" aria-label={`확장 대기: ${e.role} — ${e.trigger}`}>
                            <span className="exp-title">{`확장 대기 · ${e.role}`}</span>
                            <span className="exp-trigger">{e.trigger}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
