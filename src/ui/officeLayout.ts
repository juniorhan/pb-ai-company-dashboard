// 오피스 평면도 배치(순수 함수). 본부·팀·직원 수가 바뀌어도 겹치지 않게 데이터에서 계산한다(docs/DESIGN.md §4.2).
import { CEO_ID } from '../types';
import type { OrgExpansion, OrgIndex, OrgStaff, OrgTeam } from '../types';

export const OFFICE_W = 1200;
export const OFFICE_PAD = 16;
export const ROOM_GAP = 12;
export const SEAT_W = 68;
export const SEAT_H = 78;
export const MAX_COLS = 4;
export const MIN_ROOM_W = 220;
export const ROOM_PAD = 10;
export const ROOM_HEAD_H = 46;
export const ROOM_NOTE_H = 16;
export const ISLAND_HEAD_H = 18;
export const DESK_PAD = 4;
export const ISLAND_GAP = 10;
export const MIN_ISLAND_W = 100;
export const BAND_H = 176;
export const CEO_ROOM_W = 440;
export const UNASSIGNED_W = 176;

/** 이 본부 id의 방에만 '내부 검사이며 실제 준법 승인이 아님'을 단다. 조직에 없으면 표시하지 않는다. */
export const INTERNAL_CHECK_DEPT_ID = 'rsk';
/** 승인 요청이 가는 곳(대표 서류함)과 미배정 상자의 anchors 키. */
export const INBOX_ANCHOR = '@inbox';
export const UNASSIGNED_ANCHOR = '@unassigned';

/** 좌석 칸 안에서 사람 도형의 위치(머리 중심). */
export const GLYPH_CX = SEAT_W / 2;
export const GLYPH_HEAD_Y = 22;
/** 일감 전달 곡선이 붙는 지점 = 머리 중심에서 아래로 6. */
export const GLYPH_ANCHOR_DY = 6;

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

export interface SeatSlot {
  kind: 'staff' | 'chair';
  key: string;                 // 직원 id 또는 확장 대기 키
  staff: OrgStaff | null;
  chair: OrgExpansion | null;
  box: Box;                    // 68×78 칸(절대 좌표)
}
export interface IslandLayout { team: OrgTeam; box: Box; desk: Box; seats: SeatSlot[] }
export interface RoomLayout {
  deptId: string;
  box: Box;
  headH: number;               // 본부명·본부장·(내부 검사 문구) 머리 높이
  internalNote: boolean;
  islands: IslandLayout[];
  seatCount: number;           // 직원 + 확장 대기
  staffCount: number;          // 직원만
}
export interface HqSeat { id: string; box: Box; center: Point }
export interface OfficeLayout {
  width: number;
  height: number;
  rooms: RoomLayout[];
  band: Box;
  ceoRoom: Box;
  ceoSeat: Point;              // 대표 머리 중심
  ceoChip: Box;
  inbox: Box;
  hqRoom: Box;
  hqSeats: HqSeat[];
  unassigned: Box | null;
  anchors: ReadonlyMap<string, Point>;
}

/* ───────────── 계산 도우미 ───────────── */

/** 항목을 한 줄에 maxPerRow개 이하가 되게 가능한 한 고르게 줄로 나눈다. */
export function chunkRows<T>(items: readonly T[], maxPerRow: number): T[][] {
  if (items.length === 0) return [];
  const rows = Math.ceil(items.length / Math.max(1, maxPerRow));
  const base = Math.floor(items.length / rows);
  const extra = items.length % rows;
  const out: T[][] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const n = base + (r < extra ? 1 : 0);
    out.push(items.slice(i, i + n));
    i += n;
  }
  return out;
}

/** 방 너비를 좌석 수(weights)에 비례해 나누되 min 아래로는 줄이지 않는다. 합은 total(정수)이다. */
export function allocateWidths(weights: readonly number[], total: number, min: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => Math.max(1, x));
  const fixed = new Array<boolean>(n).fill(false);
  const out = new Array<number>(n).fill(min);
  let remaining = total;
  for (let guard = 0; guard <= n; guard++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (!fixed[i]) sum += w[i]!;
    if (sum === 0) break;
    const under: number[] = [];
    for (let i = 0; i < n; i++) if (!fixed[i] && (remaining * w[i]!) / sum < min) under.push(i);
    if (under.length === 0) {
      for (let i = 0; i < n; i++) if (!fixed[i]) out[i] = (remaining * w[i]!) / sum;
      break;
    }
    for (const i of under) { fixed[i] = true; out[i] = min; }
    remaining -= min * under.length;
  }
  const ints = out.map((x) => Math.floor(x));
  let diff = total - ints.reduce((a, b) => a + b, 0);
  if (diff > 0) {
    let widest = 0;
    for (let i = 1; i < n; i++) if (ints[i]! > ints[widest]!) widest = i;
    ints[widest] = ints[widest]! + diff;
    diff = 0;
  }
  return ints;
}

interface TeamSeats { team: OrgTeam; staff: OrgStaff[]; chairs: OrgExpansion[] }
interface RelIsland { team: OrgTeam; x: number; y: number; w: number; h: number; deskW: number; deskH: number; cols: number; items: { staff: OrgStaff | null; chair: OrgExpansion | null; key: string }[] }
interface Packed { islands: RelIsland[]; height: number }

/** 한 줄 열(가장 좁은 팀 섬 = 좌석 2개) 최소 너비 — 열 수 상한을 정한다. */
const MIN_COL_W = 2 * SEAT_W + 2 * DESK_PAD;

/** 팀 섬을 k개 열에 '가장 낮은 열부터' 쌓는다(조직 순서 유지). 좌표는 방 안쪽 영역의 왼쪽 위 기준. */
function packColumns(teams: TeamSeats[], innerW: number, k: number): Packed {
  const colW = Math.floor((innerW - (k - 1) * ISLAND_GAP) / k);
  const colsMax = Math.max(1, Math.floor((colW - 2 * DESK_PAD) / SEAT_W));
  const colY = new Array<number>(k).fill(0);
  const islands: RelIsland[] = [];
  for (const t of teams) {
    const items = [
      ...t.staff.map((s) => ({ staff: s as OrgStaff | null, chair: null as OrgExpansion | null, key: s.id })),
      ...t.chairs.map((c, i) => ({ staff: null as OrgStaff | null, chair: c as OrgExpansion | null, key: `chair:${t.team.id}:${i}` })),
    ];
    if (items.length === 0) continue;                       // 좌석이 하나도 없는 팀은 섬을 만들지 않는다
    const cols = Math.max(1, Math.min(MAX_COLS, items.length, colsMax));
    const rows = Math.ceil(items.length / cols);
    const deskW = Math.min(colW, Math.max(MIN_ISLAND_W, cols * SEAT_W + 2 * DESK_PAD));
    const deskH = rows * SEAT_H + 2 * DESK_PAD;
    let c = 0;
    for (let i = 1; i < k; i++) if (colY[i]! < colY[c]!) c = i;
    islands.push({ team: t.team, x: c * (colW + ISLAND_GAP), y: colY[c]!, w: deskW, h: ISLAND_HEAD_H + deskH, deskW, deskH, cols, items });
    colY[c] = colY[c]! + ISLAND_HEAD_H + deskH + ISLAND_GAP;
  }
  return { islands, height: islands.length ? Math.max(...colY) - ISLAND_GAP : 0 };
}

/** 열 수를 1부터 늘려 가며 가장 낮게 나오는 배치를 고른다(같으면 열이 적은 쪽). */
function packIslands(teams: TeamSeats[], innerW: number): Packed {
  const kMax = Math.max(1, Math.floor((innerW + ISLAND_GAP) / (MIN_COL_W + ISLAND_GAP)));
  let best = packColumns(teams, innerW, 1);
  for (let k = 2; k <= kMax; k++) {
    const cand = packColumns(teams, innerW, k);
    if (cand.height < best.height) best = cand;
  }
  return best;
}

interface RoomPlan { deptId: string; seatCount: number; staffCount: number; internalNote: boolean; headH: number; teams: TeamSeats[] }

function planRoom(index: OrgIndex, deptId: string): RoomPlan {
  const teams: TeamSeats[] = (index.teamsByDept.get(deptId) ?? []).map((team) => ({
    team,
    staff: index.staffByTeam.get(team.id) ?? [],
    chairs: index.expansionByTeam.get(team.id) ?? [],
  }));
  const seatCount = teams.reduce((n, t) => n + t.staff.length + t.chairs.length, 0);
  const staffCount = teams.reduce((n, t) => n + t.staff.length, 0);
  const internalNote = deptId === INTERNAL_CHECK_DEPT_ID;
  return { deptId, seatCount, staffCount, internalNote, headH: ROOM_HEAD_H + (internalNote ? ROOM_NOTE_H : 0), teams };
}

/** 방 높이 = 머리 + 안쪽 여백 + 섬 배치 높이. */
const roomHeight = (plan: RoomPlan, packed: Packed): number => plan.headH + 2 * ROOM_PAD + packed.height;

/**
 * 같은 줄의 방 너비를 다듬는다. 좌석 수 비례(allocateWidths)가 출발점이고(DESIGN §4.2),
 * 줄에서 가장 높은 방에 이웃 방의 너비를 조금 옮기면 줄 높이가 낮아질 때만 옮긴다(최소 너비는 지킨다).
 */
function balanceWidths(plans: RoomPlan[], widths: number[]): number[] {
  const STEPS = [17, 34, 68, 102, 136];
  const heightAt = (i: number, w: number): number => roomHeight(plans[i]!, packIslands(plans[i]!.teams, w - 2 * ROOM_PAD));
  let ws = widths.slice();
  let heights = ws.map((w, i) => heightAt(i, w));
  for (let guard = 0; guard < 30 && ws.length > 1; guard++) {
    const max = Math.max(...heights);
    const tallest = heights.indexOf(max);
    let bestMax = max;
    let move: { donor: number; step: number } | null = null;
    for (let d = 0; d < ws.length; d++) {
      if (d === tallest) continue;
      for (const step of STEPS) {
        if (ws[d]! - step < MIN_ROOM_W) continue;
        const others = heights.reduce((m, h, i) => (i === tallest || i === d ? m : Math.max(m, h)), 0);
        const nextMax = Math.max(heightAt(tallest, ws[tallest]! + step), heightAt(d, ws[d]! - step), others);
        if (nextMax < bestMax - 1e-6) { bestMax = nextMax; move = { donor: d, step }; }
      }
    }
    if (!move) break;
    ws = ws.slice();
    ws[tallest] = ws[tallest]! + move.step;
    ws[move.donor] = ws[move.donor]! - move.step;
    heights = ws.map((w, i) => heightAt(i, w));
  }
  return ws;
}

export function seatAnchor(box: Box): Point {
  return { x: box.x + GLYPH_CX, y: box.y + GLYPH_HEAD_Y + GLYPH_ANCHOR_DY };
}

/* ───────────── 본체 ───────────── */

export function computeOfficeLayout(index: OrgIndex, opts: { withUnassigned?: boolean } = {}): OfficeLayout {
  const { org } = index;
  const innerTotal = OFFICE_W - 2 * OFFICE_PAD;
  const maxPerRow = Math.max(1, Math.floor((innerTotal + ROOM_GAP) / (MIN_ROOM_W + ROOM_GAP)));
  const nTop = Math.ceil(org.depts.length / 2);
  const plans = org.depts.map((d) => planRoom(index, d.id));
  const topRows = chunkRows(plans.slice(0, nTop), maxPerRow);
  const bottomRows = chunkRows(plans.slice(nTop), maxPerRow);

  const rooms: RoomLayout[] = [];
  const anchors = new Map<string, Point>();
  let y = OFFICE_PAD;

  const placeRows = (rows: RoomPlan[][]) => {
    for (const row of rows) {
      const avail = innerTotal - (row.length - 1) * ROOM_GAP;
      const widths = balanceWidths(row, allocateWidths(row.map((p) => p.seatCount), avail, MIN_ROOM_W));
      const packed = row.map((p, i) => packIslands(p.teams, widths[i]! - 2 * ROOM_PAD));
      const heights = row.map((p, i) => roomHeight(p, packed[i]!));
      const rowH = Math.max(...heights);
      let x = OFFICE_PAD;
      row.forEach((plan, i) => {
        const w = widths[i]!;
        const islands: IslandLayout[] = packed[i]!.islands.map((rel) => {
          const ix = x + ROOM_PAD + rel.x;
          const iy = y + plan.headH + ROOM_PAD + rel.y;
          const desk: Box = { x: ix, y: iy + ISLAND_HEAD_H, w: rel.deskW, h: rel.deskH };
          const offsetX = (rel.deskW - rel.cols * SEAT_W) / 2;           // 좌석 묶음을 책상 가운데에 놓는다
          const seats: SeatSlot[] = rel.items.map((item, k) => {
            const col = k % rel.cols;
            const rowIdx = Math.floor(k / rel.cols);
            const box: Box = { x: desk.x + offsetX + col * SEAT_W, y: desk.y + DESK_PAD + rowIdx * SEAT_H, w: SEAT_W, h: SEAT_H };
            if (item.staff) anchors.set(item.staff.id, seatAnchor(box));
            return { kind: item.staff ? 'staff' : 'chair', key: item.key, staff: item.staff, chair: item.chair, box };
          });
          return { team: rel.team, box: { x: ix, y: iy, w: rel.w, h: rel.h }, desk, seats };
        });
        rooms.push({ deptId: plan.deptId, box: { x, y, w, h: rowH }, headH: plan.headH, internalNote: plan.internalNote, islands, seatCount: plan.seatCount, staffCount: plan.staffCount });
        x += w + ROOM_GAP;
      });
      y += rowH + ROOM_GAP;
    }
  };

  placeRows(topRows);

  // 가운데 띠: 대표실 · AI 총괄 · (필요할 때만) 미배정
  const band: Box = { x: OFFICE_PAD, y, w: innerTotal, h: BAND_H };
  const ceoRoom: Box = { x: band.x, y, w: Math.min(CEO_ROOM_W, innerTotal), h: BAND_H };
  const ceoSeat: Point = { x: ceoRoom.x + 62, y: ceoRoom.y + 84 };
  const ceoChip: Box = { x: ceoRoom.x + 112, y: ceoRoom.y + 46, w: 184, h: 26 };
  const inbox: Box = { x: ceoRoom.x + ceoRoom.w - 128, y: ceoRoom.y + 44, w: 112, h: 108 };
  const unassigned: Box | null = opts.withUnassigned
    ? { x: band.x + band.w - UNASSIGNED_W, y, w: UNASSIGNED_W, h: BAND_H }
    : null;
  const hqX = ceoRoom.x + ceoRoom.w + ROOM_GAP;
  const hqW = Math.max(0, band.x + band.w - hqX - (unassigned ? UNASSIGNED_W + ROOM_GAP : 0));
  const hqRoom: Box = { x: hqX, y, w: hqW, h: BAND_H };
  const hqCount = org.hq.length;
  const hqSeatW = hqCount ? Math.min(200, (hqW - 28) / hqCount) : 0;
  const hqStart = hqRoom.x + (hqW - hqSeatW * hqCount) / 2;
  const hqSeats: HqSeat[] = org.hq.map((h, i) => {
    const box: Box = { x: hqStart + i * hqSeatW, y: hqRoom.y + 44, w: hqSeatW, h: 112 };
    const center: Point = { x: box.x + box.w / 2, y: box.y + 24 };
    anchors.set(h.id, center);
    return { id: h.id, box, center };
  });
  anchors.set(CEO_ID, { x: ceoSeat.x, y: ceoSeat.y + 8 });
  anchors.set(INBOX_ANCHOR, { x: inbox.x + inbox.w / 2, y: inbox.y + inbox.h / 2 - 6 });
  if (unassigned) anchors.set(UNASSIGNED_ANCHOR, { x: unassigned.x + unassigned.w / 2, y: unassigned.y + unassigned.h / 2 });
  y += BAND_H + ROOM_GAP;

  placeRows(bottomRows);

  const height = y - ROOM_GAP + OFFICE_PAD;
  return { width: OFFICE_W, height, rooms, band, ceoRoom, ceoSeat, ceoChip, inbox, hqRoom, hqSeats, unassigned, anchors };
}

/** 행위자 id → 전달 곡선이 붙는 지점. 대표·AI 총괄·직원은 자기 자리, 그 밖(미배정·조직에 없는 id)은 미배정 상자, 상자가 없으면 null. */
export function anchorOfActor(layout: OfficeLayout, id: string): Point | null {
  return layout.anchors.get(id) ?? layout.anchors.get(UNASSIGNED_ANCHOR) ?? null;
}
