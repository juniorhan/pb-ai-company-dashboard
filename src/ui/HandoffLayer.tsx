// 일감 전달 애니메이션(docs/DESIGN.md §4.2): handoffs에서 seq를 처음 보는 항목마다 출발 좌석 → 도착 좌석을
// 2차 베지어 점선 위로 점이 1.2초 동안 이동하고, 도착하면 펄스. 동시에 최대 12개.
// 움직임 줄이기면 이동 없이 0.8초짜리 화살표만, 되감기 중에는 만들지 않는다.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CEO_ID } from '../types';
import type { ApprovalState, HandoffItem, OrgIndex } from '../types';
import { anchorOfActor, INBOX_ANCHOR } from './officeLayout';
import type { OfficeLayout, Point } from './officeLayout';
import { deptColorOf } from './primitives';

export const HANDOFF_MS = 1200;
export const ARRIVE_MS = 600;
export const REDUCED_MS = 800;
export const MAX_ACTIVE = 12;

type Mark = 'dot' | 'check' | 'x';
interface Active { key: number; from: Point; to: Point; ctrl: Point; color: string; mark: Mark }

/** 두 점 사이 곡선의 제어점: 중점에서 위쪽으로 휜다. */
export function curveControl(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const bow = Math.min(70, dist * 0.22);
  return { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow };
}

export function bezierPoint(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

function build(h: HandoffItem, layout: OfficeLayout, index: OrgIndex, approvals: Record<string, ApprovalState>): Active | null {
  let from: Point | null;
  let to: Point | null;
  let mark: Mark = 'dot';
  let color: string;
  if (h.kind === 'approval') {                          // 승인 요청 → 대표 서류함
    from = anchorOfActor(layout, h.from);
    to = layout.anchors.get(INBOX_ANCHOR) ?? null;
    color = deptColorOf(index, index.actorDept(h.from));
  } else if (h.kind === 'decision') {                   // 승인 결정: 대표 → 요청자(체크/엑스 점)
    from = layout.anchors.get(CEO_ID) ?? null;
    to = anchorOfActor(layout, h.to);
    color = 'var(--ink)';
    const ap = Object.values(approvals).find((a) => a.taskId === h.taskId && a.decidedAt === h.ts);
    mark = ap?.status === 'rejected' ? 'x' : 'check';
  } else {
    from = anchorOfActor(layout, h.from);
    to = anchorOfActor(layout, h.to);
    color = deptColorOf(index, index.actorDept(h.from));
  }
  if (!from || !to || (from.x === to.x && from.y === to.y)) return null;
  return { key: h.seq, from, to, ctrl: curveControl(from, to), color, mark };
}

const HandoffAnim = memo(function HandoffAnim({ item, reduced, onDone }: { item: Active; reduced: boolean; onDone: (key: number) => void }) {
  const dotRef = useRef<SVGGElement>(null);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (reduced) {
      const t = setTimeout(() => onDone(item.key), REDUCED_MS);
      return () => clearTimeout(t);
    }
    let raf = 0;
    let done: ReturnType<typeof setTimeout> | undefined;
    const t0 = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / HANDOFF_MS);
      const p = bezierPoint(item.from, item.ctrl, item.to, easeOut(t));
      dotRef.current?.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      if (t < 1) raf = requestAnimationFrame(tick);
      else { setArrived(true); done = setTimeout(() => onDone(item.key), ARRIVE_MS); }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); if (done) clearTimeout(done); };
  }, [item, reduced, onDone]);

  const { from, to, ctrl, color, mark } = item;
  if (reduced) {
    // 이동 없이 0.8초짜리 화살표만
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const head = (a: number): string => `${(to.x - 8 * Math.cos(ang + a)).toFixed(1)},${(to.y - 8 * Math.sin(ang + a)).toFixed(1)}`;
    return (
      <g className="handoff-arrow">
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        <polygon points={`${to.x.toFixed(1)},${to.y.toFixed(1)} ${head(0.45)} ${head(-0.45)}`} />
      </g>
    );
  }
  return (
    <g className={`handoff${arrived ? ' is-arrived' : ''}`} style={{ ['--dept' as string]: color }}>
      <path className="handoff-path" d={`M${from.x} ${from.y} Q${ctrl.x} ${ctrl.y} ${to.x} ${to.y}`} />
      <g ref={dotRef} className={`handoff-dot is-${mark}`} transform={`translate(${from.x} ${from.y})`}>
        {mark === 'dot' ? (
          <circle r={4} />
        ) : (
          <>
            <circle r={6.5} />
            <path d={mark === 'check' ? 'M-3 0.2 L-0.8 2.6 L3.4 -2.4' : 'M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6'} />
          </>
        )}
      </g>
      {arrived && <circle className="handoff-pulse" cx={to.x} cy={to.y} r={14} />}
    </g>
  );
});

export interface HandoffLayerProps {
  handoffs: HandoffItem[];
  approvals: Record<string, ApprovalState>;
  layout: OfficeLayout;
  index: OrgIndex;
  /** false면(되감기 중) 새로 만들지 않고 떠 있는 것도 치운다 */
  animate: boolean;
  reduced: boolean;
}

export function HandoffLayer({ handoffs, approvals, layout, index, animate, reduced }: HandoffLayerProps) {
  const seen = useRef<number | null>(null);
  const wasAnimating = useRef(true);
  const [active, setActive] = useState<Active[]>([]);

  useEffect(() => {
    const max = handoffs.reduce((m, h) => Math.max(m, h.seq), -1);
    const resumed = animate && !wasAnimating.current;       // 되감기에서 실시간으로 막 돌아왔다
    wasAnimating.current = animate;
    // 처음 그릴 때(지난 기록은 다시 보여 주지 않는다)·기록이 처음부터 다시 시작될 때·되감기 중·되감기에서 돌아온 직후
    if (seen.current === null || max < seen.current || !animate || resumed) {
      seen.current = max;
      if (!animate) setActive((prev) => (prev.length ? [] : prev));
      return;
    }
    const fresh = handoffs.filter((h) => h.seq > (seen.current ?? -1));
    seen.current = max;
    if (!fresh.length) return;
    const items: Active[] = [];
    for (const h of fresh.slice(-MAX_ACTIVE)) {
      const a = build(h, layout, index, approvals);
      if (a) items.push(a);
    }
    if (items.length) setActive((prev) => [...prev, ...items].slice(-MAX_ACTIVE));
  }, [handoffs, animate, layout, index, approvals]);

  const remove = useCallback((key: number) => setActive((prev) => prev.filter((a) => a.key !== key)), []);

  return (
    <g className="handoff-layer" pointerEvents="none" aria-hidden="true">
      {active.map((a) => <HandoffAnim key={a.key} item={a} reduced={reduced} onDone={remove} />)}
    </g>
  );
}
