import { describe, expect, it } from 'vitest';
import bundledOrg from '../../data/org.json';
import { indexOrg, parseOrg } from '../../data/org';
import { pendingApprovals, runningByExecutor, openTaskCount } from '../selectors';
import { parseTs } from '../format';
import { createMockStore } from './mockStore';

const index = indexOrg(parseOrg(bundledOrg));

describe('mockStore(개발용 가짜 스토어)', () => {
  it('미리 돌린 기록이 있고, 바뀐 것이 없으면 같은 view 객체를 준다', () => {
    const store = createMockStore(index, { autoRun: false, seed: 1, prerun: 80 });
    const v = store.getView();
    expect(v.state.seq).toBeGreaterThan(50);
    expect(v.state.feed.length).toBeGreaterThan(30);
    expect(v.range.start).not.toBeNull();
    expect(parseTs(v.range.end)!).toBeGreaterThan(parseTs(v.range.start)!);
    expect(v.density).toHaveLength(60);
    expect(v.density.reduce((a, b) => a + b, 0)).toBe(v.state.seq);
    expect(store.getView()).toBe(v);
    expect(v.source.kind).toBe('sim');
    expect(v.source.live).toBe(false);
    store.dispose();
  });

  it('같은 시드는 같은 이벤트 열을 만든다', () => {
    const a = createMockStore(index, { autoRun: false, seed: 7, prerun: 60 });
    const b = createMockStore(index, { autoRun: false, seed: 7, prerun: 60 });
    const ids = (s: typeof a) => s.getView().state.feed.map((f) => `${f.event.type}:${f.event.staff_id}:${f.event.ts}`);
    expect(ids(a)).toEqual(ids(b));
    a.dispose();
    b.dispose();
  });

  it('오래 돌려도 상태가 어긋나지 않는다(작업 중인 직원은 현재 작업이 있다 · 시각은 오름차순)', () => {
    const store = createMockStore(index, { autoRun: false, seed: 3, prerun: 0 });
    store.advance(400);
    const { state } = store.getView();
    for (const id in state.staff) {
      const s = state.staff[id]!;
      if (s.status === 'working' || s.status === 'reviewing') expect(s.currentTaskId, id).not.toBeNull();
      if (s.currentTaskId) expect(state.tasks[s.currentTaskId], id).toBeDefined();
    }
    const ts = state.feed.map((f) => parseTs(f.event.ts)!);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
    expect(state.metrics.completed).toBeGreaterThan(0);
    expect(state.metrics.savedMinutes).toBeGreaterThan(0);
    expect(Object.values(state.metrics.createdByExecutor).reduce((a, b) => a + b, 0)).toBeGreaterThan(5);
    expect(state.handoffs.length).toBeGreaterThan(0);
    expect(Object.values(runningByExecutor(state)).reduce((a, b) => a + b, 0)).toBe(openTaskCount(state));
    store.dispose();
  });

  it('승인 대기가 생기고, decide로 결정하면 레인에서 내려가며 대표 → 요청자 전달이 남는다', () => {
    const store = createMockStore(index, { autoRun: false, seed: 11, prerun: 0 });
    store.source.control!.setAutoApprove(false);
    let guard = 0;
    while (pendingApprovals(store.getView().state).length === 0 && guard++ < 800) store.advance(1);
    const pending = pendingApprovals(store.getView().state);
    expect(pending.length).toBeGreaterThan(0);
    const target = pending[0]!;
    store.source.decide!(target.id, 'approve');
    const after = store.getView().state;
    expect(after.approvals[target.id]!.status).toBe('approved');
    const last = after.handoffs[after.handoffs.length - 1]!;
    expect(last.kind).toBe('decision');
    expect(last.from).toBe('ceo');
    expect(last.to).toBe(target.requestedBy);
    store.dispose();
  });

  it('되감기: 지난 시각으로 가면 그때의 상태, live로 돌아오면 최신', () => {
    const store = createMockStore(index, { autoRun: false, seed: 5, prerun: 90 });
    const live = store.getView();
    const mid = new Date((parseTs(live.range.start)! + parseTs(live.range.end)!) / 2).toISOString();
    store.setCursor(mid);
    const past = store.getView();
    expect(past.cursor).toBe(mid);
    expect(past.state.seq).toBeLessThan(live.state.seq);
    expect(past.state.seq).toBeGreaterThan(0);
    store.setCursor('live');
    expect(store.getView().state.seq).toBe(live.state.seq);
    store.dispose();
  });

  it('시나리오를 바꾸면 처음부터 다시 만들고 onReset을 부른다', () => {
    const store = createMockStore(index, { autoRun: false, seed: 5, prerun: 30 });
    let resets = 0;
    store.source.onReset!(() => { resets += 1; });
    store.source.control!.setScenario('closing-briefing');
    expect(resets).toBe(1);
    expect(store.source.control!.getScenario()).toBe('closing-briefing');
    expect(store.getView().state.feed[0]!.event.ts.slice(11, 13)).toBe('15');
    store.dispose();
  });

  it('unassignedEvery를 켜면 조직에 없는 행위자가 생긴다', () => {
    const store = createMockStore(index, { autoRun: false, seed: 5, prerun: 40, unassignedEvery: 7 });
    const { state } = store.getView();
    expect(Object.values(state.staff).some((s) => !s.known)).toBe(true);
    expect(state.warnings.length).toBeGreaterThan(0);
    store.dispose();
  });

  it('파일 열기 오류 흉내: kind=file이면 control·decide가 없고 상태가 error다', () => {
    const store = createMockStore(index, { autoRun: false, prerun: 0, kind: 'file', label: 'x.jsonl', error: '읽을 수 없음' });
    expect(store.source.control).toBeUndefined();
    expect(store.source.decide).toBeUndefined();
    const v = store.getView();
    expect(v.source.kind).toBe('file');
    expect(v.source.status.state).toBe('error');
    store.dispose();
  });
});
