// 오피스 가운데 띠: 대표실(대표 자리 · '대표 영역' 칩 · 승인 서류함), AI 총괄 3석, 미배정 상자(필요할 때만).
import { Inbox } from 'lucide-react';
import { CEO_ID } from '../types';
import type { DashboardState, OrgIndex, StaffStatus } from '../types';
import { RING_R, StatusBadge } from './StaffGlyph';
import type { Box, OfficeLayout } from './officeLayout';
import { PersonPaths } from './primitives';
import { runningByExecutor, unassignedActors } from './selectors';
import { truncateToWidth } from './textFit';

/** 방 위쪽 4px 테두리(둥근 모서리를 따라간다). */
export function TopBorder({ box, rx = 10 }: { box: Box; rx?: number }) {
  const { x, y, w } = box;
  const r = rx - 2;
  return <path className="room-top" d={`M${x + 2} ${y + rx} A${r} ${r} 0 0 1 ${x + rx} ${y + 2} H${x + w - rx} A${r} ${r} 0 0 1 ${x + w - 2} ${y + rx}`} />;
}

const RING_STATUSES: ReadonlySet<StaffStatus> = new Set<StaffStatus>(['working', 'reviewing', 'waiting_approval', 'blocked']);

export interface OfficeBandProps {
  layout: OfficeLayout;
  index: OrgIndex;
  state: DashboardState;
  pendingCount: number;
  selectedId: string | null;
}

export function CeoRoom({ layout, index, state, pendingCount, selectedId }: OfficeBandProps) {
  const { ceoRoom: r, ceoSeat: seat, ceoChip: chip, inbox } = layout;
  const ceo = index.org.ceo;
  const status: StaffStatus = state.staff[CEO_ID]?.status ?? 'idle';
  const ownerList = ceo.owner_only.map((o) => o.title);
  const chipLabel = '대표 영역(직원 업무 아님)';
  const ink = { ['--dept' as string]: 'var(--ink)' };
  const cxInbox = inbox.x + inbox.w / 2;
  return (
    <g className="ceo-room" style={ink}>
      <rect className="room-bg" x={r.x} y={r.y} width={r.w} height={r.h} rx={10} />
      <TopBorder box={r} />
      <text className="room-name" x={r.x + 14} y={r.y + 25}>대표실</text>
      <text className="room-sub" x={r.x + 14} y={r.y + 41}>{ceo.title}</text>

      <g
        className={`glyph glyph-ceo${selectedId === CEO_ID ? ' is-selected' : ''}`}
        data-actor-id={CEO_ID}
        data-status={status}
        role="button"
        tabIndex={0}
        aria-label={`${ceo.title}, 대표 자리`}
        transform={`translate(${seat.x} ${seat.y})`}
      >
        <rect className="glyph-hit" x={-34} y={-34} width={68} height={104} rx={8} />
        <rect className="glyph-focus" x={-32.5} y={-32.5} width={65} height={101} rx={8} />
        {RING_STATUSES.has(status) && <circle className={`ring ring-${status}`} cx={0} cy={9.4} r={RING_R * 1.45} />}
        <g transform="scale(1.45)"><PersonPaths op="active" /></g>
        {status !== 'idle' && <StatusBadge status={status} cx={24} cy={-14} r={8} />}
        <text className="glyph-name ceo-name" x={0} y={50} textAnchor="middle">{ceo.title}</text>
      </g>

      <g className="ceo-chip" tabIndex={0} role="group" aria-label={`${chipLabel}: ${ownerList.join(', ')}`}>
        <title>{`${chipLabel}\n${ownerList.map((t) => `· ${t}`).join('\n')}`}</title>
        <rect x={chip.x} y={chip.y} width={chip.w} height={chip.h} rx={chip.h / 2} />
        <text x={chip.x + chip.w / 2} y={chip.y + 17} textAnchor="middle">{chipLabel}</text>
      </g>
      {ownerList.slice(0, 4).map((t, i) => (
        <text key={t} className="ceo-owner" x={chip.x + 6} y={chip.y + 46 + i * 15}>{`· ${truncateToWidth(t, chip.w + 8, 10)}`}</text>
      ))}

      <g className={`inbox${pendingCount > 0 ? ' has-pending' : ''}`} role="img" aria-label={`대표 승인 서류함, 대기 ${pendingCount}건`}>
        <title>{`대표 승인 서류함 — 대기 ${pendingCount}건`}</title>
        <rect className="inbox-glow" x={inbox.x} y={inbox.y} width={inbox.w} height={inbox.h} rx={12} />
        <Inbox x={cxInbox - 26} y={inbox.y + 16} width={52} height={52} strokeWidth={1.4} className="inbox-icon" />
        <text className="inbox-label" x={cxInbox} y={inbox.y + 86} textAnchor="middle">승인 서류함</text>
        <text className="inbox-count-text" x={cxInbox} y={inbox.y + 101} textAnchor="middle">{`대기 ${pendingCount}건`}</text>
        <g className="inbox-badge">
          <circle cx={cxInbox + 26} cy={inbox.y + 18} r={11} />
          <text x={cxInbox + 26} y={inbox.y + 22.5} textAnchor="middle">{pendingCount > 99 ? '99+' : pendingCount}</text>
        </g>
      </g>
    </g>
  );
}

export function HqRoom({ layout, index, state, selectedId }: OfficeBandProps) {
  const { hqRoom: r, hqSeats } = layout;
  const running = runningByExecutor(state);
  const neutral = { ['--dept' as string]: 'var(--ink-2)' };
  return (
    <g className="hq-room" style={neutral}>
      <rect className="room-bg" x={r.x} y={r.y} width={r.w} height={r.h} rx={10} />
      <TopBorder box={r} />
      <text className="room-name" x={r.x + 14} y={r.y + 25}>AI 총괄</text>
      <text className="room-sub" x={r.x + 14} y={r.y + 41}>지금 이 실행 주체로 돌고 있는 작업 수</text>
      {hqSeats.map((seat) => {
        const hq = index.org.hq.find((h) => h.id === seat.id)!;
        const status: StaffStatus = state.staff[hq.id]?.status ?? 'idle';
        const n = running[hq.executor];
        const roleShort = hq.role.split(/[.,(]/)[0]!.trim();
        const w = seat.box.w;
        return (
          <g
            key={hq.id}
            className={`glyph glyph-hq${selectedId === hq.id ? ' is-selected' : ''}`}
            data-actor-id={hq.id}
            data-status={status}
            role="button"
            tabIndex={0}
            aria-label={`${hq.name}, AI 총괄, 진행 중 작업 ${n}건`}
            transform={`translate(${seat.box.x} ${seat.box.y})`}
          >
            <title>{`${hq.name} — ${hq.role}`}</title>
            <rect className="glyph-hit" x={2} y={0} width={w - 4} height={seat.box.h} rx={8} />
            <rect className="glyph-focus" x={3.5} y={1.5} width={w - 7} height={seat.box.h - 3} rx={8} />
            {RING_STATUSES.has(status) && <rect className={`ring ring-${status}`} x={w / 2 - 22} y={2} width={44} height={44} rx={12} />}
            <rect className="hq-chip" x={w / 2 - 18} y={6} width={36} height={36} rx={9} />
            <text className="hq-ai" x={w / 2} y={30} textAnchor="middle">AI</text>
            {status !== 'idle' && <StatusBadge status={status} cx={w / 2 + 20} cy={4} r={7} />}
            <text className="glyph-name hq-name" x={w / 2} y={64} textAnchor="middle">{hq.name}</text>
            <text className="hq-role" x={w / 2} y={78} textAnchor="middle">{truncateToWidth(roleShort, w - 12, 10)}</text>
            <g className={`hq-running${n > 0 ? ' is-busy' : ''}`}>
              <rect x={w / 2 - 28} y={86} width={56} height={17} rx={8.5} />
              <text x={w / 2} y={98} textAnchor="middle">{`진행 ${n}건`}</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

export function UnassignedBox({ layout, index, state, selectedId }: OfficeBandProps) {
  const box = layout.unassigned;
  if (!box) return null;
  const ids = unassignedActors(state);
  const shown = ids.slice(0, 5);
  const maxW = box.w - 36;
  return (
    <g className="unassigned" role="group" aria-label={`미배정 행위자 ${ids.length}명`}>
      <rect className="unassigned-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
      <text className="room-name" x={box.x + 14} y={box.y + 25}>미배정</text>
      <text className="room-sub" x={box.x + 14} y={box.y + 41}>담당을 찾지 못한 행위자</text>
      {shown.map((id, i) => {
        const label = truncateToWidth(index.actorName(id), maxW, 11);
        return (
          <g
            key={id}
            className={`glyph glyph-unassigned${selectedId === id ? ' is-selected' : ''}`}
            data-actor-id={id}
            role="button"
            tabIndex={0}
            aria-label={`${index.actorName(id)}, 담당 미배정`}
            transform={`translate(${box.x + 10} ${box.y + 52 + i * 22})`}
          >
            <title>{index.actorName(id)}</title>
            <rect className="glyph-hit" x={0} y={0} width={box.w - 20} height={20} rx={6} />
            <rect className="glyph-focus" x={1} y={1} width={box.w - 22} height={18} rx={6} />
            <circle className="unassigned-dot" cx={9} cy={10} r={4} />
            <text x={20} y={14} className="unassigned-item">{label}</text>
          </g>
        );
      })}
      {ids.length > shown.length && <text className="room-sub" x={box.x + 14} y={box.y + box.h - 10}>{`외 ${ids.length - shown.length}명`}</text>}
      {ids.length === 0 && <text className="room-sub" x={box.x + 14} y={box.y + 66}>없음</text>}
    </g>
  );
}
