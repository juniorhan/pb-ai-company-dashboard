// 직원 상세 서랍(docs/DESIGN.md §4.6): 오른쪽 420px(휴대폰은 바텀시트). Esc·바깥 클릭·닫기 단추로 닫히고, 열리면 포커스가 서랍으로 옮겨 간다.
// 직원 말고도 대표·AI 총괄·미배정(조직에 없는 행위자)을 같은 서랍에서 보여 준다.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { CircleHelp, X } from 'lucide-react';
import { CEO_ID, STAFF_STATUS_LABEL, UNASSIGNED_PREFIX } from '../types';
import type { DashboardView, OrgHq, OrgIndex, OrgStaff, StaffState } from '../types';
import { useUi } from './context';
import { formatClock } from './format';
import { DeptDot, deptColorOf, ExecutorPill, OpTag, PersonIcon, StatusChip, StatusIcon, TaskChip } from './primitives';
import { currentTaskOf, openTasksOfExecutor, pendingApprovals, recentTasksOf, runningByExecutor, taskLastTs } from './selectors';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dsec">
      <h3 className="dsec-title">{title}</h3>
      {children}
    </section>
  );
}

function Header({ icon, title, id, onClose }: { icon: ReactNode; title: string; id: string; onClose(): void }) {
  return (
    <header className="drawer-head">
      {icon}
      <div className="drawer-heading">
        <h2 id="drawer-title" className="drawer-title">{title}</h2>
        <p className="drawer-id">{id}</p>
      </div>
      <button type="button" className="btn btn-quiet btn-icon drawer-close" aria-label="상세 닫기" title="닫기 (Esc)" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
  );
}

/** 상태 이력(최신이 위): 시각 · 아이콘 · 글자 · 메시지. */
function HistorySection({ state }: { state: StaffState | undefined }) {
  const list = [...(state?.history ?? [])].reverse();
  return (
    <Section title={`상태 이력 (${list.length})`}>
      {list.length === 0 ? (
        <p className="muted small">아직 상태가 바뀐 기록이 없습니다</p>
      ) : (
        <ol className="hist">
          {list.map((h, i) => (
            <li key={`${h.ts}-${i}`} data-status={h.status}>
              <time className="num">{formatClock(h.ts)}</time>
              <StatusIcon kind={h.status} size={13} />
              <b>{STAFF_STATUS_LABEL[h.status]}</b>
              {h.message && <span className="hist-msg">{h.message}</span>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

interface DetailProps { view: DashboardView; index: OrgIndex; select(id: string | null): void }

function StaffDetail({ staff, view, index, select }: DetailProps & { staff: OrgStaff }) {
  const { state } = view;
  const st = state.staff[staff.id];
  const status = st?.status ?? 'idle';
  const task = currentTaskOf(state, staff.id);
  const dept = index.depts.get(staff.dept);
  const team = index.teams.get(staff.team);
  const color = deptColorOf(index, staff.dept);
  const recent = recentTasksOf(state, staff.id, 10);
  return (
    <>
      <Header icon={<PersonIcon op={staff.status} color={color} dim={status === 'offline'} size={40} />} title={staff.name} id={staff.id} onClose={() => select(null)} />
      <div className="drawer-body">
        <Section title="소속">
          <dl className="kv">
            <dt>본부</dt>
            <dd><DeptDot color={color} />{dept?.name ?? staff.dept}</dd>
            <dt>팀</dt>
            <dd>{team?.name ?? staff.team}<span className="muted-id">{team?.id ?? ''}</span></dd>
            <dt>운영 상태</dt>
            <dd><OpTag status={staff.status} /></dd>
            <dt>단계</dt>
            <dd>{staff.phase ?? '미정'}</dd>
            <dt>위험 등급</dt>
            <dd>{staff.risk ?? '미정'}</dd>
          </dl>
        </Section>

        <Section title="지금">
          <p className="now-line">
            <StatusChip status={status} />
            {task ? <b className="now-title">{task.title}</b> : <span className="muted">진행 중인 작업이 없습니다</span>}
          </p>
          {task && (
            <dl className="kv">
              <dt>실행 주체</dt>
              <dd><ExecutorPill executor={task.executor} /></dd>
              <dt>시작</dt>
              <dd className="num">{formatClock(task.startedAt ?? task.createdAt)}</dd>
            </dl>
          )}
          {st?.lastMessage && <p className="muted small">{`마지막 기록 · ${st.lastTs ? `${formatClock(st.lastTs)} · ` : ''}${st.lastMessage}`}</p>}
        </Section>

        <Section title="임무">
          <p className="drawer-text">{staff.role}</p>
        </Section>

        <Section title={`담당 업무 (${staff.duties.length})`}>
          {staff.duties.length === 0 ? (
            <p className="muted small">정해진 담당 업무가 없습니다</p>
          ) : (
            <ul className="plain-list">
              {staff.duties.map((d) => (
                <li key={d.id}>{d.title}<span className="muted-id">{d.id}</span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="실행 주체 · 검증">
          <dl className="kv">
            <dt>실행 주체</dt>
            <dd className="pills">{staff.executors.length ? staff.executors.map((e) => <ExecutorPill key={e} executor={e} />) : <span className="muted">없음</span>}</dd>
            <dt>검증 종류</dt>
            <dd className="pills">{staff.checkers.length ? staff.checkers.map((e) => <ExecutorPill key={e} executor={e} />) : <span className="muted">없음</span>}</dd>
            <dt>검증자</dt>
            <dd className="links">
              {staff.checker_staff.length === 0 && <span className="muted">없음</span>}
              {staff.checker_staff.map((id) => (
                <button key={id} type="button" className="link" data-actor-id={id} onClick={() => select(id)}>{index.staff.get(id)?.name ?? id}</button>
              ))}
            </dd>
          </dl>
        </Section>

        <Section title={`최근 작업 (${recent.length})`}>
          {recent.length === 0 ? (
            <p className="muted small">최근 작업이 없습니다</p>
          ) : (
            <ul className="task-list">
              {recent.map((t) => (
                <li key={t.id}>
                  <span className="task-title">{t.title}</span>
                  <TaskChip status={t.status} />
                  <time className="num">{formatClock(taskLastTs(t))}</time>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <HistorySection state={st} />
      </div>
      <footer className="drawer-foot">역할 프로필입니다. 실제 실행 주체는 위 배지의 AI·스크립트입니다.</footer>
    </>
  );
}

function CeoDetail({ view, index, select }: DetailProps) {
  const { state } = view;
  const { ceo } = index.org;
  const st = state.staff[CEO_ID];
  const status = st?.status ?? 'idle';
  const waiting = pendingApprovals(state);
  const isSim = view.source.kind === 'sim';
  return (
    <>
      <Header icon={<PersonIcon op="active" color="var(--ink)" size={40} />} title={ceo.title} id={CEO_ID} onClose={() => select(null)} />
      <div className="drawer-body">
        <Section title="역할">
          <p className="now-line"><StatusChip status={status} /><span className="drawer-text">사람 · 승인 결정</span></p>
        </Section>
        <Section title="맡는 일">
          <ul className="plain-list">{ceo.holds.map((h) => <li key={h}>{h}</li>)}</ul>
        </Section>
        <Section title="대표 영역(직원 업무 아님)">
          {ceo.owner_only.length === 0 ? (
            <p className="muted small">없음</p>
          ) : (
            <ul className="plain-list">{ceo.owner_only.map((o) => <li key={o.task}>{o.title}<span className="muted-id">{o.task}</span></li>)}</ul>
          )}
        </Section>
        <Section title={`승인 대기 (${waiting.length})`}>
          {waiting.length === 0 ? (
            <p className="muted small">대기 중인 승인이 없습니다</p>
          ) : (
            <ul className="task-list">
              {waiting.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="task-title">{state.tasks[a.taskId]?.title ?? a.taskId}</span>
                  <button type="button" className="link" data-actor-id={a.requestedBy} onClick={() => select(a.requestedBy)}>{index.actorName(a.requestedBy)}</button>
                  <time className="num">{formatClock(a.requestedAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <HistorySection state={st} />
      </div>
      <footer className="drawer-foot">
        {isSim ? '대표는 직원이 아니라 사람입니다. 이 화면의 승인은 체험용 시뮬레이션입니다.' : '대표는 직원이 아니라 사람입니다. 실제 승인은 대시보드 밖에서 대표가 합니다.'}
      </footer>
    </>
  );
}

function HqDetail({ hq, view, index, select }: DetailProps & { hq: OrgHq }) {
  const { state } = view;
  const st = state.staff[hq.id];
  const status = st?.status ?? 'idle';
  const running = runningByExecutor(state)[hq.executor];
  const tasks = openTasksOfExecutor(state, hq.executor, 8);
  return (
    <>
      <Header icon={<span className="hq-badge hq-badge-lg" aria-hidden="true">AI</span>} title={hq.name} id={hq.id} onClose={() => select(null)} />
      <div className="drawer-body">
        <Section title="역할">
          <p className="drawer-text">{hq.role}</p>
          <p className="now-line"><ExecutorPill executor={hq.executor} /><StatusChip status={status} /></p>
        </Section>
        <Section title={`지금 이 실행 주체로 진행 중인 작업 (${running}건)`}>
          {tasks.length === 0 ? (
            <p className="muted small">진행 중인 작업이 없습니다</p>
          ) : (
            <ul className="task-list">
              {tasks.map((t) => (
                <li key={t.id}>
                  <span className="task-title">{t.title}</span>
                  <TaskChip status={t.status} />
                  <button type="button" className="link" data-actor-id={t.owner} onClick={() => select(t.owner)}>{index.actorName(t.owner)}</button>
                </li>
              ))}
              {running > tasks.length && <li className="muted small">{`외 ${running - tasks.length}건`}</li>}
            </ul>
          )}
        </Section>
        <HistorySection state={st} />
      </div>
      <footer className="drawer-foot">AI 총괄 체계의 실행 주체입니다. 직원(역할 프로필)이 아닙니다.</footer>
    </>
  );
}

function ActorDetail({ id, view, index, select }: DetailProps & { id: string }) {
  const { state } = view;
  const st = state.staff[id];
  const unassigned = id.startsWith(UNASSIGNED_PREFIX);
  const task = currentTaskOf(state, id);
  return (
    <>
      <Header icon={<span className="drawer-unknown" aria-hidden="true"><CircleHelp size={26} /></span>} title={index.actorName(id)} id={id} onClose={() => select(null)} />
      <div className="drawer-body">
        <Section title="지금">
          <p className="now-line">
            <StatusChip status={st?.status ?? 'idle'} />
            {task ? <b className="now-title">{task.title}</b> : <span className="muted">진행 중인 작업이 없습니다</span>}
          </p>
          {st?.lastMessage && <p className="muted small">{`마지막 기록 · ${st.lastTs ? `${formatClock(st.lastTs)} · ` : ''}${st.lastMessage}`}</p>}
        </Section>
        <HistorySection state={st} />
      </div>
      <footer className="drawer-foot">
        {unassigned ? '담당 업무를 맡은 직원을 찾지 못한 행위자입니다. 조직이 바뀐 뒤 시나리오가 그대로일 수 있습니다.' : '조직에 없는 id입니다. 조직 사본이 오래됐거나 기록의 id가 틀렸을 수 있습니다.'}
      </footer>
    </>
  );
}

export function StaffDrawer({ view, index }: { view: DashboardView; index: OrgIndex }) {
  const { selectedId, select } = useUi();
  const panelRef = useRef<HTMLElement>(null);
  const returnRef = useRef<HTMLElement | SVGElement | null>(null);   // 오피스의 직원 도형은 SVG 요소다
  const wasOpen = useRef(false);
  const open = selectedId !== null;

  // 열리면 포커스를 서랍으로 옮기고, 닫히면 열었던 곳으로 돌려보낸다. 다른 대상으로 바뀔 때도 서랍 머리로.
  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        const el = document.activeElement;
        returnRef.current = (el instanceof HTMLElement || el instanceof SVGElement) && el !== document.body ? el : null;
        wasOpen.current = true;
      }
      panelRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const el = returnRef.current;
      returnRef.current = null;
      if (el && el.isConnected) el.focus();
    }
  }, [open, selectedId]);

  // Esc, 바깥 누르기. 행위자 요소([data-actor-id])와 타임라인 같은 [data-keep-drawer]는 바깥으로 치지 않는다.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); select(null); }
    };
    const onDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-actor-id], [data-keep-drawer]')) return;
      select(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, select]);

  if (!selectedId) return null;
  const staff = index.staff.get(selectedId);
  const hq = index.org.hq.find((h) => h.id === selectedId);
  const props: DetailProps = { view, index, select };
  return (
    <>
      <div className="scrim" aria-hidden="true" />
      <aside ref={panelRef} className="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-title" tabIndex={-1} data-actor-kind={staff ? 'staff' : selectedId === CEO_ID ? 'ceo' : hq ? 'hq' : 'other'}>
        {staff ? (
          <StaffDetail key={staff.id} staff={staff} {...props} />
        ) : selectedId === CEO_ID ? (
          <CeoDetail key={CEO_ID} {...props} />
        ) : hq ? (
          <HqDetail key={hq.id} hq={hq} {...props} />
        ) : (
          <ActorDetail key={selectedId} id={selectedId} {...props} />
        )}
      </aside>
    </>
  );
}
