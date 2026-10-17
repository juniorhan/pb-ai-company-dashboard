import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import type { Org, OrgDept, OrgExpansion, OrgIndex, OrgStaff, OrgTeam } from '../types';
import {
  allocateWidths, anchorOfActor, BAND_H, chunkRows, computeOfficeLayout, INBOX_ANCHOR, INTERNAL_CHECK_DEPT_ID, MIN_ROOM_W, OFFICE_W,
  SEAT_H, SEAT_W, UNASSIGNED_ANCHOR,
} from './officeLayout';
import type { Box, OfficeLayout } from './officeLayout';

/** 가짜 조직: 본부마다 팀 목록, 팀마다 [직원 수, 확장 대기 수]. */
function fakeOrg(spec: [staff: number, chairs: number][][], hqCount = 3, deptIds?: string[]): OrgIndex {
  const depts: OrgDept[] = [];
  const teams: OrgTeam[] = [];
  const staff: OrgStaff[] = [];
  const expansion: OrgExpansion[] = [];
  spec.forEach((teamSpecs, i) => {
    const deptId = deptIds?.[i] ?? `d${i + 1}`;
    depts.push({ id: deptId, name: `가짜 본부 ${i + 1}`, head: `본부장 ${i + 1}`, role: '시험용' });
    teamSpecs.forEach(([staffCount, chairCount], j) => {
      const teamId = `${deptId}-t${j + 1}`;
      teams.push({ id: teamId, dept: deptId, name: `가짜 팀 ${i + 1}-${j + 1}`, role: '시험용', status: 'active', phase: 'P0' });
      for (let k = 0; k < staffCount; k++) {
        staff.push({
          id: `${teamId}-e${k + 1}`, team: teamId, dept: deptId, name: `직원 ${i + 1}-${j + 1}-${k + 1}`, role: '시험용', status: 'active', phase: 'P0', risk: 'R0',
          executors: ['claude'], checkers: [], checker_staff: [], duties: [],
        });
      }
      for (let k = 0; k < chairCount; k++) expansion.push({ team: teamId, role: `확장 직책 ${k + 1}`, trigger: '시험 조건' });
    });
  });
  const org: Org = {
    format: 1,
    meta: { generated_at: '2026-10-17T00:00:00.000Z', source: 'fixture', source_hash: 'test', counts: { depts: depts.length, teams: teams.length, staff: staff.length, expansion: expansion.length } },
    ceo: { title: '대표이사', holds: [], owner_only: [] },
    hq: ['claude', 'codex', 'aside'].slice(0, hqCount).map((n) => ({ id: `hq.${n}`, name: n, executor: n as 'claude', role: '시험용' })),
    depts, teams, staff, expansion, legacy: { teams: {}, depts: {} },
  };
  return indexOrg(parseOrg(org));
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 && inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

function expectNoOverlap(boxes: { name: string; box: Box }[]): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i]!.box, boxes[j]!.box), `${boxes[i]!.name} ↔ ${boxes[j]!.name}`).toBe(false);
    }
  }
}

function checkLayout(layout: OfficeLayout, index: OrgIndex): void {
  const page: Box = { x: 0, y: 0, w: layout.width, h: layout.height };
  expect(layout.width).toBe(OFFICE_W);
  expect(layout.rooms).toHaveLength(index.org.depts.length);

  // 큰 구역 — 방·대표실·AI 총괄·미배정이 서로 겹치지 않고 페이지 안에 있다
  const zones: { name: string; box: Box }[] = [
    ...layout.rooms.map((r) => ({ name: `방 ${r.deptId}`, box: r.box })),
    { name: '대표실', box: layout.ceoRoom },
    { name: 'AI 총괄', box: layout.hqRoom },
  ];
  if (layout.unassigned) zones.push({ name: '미배정', box: layout.unassigned });
  expectNoOverlap(zones);
  for (const z of zones) expect(inside(z.box, page), `${z.name} 페이지 안`).toBe(true);
  expect(layout.band.h).toBe(BAND_H);

  let staffSeats = 0;
  let chairs = 0;
  for (const room of layout.rooms) {
    expect(room.box.w).toBeGreaterThanOrEqual(MIN_ROOM_W - 1e-6);
    expectNoOverlap(room.islands.map((i) => ({ name: `섬 ${i.team.id}`, box: i.box })));
    for (const isl of room.islands) {
      expect(inside(isl.box, room.box), `섬 ${isl.team.id}가 방 ${room.deptId} 안`).toBe(true);
      expect(isl.box.y).toBeGreaterThanOrEqual(room.box.y + room.headH - 1e-6);
      expect(inside(isl.desk, isl.box), `책상 ${isl.team.id}`).toBe(true);
      expectNoOverlap(isl.seats.map((s) => ({ name: `좌석 ${s.key}`, box: s.box })));
      for (const seat of isl.seats) {
        expect(seat.box.w).toBe(SEAT_W);
        expect(seat.box.h).toBe(SEAT_H);
        expect(inside(seat.box, isl.desk), `좌석 ${seat.key}가 책상 안`).toBe(true);
        if (seat.kind === 'staff') staffSeats += 1;
        else chairs += 1;
      }
    }
  }
  expect(staffSeats).toBe(index.org.staff.length);
  expect(chairs).toBe(index.org.expansion.length);

  // 전달 곡선이 붙는 지점
  for (const s of index.org.staff) expect(layout.anchors.has(s.id), `anchor ${s.id}`).toBe(true);
  for (const h of index.org.hq) expect(layout.anchors.has(h.id), `anchor ${h.id}`).toBe(true);
  expect(layout.anchors.has('ceo')).toBe(true);
  expect(layout.anchors.has(INBOX_ANCHOR)).toBe(true);
  expect(layout.anchors.has(UNASSIGNED_ANCHOR)).toBe(layout.unassigned !== null);
  for (const [key, p] of layout.anchors) {
    expect(p.x, key).toBeGreaterThanOrEqual(0);
    expect(p.x, key).toBeLessThanOrEqual(layout.width);
    expect(p.y, key).toBeGreaterThanOrEqual(0);
    expect(p.y, key).toBeLessThanOrEqual(layout.height);
  }
}

describe('allocateWidths · chunkRows', () => {
  it('좌석 수에 비례하되 최소 너비를 지키고 합이 정확하다', () => {
    const w = allocateWidths([16, 7, 9], 1130, MIN_ROOM_W);
    expect(w.reduce((a, b) => a + b, 0)).toBe(1130);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(MIN_ROOM_W);
    expect(w[0]).toBeGreaterThan(w[2]!);
    expect(w[2]).toBeGreaterThan(w[1]!);
  });
  it('작은 방은 최소 너비로 고정하고 나머지가 나눈다', () => {
    const w = allocateWidths([1, 1, 40], 1000, 220);
    expect(w[0]).toBe(220);
    expect(w[1]).toBe(220);
    expect(w[2]).toBe(560);
  });
  it('줄은 가능한 한 고르게 나눈다', () => {
    expect(chunkRows([1, 2, 3, 4, 5, 6], 5).map((r) => r.length)).toEqual([3, 3]);
    expect(chunkRows([1, 2, 3, 4, 5], 5).map((r) => r.length)).toEqual([5]);
    expect(chunkRows([], 5)).toEqual([]);
  });
});

describe('computeOfficeLayout', () => {
  it('저장된 조직 사본: 겹침 없음 · 좌석 수 = 직원 수 + 확장 대기', () => {
    const index = indexOrg(parseOrg(bundledOrg));
    checkLayout(computeOfficeLayout(index), index);
    checkLayout(computeOfficeLayout(index, { withUnassigned: true }), index);
  });

  it('가짜 조직 A: 본부 1개·팀 1개·직원 1명', () => {
    const index = fakeOrg([[[1, 0]]]);
    const layout = computeOfficeLayout(index);
    checkLayout(layout, index);
    expect(layout.rooms).toHaveLength(1);
  });

  it('가짜 조직 B: 본부 2개, 크기가 매우 다름(30명 한 팀 / 1명 한 팀)', () => {
    const index = fakeOrg([[[30, 3]], [[1, 0]]]);
    checkLayout(computeOfficeLayout(index), index);
    checkLayout(computeOfficeLayout(index, { withUnassigned: true }), index);
  });

  it('가짜 조직 C: 본부 3개, 팀·직원 수가 제각각 · 직원 없는 팀(확장 대기만)', () => {
    const index = fakeOrg([
      [[3, 1], [0, 2], [5, 0]],
      [[2, 0]],
      [[4, 2], [4, 2], [1, 1], [6, 0], [2, 3]],
    ]);
    checkLayout(computeOfficeLayout(index), index);
  });

  it('가짜 조직 D: 본부 9개(위 5 · 아래 4)', () => {
    const spec: [number, number][][] = [];
    for (let i = 0; i < 9; i++) spec.push(Array.from({ length: 1 + (i % 4) }, (_, j) => [((i * 3 + j * 2) % 6) + 1, (i + j) % 3] as [number, number]));
    const index = fakeOrg(spec);
    const layout = computeOfficeLayout(index, { withUnassigned: true });
    checkLayout(layout, index);
    const aboveBand = layout.rooms.filter((r) => r.box.y < layout.band.y).length;
    expect(aboveBand).toBe(5);
  });

  it('가짜 조직 E: 본부 12개도 줄을 늘려 겹치지 않는다', () => {
    const spec: [number, number][][] = Array.from({ length: 12 }, (_, i) => [[(i % 5) + 1, i % 2], [2, 0]]);
    const index = fakeOrg(spec);
    checkLayout(computeOfficeLayout(index), index);
  });

  it('가짜 조직 F: 본부는 있으나 팀이 없고, AI 총괄이 0·1개', () => {
    const empty = fakeOrg([[], [[2, 0]]], 0);
    checkLayout(computeOfficeLayout(empty), empty);
    const one = fakeOrg([[[2, 1]], [[3, 0]], [[1, 0]]], 1);
    checkLayout(computeOfficeLayout(one, { withUnassigned: true }), one);
  });

  it('본부가 하나도 없어도 대표실·AI 총괄 띠는 그려진다', () => {
    const index = fakeOrg([]);
    const layout = computeOfficeLayout(index);
    checkLayout(layout, index);
    expect(layout.rooms).toHaveLength(0);
  });

  it('내부 검사 문구는 지정한 본부 id의 방에만 붙고, 그 본부가 없으면 어디에도 붙지 않는다', () => {
    const real = indexOrg(parseOrg(bundledOrg));
    const withRsk = computeOfficeLayout(real).rooms.filter((r) => r.internalNote).map((r) => r.deptId);
    expect(withRsk).toEqual(real.depts.has(INTERNAL_CHECK_DEPT_ID) ? [INTERNAL_CHECK_DEPT_ID] : []);
    const fake = fakeOrg([[[2, 0]], [[3, 0]]]);
    expect(computeOfficeLayout(fake).rooms.some((r) => r.internalNote)).toBe(false);
    const renamed = fakeOrg([[[2, 0]], [[3, 0]]], 3, ['x1', INTERNAL_CHECK_DEPT_ID]);
    expect(computeOfficeLayout(renamed).rooms.filter((r) => r.internalNote).map((r) => r.deptId)).toEqual([INTERNAL_CHECK_DEPT_ID]);
  });

  it('같은 조직은 같은 배치(결정적)', () => {
    const index = indexOrg(parseOrg(bundledOrg));
    const a = computeOfficeLayout(index);
    const b = computeOfficeLayout(index);
    expect(JSON.stringify([...a.anchors])).toBe(JSON.stringify([...b.anchors]));
    expect(a.height).toBe(b.height);
  });

  it('anchorOfActor: 직원·대표·AI 총괄은 자기 자리, 모르는 id는 미배정 상자(없으면 null)', () => {
    const index = indexOrg(parseOrg(bundledOrg));
    const first = index.org.staff[0]!.id;
    const plain = computeOfficeLayout(index);
    expect(anchorOfActor(plain, first)).toEqual(plain.anchors.get(first));
    expect(anchorOfActor(plain, 'ceo')).toEqual(plain.anchors.get('ceo'));
    expect(anchorOfActor(plain, 'unassigned:x-01')).toBeNull();
    const withBox = computeOfficeLayout(index, { withUnassigned: true });
    expect(anchorOfActor(withBox, 'unassigned:x-01')).toEqual(withBox.anchors.get(UNASSIGNED_ANCHOR));
  });
});
