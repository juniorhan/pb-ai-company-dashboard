// 오피스 평면도의 직원 한 칸(68×78): 사람 도형 + 상태 고리·아이콘 + 이름표 + 실행 주체 알약.
// React.memo — 직원 상태 객체(StaffState)의 참조가 그대로면 다시 그리지 않는다.
import { memo, useEffect, useRef, useState } from 'react';
import type { Executor, OrgStaff, StaffState, StaffStatus } from '../types';
import { EXECUTOR_LABEL } from '../types';
import { GLYPH_CX, GLYPH_HEAD_Y, SEAT_H, SEAT_W } from './officeLayout';
import type { SeatSlot } from './officeLayout';
import { deptVar, PersonPaths, STATUS_ICON } from './primitives';
import { staffAriaLabel } from './selectors';
import { shortLabel } from './textFit';

/** 고리를 두르는 상태(대기·비활성은 고리 없음). */
const RING_STATUSES: ReadonlySet<StaffStatus> = new Set<StaffStatus>(['working', 'reviewing', 'waiting_approval', 'blocked']);
export const RING_R = 19;
const RING_CY = GLYPH_HEAD_Y + 6.5;
const BADGE = { dx: 13.5, dy: -8, r: 6.5 };

/** 상태 배지(작은 원 + 아이콘). 머리 중심 기준 좌표로 놓는다. */
export function StatusBadge({ status, cx, cy, r = BADGE.r }: { status: StaffStatus; cx: number; cy: number; r?: number }) {
  const Icon = STATUS_ICON[status];
  const size = r * 1.35;
  return (
    <g className={`badge badge-${status}`} aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} />
      <Icon x={cx - size / 2} y={cy - size / 2} width={size} height={size} strokeWidth={2.6} className="badge-icon" />
    </g>
  );
}

export interface StaffGlyphProps {
  seat: SeatSlot;
  staff: OrgStaff;
  slot: number;
  state: StaffState | undefined;
  taskTitle: string | null;
  taskExecutor: Executor | null;
  selected: boolean;
  animate: boolean;
}

function StaffGlyphImpl({ seat, staff, slot, state, taskTitle, taskExecutor, selected, animate }: StaffGlyphProps) {
  const status: StaffStatus = state?.status ?? 'idle';
  const seq = state?.changeSeq ?? 0;
  // 상태가 바뀌면 고리가 한 번 퍼진다(600ms). 처음 그릴 때·되감기 중에는 퍼지지 않는다.
  const [pulseKey, setPulseKey] = useState<number | null>(null);
  const prevSeq = useRef(seq);
  useEffect(() => {
    if (prevSeq.current === seq) return undefined;
    prevSeq.current = seq;
    if (!animate) return undefined;
    setPulseKey(seq);
    const timer = setTimeout(() => setPulseKey(null), 700);
    return () => clearTimeout(timer);
  }, [seq, animate]);
  const showPill = (status === 'working' || status === 'reviewing') && taskExecutor !== null;
  const { box } = seat;
  const cx = GLYPH_CX;
  const cy = GLYPH_HEAD_Y;
  return (
    <g
      className={`glyph${selected ? ' is-selected' : ''}`}
      data-actor-id={staff.id}
      data-staff-id={staff.id}
      data-status={status}
      role="button"
      tabIndex={0}
      aria-label={staffAriaLabel(staff, status, taskTitle)}
      transform={`translate(${box.x} ${box.y})`}
      style={{ ['--dept' as string]: deptVar(slot) }}
    >
      <rect className="glyph-hit" x={0} y={0} width={SEAT_W} height={SEAT_H} rx={8} />
      <rect className="glyph-focus" x={1.5} y={1.5} width={SEAT_W - 3} height={SEAT_H - 3} rx={8} />
      {RING_STATUSES.has(status) && <circle className={`ring ring-${status}`} cx={cx} cy={RING_CY} r={RING_R} />}
      {pulseKey !== null && RING_STATUSES.has(status) && <circle key={pulseKey} className={`ring-pulse ring-${status}`} cx={cx} cy={RING_CY} r={RING_R} />}
      <g transform={`translate(${cx} ${cy})`}>
        <PersonPaths op={staff.status} dim={status === 'offline'} />
      </g>
      {status !== 'idle' && <StatusBadge status={status} cx={cx + BADGE.dx} cy={cy + BADGE.dy} />}
      <text className="glyph-name" x={cx} y={58} textAnchor="middle">{shortLabel(staff.name, 7)}</text>
      {showPill && (
        <g className="glyph-pill" transform={`translate(${cx} 63)`}>
          <rect x={-19} y={0} width={38} height={11} rx={5.5} />
          <text x={0} y={8.4} textAnchor="middle">{EXECUTOR_LABEL[taskExecutor]}</text>
        </g>
      )}
    </g>
  );
}

export const StaffGlyph = memo(StaffGlyphImpl);
