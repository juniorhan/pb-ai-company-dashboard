// 오피스 보기(관전): 데이터에서 계산한 SVG 평면도. 방 = 본부, 책상 섬 = 팀, 사람 도형 = 직원(역할 프로필).
// 직원은 role="button"이고, 이벤트는 SVG 루트에서 위임으로 받는다(도형 수만큼 핸들러를 만들지 않는다 — memo가 먹도록).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { OP_STATUS_LABEL, STAFF_STATUSES } from '../types';
import type { DashboardState, DashboardView, OpStatus, OrgExpansion, OrgIndex, OrgTeam } from '../types';
import { useUi } from './context';
import { HandoffLayer } from './HandoffLayer';
import { CeoRoom, HqRoom, TopBorder, UnassignedBox } from './OfficeBand';
import { computeOfficeLayout, INTERNAL_CHECK_DEPT_ID, SEAT_H, SEAT_W } from './officeLayout';
import type { IslandLayout, SeatSlot } from './officeLayout';
import { deptVar, ExecutorPill, OpTag, PersonIcon, StatusChip } from './primitives';
import { currentTaskOf, pendingApprovals, unassignedActors } from './selectors';
import { StaffGlyph } from './StaffGlyph';
import { estimateTextWidth, shortLabel, truncateToWidth } from './textFit';

const INTERNAL_CHECK_TEXT = '내부 검사이며 실제 준법 승인이 아님';

/** 확장 대기 직책 — 점선 빈 의자. 움직이지 않는다. */
function Chair({ seat, chair }: { seat: SeatSlot; chair: OrgExpansion }) {
  const label = `확장 대기: ${chair.role} — ${chair.trigger}`;
  return (
    <g className="chair" role="img" aria-label={label} transform={`translate(${seat.box.x} ${seat.box.y})`}>
      <title>{label}</title>
      <rect className="chair-hit" x={0} y={0} width={SEAT_W} height={SEAT_H} />
      <rect className="chair-seat" x={SEAT_W / 2 - 16} y={12} width={32} height={26} rx={8} />
      <path className="chair-plus" d={`M${SEAT_W / 2 - 5} 25 H${SEAT_W / 2 + 5} M${SEAT_W / 2} 20 V30`} />
      <text className="chair-name" x={SEAT_W / 2} y={55} textAnchor="middle">확장 대기</text>
      <text className="chair-role" x={SEAT_W / 2} y={67} textAnchor="middle">{shortLabel(chair.role, 7)}</text>
    </g>
  );
}

function islandHeading(team: OrgTeam, width: number): { name: string; id: string | null } {
  const maxW = width - 6;
  const idW = estimateTextWidth(` ${team.id}`, 10);
  if (estimateTextWidth(team.name, 11) + idW <= maxW) return { name: team.name, id: team.id };
  return { name: truncateToWidth(team.name, maxW, 11), id: null };
}

interface IslandProps { isl: IslandLayout; slot: number; state: DashboardState; selectedId: string | null; animate: boolean }

function Island({ isl, slot, state, selectedId, animate }: IslandProps) {
  const heading = islandHeading(isl.team, isl.box.w);
  return (
    <g className="island" data-team={isl.team.id}>
      <title>{`${isl.team.name} (${isl.team.id}) — ${isl.team.role}`}</title>
      <text className="island-name" x={isl.box.x + 3} y={isl.box.y + 12}>
        {heading.name}
        {heading.id && <tspan className="island-id" dx={4}>{heading.id}</tspan>}
      </text>
      <rect className="desk" x={isl.desk.x} y={isl.desk.y} width={isl.desk.w} height={isl.desk.h} rx={8} />
      {isl.seats.map((seat) => {
        if (seat.kind === 'chair' || !seat.staff) return <Chair key={seat.key} seat={seat} chair={seat.chair!} />;
        const task = currentTaskOf(state, seat.staff.id);
        return (
          <StaffGlyph
            key={seat.key}
            seat={seat}
            staff={seat.staff}
            slot={slot}
            state={state.staff[seat.staff.id]}
            taskTitle={task?.title ?? null}
            taskExecutor={task?.executor ?? null}
            selected={selectedId === seat.staff.id}
            animate={animate}
          />
        );
      })}
    </g>
  );
}

interface TipInfo { id: string; cx: number; top: number; bottom: number }

export function OfficeView({ view, index }: { view: DashboardView; index: OrgIndex }) {
  const { selectedId, select, reducedMotion } = useUi();
  const state = view.state;
  const hasUnassigned = unassignedActors(state).length > 0;
  const layout = useMemo(() => computeOfficeLayout(index, { withUnassigned: hasUnassigned }), [index, hasUnassigned]);
  const pending = useMemo(() => pendingApprovals(state), [state]);
  const animate = view.cursor === 'live';
  const [tip, setTip] = useState<TipInfo | null>(null);

  const showTip = useCallback((el: Element) => {
    const id = el.getAttribute('data-actor-id');
    if (!id) return;
    const r = el.getBoundingClientRect();
    setTip((prev) => (prev && prev.id === id ? prev : { id, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom }));
  }, []);
  const hideTip = useCallback(() => setTip(null), []);
  // 툴팁은 화면 기준(fixed) 좌표라서, 어디서든 스크롤하면 숨긴다. 상세 서랍이 열리거나 바뀔 때도 숨긴다.
  useEffect(() => {
    if (!tip) return undefined;
    document.addEventListener('scroll', hideTip, true);
    return () => document.removeEventListener('scroll', hideTip, true);
  }, [tip, hideTip]);
  useEffect(() => { setTip(null); }, [selectedId]);

  const onClick = (e: MouseEvent<SVGSVGElement>): void => {
    const el = (e.target as Element).closest('[data-actor-id]');
    if (el) select(el.getAttribute('data-actor-id'));
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as Element).closest('[data-actor-id]');
    if (el) { e.preventDefault(); select(el.getAttribute('data-actor-id')); }
  };
  const onOver = (e: PointerEvent<SVGSVGElement>): void => {
    if (e.pointerType === 'touch') return;                // 손가락으로 누를 때는 곧바로 상세 서랍이 열린다 — 툴팁은 마우스·키보드용
    const el = (e.target as Element).closest('[data-actor-id]');
    if (el) showTip(el);
  };
  const onOut = (e: PointerEvent<SVGSVGElement>): void => {
    const el = (e.target as Element).closest('[data-actor-id]');
    const to = e.relatedTarget as Node | null;
    if (el && !(to && el.contains(to))) hideTip();
  };
  const onFocus = (e: FocusEvent<SVGSVGElement>): void => {
    const el = (e.target as Element).closest('[data-actor-id]');
    if (el) showTip(el);
  };

  const band = { layout, index, state, pendingCount: pending.length, selectedId };

  return (
    <div className="office">
      <div className="office-scroll">
        <svg
          className="office-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="오피스 평면도"
          onClick={onClick}
          onKeyDown={onKeyDown}
          onPointerOver={onOver}
          onPointerOut={onOut}
          onFocus={onFocus}
          onBlur={hideTip}
        >
          {layout.rooms.map((room) => {
            const dept = index.depts.get(room.deptId);
            if (!dept) return null;
            const slot = index.deptSlot.get(room.deptId) ?? 0;
            const { box } = room;
            return (
              <g key={room.deptId} className="room" data-dept={room.deptId} style={{ ['--dept' as string]: deptVar(slot) }} role="group" aria-label={`${dept.name}, 직원 ${room.staffCount}명`}>
                <rect className="room-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
                <TopBorder box={box} />
                <text className="room-name" x={box.x + 14} y={box.y + 25}>
                  <title>{dept.name}</title>
                  {truncateToWidth(dept.name, box.w - 28, 13)}
                </text>
                <text className="room-sub" x={box.x + 14} y={box.y + 41}>{truncateToWidth(`${dept.head} · ${room.staffCount}명`, box.w - 28, 11)}</text>
                {room.internalNote && room.deptId === INTERNAL_CHECK_DEPT_ID && (
                  <text className="room-note" x={box.x + 14} y={box.y + 57}>{INTERNAL_CHECK_TEXT}</text>
                )}
                {room.islands.map((isl) => (
                  <Island key={isl.team.id} isl={isl} slot={slot} state={state} selectedId={selectedId} animate={animate} />
                ))}
              </g>
            );
          })}
          <CeoRoom {...band} />
          <HqRoom {...band} />
          <UnassignedBox {...band} />
          <HandoffLayer handoffs={state.handoffs} approvals={state.approvals} layout={layout} index={index} animate={animate} reduced={reducedMotion} />
        </svg>
      </div>
      <OfficeLegend />
      {tip && <StaffTip info={tip} index={index} view={view} />}
    </div>
  );
}

function OfficeLegend() {
  const ops: OpStatus[] = ['active', 'building', 'planned'];
  return (
    <div className="legend" role="group" aria-label="범례">
      <ul className="legend-group" aria-label="상태 6종">
        {STAFF_STATUSES.map((s) => <li key={s}><StatusChip status={s} /></li>)}
      </ul>
      <ul className="legend-group" aria-label="운영 상태 3종(도형)">
        {ops.map((op) => (
          <li key={op} className="legend-item"><PersonIcon op={op} color="var(--ink-2)" size={16} />{OP_STATUS_LABEL[op]}</li>
        ))}
      </ul>
      <ul className="legend-group" aria-label="확장 대기">
        <li className="legend-item">
          <svg className="legend-chair" viewBox="0 0 24 20" width={22} height={18} aria-hidden="true" focusable="false">
            <rect x={2} y={2} width={20} height={16} rx={5} />
            <path d="M8 10 H16 M12 6 V14" />
          </svg>
          점선 의자 = 확장 대기
        </li>
      </ul>
    </div>
  );
}

/** 마우스를 올리거나 포커스한 사람의 자세한 정보(직책·id·팀·상태·운영 상태·현재 작업·실행 주체·마지막 메시지). */
function StaffTip({ info, index, view }: { info: TipInfo; index: OrgIndex; view: DashboardView }) {
  const state = view.state;
  const staff = index.staff.get(info.id);
  const s = state.staff[info.id];
  const task = currentTaskOf(state, info.id);
  const width = 292;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = Math.min(Math.max(info.cx, width / 2 + 8), vw - width / 2 - 8);
  const above = info.top > 190;
  const style = { left, top: above ? info.top - 8 : info.bottom + 8, width, transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)' };
  if (!staff) {
    return (
      <div className="tip" role="tooltip" style={style}>
        <div className="tip-head"><b>{index.actorName(info.id)}</b><span className="tip-id">{info.id}</span></div>
        {s && <div className="tip-row"><StatusChip status={s.status} /></div>}
        {task && <div className="tip-row"><span className="tip-k">현재 작업</span>{task.title}</div>}
      </div>
    );
  }
  const team = index.teams.get(staff.team);
  const dept = index.depts.get(staff.dept);
  return (
    <div className="tip" role="tooltip" style={style}>
      <div className="tip-head"><b>{staff.name}</b><span className="tip-id">{staff.id}</span></div>
      <div className="tip-row tip-sub">{[dept?.name, team?.name].filter(Boolean).join(' · ')}</div>
      <div className="tip-row tip-chips"><StatusChip status={s?.status ?? 'idle'} /><OpTag status={staff.status} /></div>
      <div className="tip-row"><span className="tip-k">현재 작업</span>{task ? task.title : '없음'}</div>
      <div className="tip-row"><span className="tip-k">실행 주체</span>{task ? <ExecutorPill executor={task.executor} /> : staff.executors.map((e) => <ExecutorPill key={e} executor={e} />)}</div>
      {s?.lastMessage && <div className="tip-row tip-last"><span className="tip-k">마지막</span>{s.lastMessage}</div>}
    </div>
  );
}
