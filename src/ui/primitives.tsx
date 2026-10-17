// 여러 화면이 같이 쓰는 작은 조각: 상태 아이콘·칩, 운영 상태 꼬리표, 실행 주체 알약, 사람 도형, 본부 색.
import type { CSSProperties } from 'react';
import { Circle, CircleCheck, CircleX, Hourglass, Moon, OctagonAlert, Pencil, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EXECUTOR_LABEL, OP_STATUS_LABEL, STAFF_STATUS_LABEL, TASK_STATUS_LABEL } from '../types';
import type { Executor, OpStatus, OrgIndex, StaffStatus, TaskStatus } from '../types';
import { taskIconKind } from './selectors';
import type { FeedIconKind } from './selectors';

/** 상태 → 아이콘. 상태는 늘 색 + 아이콘 + 글자로 보여 준다. */
export const STATUS_ICON: Record<StaffStatus, LucideIcon> = {
  working: Pencil,
  reviewing: Search,
  waiting_approval: Hourglass,
  blocked: OctagonAlert,
  idle: Circle,
  offline: Moon,
};
const FEED_ICON: Record<FeedIconKind, LucideIcon> = { ...STATUS_ICON, done: CircleCheck, rejected: CircleX };
const FEED_ICON_LABEL: Record<FeedIconKind, string> = { ...STAFF_STATUS_LABEL, done: '완료', rejected: '반려 종료' };

export function feedIconLabel(kind: FeedIconKind): string {
  return FEED_ICON_LABEL[kind];
}

/** 본부 슬롯 → CSS 변수 참조. 슬롯이 없거나 0이면 무채색. */
export function deptVar(slot: number | undefined | null): string {
  return `var(--dept-${slot && slot >= 1 && slot <= 8 ? slot : 0})`;
}
export function deptColorOf(index: OrgIndex, deptId: string | null | undefined): string {
  return deptVar(deptId ? index.deptSlot.get(deptId) : 0);
}
export const deptStyle = (color: string): CSSProperties => ({ ['--dept' as string]: color });

export function StatusIcon({ kind, size = 14 }: { kind: FeedIconKind; size?: number }) {
  const Icon = FEED_ICON[kind];
  return <Icon className={`st-icon st-${kind}`} size={size} strokeWidth={2.2} aria-hidden="true" />;
}

/** 아이콘 + 글자 칩. */
export function StatusChip({ status }: { status: StaffStatus }) {
  return (
    <span className="status-chip" data-status={status}>
      <StatusIcon kind={status} size={12} />
      {STAFF_STATUS_LABEL[status]}
    </span>
  );
}

/** 작업 상태 칩(제목 옆): 아이콘 + 글자. */
export function TaskChip({ status }: { status: TaskStatus }) {
  return (
    <span className="status-chip task-chip" data-task-status={status}>
      <StatusIcon kind={taskIconKind(status)} size={12} />
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

/** 운영 상태(운영 중·구축 중·운영 전) 꼬리표. */
export function OpTag({ status }: { status: OpStatus }) {
  return <span className="op-tag" data-op={status}>{OP_STATUS_LABEL[status]}</span>;
}

/** 실행 주체 알약(무채색). */
export function ExecutorPill({ executor }: { executor: Executor }) {
  return <span className="exec-pill" data-executor={executor}>{EXECUTOR_LABEL[executor]}</span>;
}

const SHOULDERS = 'M-11 20 A11 11 0 0 1 11 20 Z';

/**
 * 사람 도형의 모양(머리 원 + 어깨 반원). 중심은 머리 중심 (0,0), 폭 22, 높이 −7..20. 운영 상태로 채움이 달라진다.
 * person-shape = 채움(운영 중 본부 색 / 구축 중 50% / 운영 전 점선 테두리), person-edge = 모든 도형에 덮는 1px 진한 테두리(대비 보강).
 */
export function PersonPaths({ op, dim = false }: { op: OpStatus; dim?: boolean }) {
  return (
    <g className="person" data-op={op} opacity={dim ? 0.4 : 1}>
      <circle className="person-shape" cx={0} cy={0} r={7} />
      <path className="person-shape" d={SHOULDERS} />
      <circle className="person-edge" cx={0} cy={0} r={7} />
      <path className="person-edge" d={SHOULDERS} />
    </g>
  );
}

/** HTML 안에서 쓰는 작은 사람 도형. */
export function PersonIcon({ op, color, dim = false, size = 22 }: { op: OpStatus; color: string; dim?: boolean; size?: number }) {
  return (
    <svg className="person-icon" viewBox="-13 -9 26 31" width={size} height={Math.round((size * 31) / 26)} style={deptStyle(color)} aria-hidden="true" focusable="false">
      <PersonPaths op={op} dim={dim} />
    </svg>
  );
}

/** 본부 색 점. */
export function DeptDot({ color }: { color: string }) {
  return <span className="dept-dot" style={deptStyle(color)} aria-hidden="true" />;
}
