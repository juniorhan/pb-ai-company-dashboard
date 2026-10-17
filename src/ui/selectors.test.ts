import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import type { ApprovalState, DashboardState, EventType, PbEvent, StaffState, TaskState } from '../types';
import { formatClock, formatDateTimeKo, formatDuration, formatMonthDay, formatStamp, formatWaited, toKstIso } from './format';
import { firstSegment, shortLabel, truncateToWidth } from './textFit';
import {
  AI_EXECUTORS, blockedTaskCount, currentTaskOf, describeEvent, EMPTY_FEED_FILTER, eventIconKind, executorStats, feedKindOf, FEED_LIMIT,
  feedSubtitle, filterFeed, isFeedFilterActive, openTaskCount, openTasksOfExecutor, pendingApprovals, recentDecisions, recentTasksOf,
  runningByExecutor, staffAriaLabel, staffStatusCounts, statusOf, taskIconKind, taskLastTs, unassignedActors,
} from './selectors';

const index = indexOrg(parseOrg(bundledOrg));
const EDITOR = 'med-01-e01';       // 편집장
const WRITER = 'med-01-e03';       // 정기 브리핑 작가
const CHECKER = 'rsk-01-e02';      // 독립 검사관(다른 회사 모델)

function baseState(partial: Partial<DashboardState> = {}): DashboardState {
  return {
    seq: 0, lastTs: null, staff: {}, tasks: {}, approvals: {}, feed: [], handoffs: [],
    metrics: { day: null, completed: 0, savedMinutes: 0, createdByExecutor: { claude: 0, codex: 0, aside: 0, script: 0, human: 0 } },
    warnings: [], ...partial,
  };
}
const staffState = (id: string, p: Partial<StaffState> = {}): StaffState => ({
  id, known: true, status: 'idle', currentTaskId: null, lastMessage: null, lastTs: null, changeSeq: 0, history: [], recentTaskIds: [], ...p,
});
const task = (id: string, p: Partial<TaskState> = {}): TaskState => ({
  id, title: `작업 ${id}`, owner: WRITER, executor: 'claude', status: 'in_progress', parentTaskId: null, duty: null,
  createdAt: '2026-10-17T06:00:00+09:00', startedAt: null, endedAt: null, manualMinutes: null, humanMinutes: null, history: [], ...p,
});
const approval = (id: string, p: Partial<ApprovalState> = {}): ApprovalState => ({
  id, taskId: 't1', requestedBy: WRITER, summary: '요약', status: 'pending', requestedAt: '2026-10-17T06:00:00+09:00', decidedAt: null, auto: false, ...p,
});
let evSeq = 0;
const ev = (type: EventType, staff_id: string, p: Partial<PbEvent> = {}): PbEvent => ({
  v: 1, event_id: `e${++evSeq}`, ts: '2026-10-17T06:30:00+09:00', type, staff_id, executor: 'claude', task_id: 't1', message: '', ...p,
});

describe('요약 선택자', () => {
  it('상태별 인원은 조직 직원 전원 기준이고 기록 없는 직원은 대기로 센다', () => {
    const n = index.org.staff.length;
    const empty = staffStatusCounts(index, baseState());
    expect(empty.idle).toBe(n);
    expect(Object.values(empty).reduce((a, b) => a + b, 0)).toBe(n);

    const state = baseState({
      staff: {
        [WRITER]: staffState(WRITER, { status: 'working' }),
        [EDITOR]: staffState(EDITOR, { status: 'reviewing' }),
        [CHECKER]: staffState(CHECKER, { status: 'blocked' }),
        ceo: staffState('ceo', { status: 'waiting_approval' }),            // 대표는 세지 않는다
        'hq.claude': staffState('hq.claude', { status: 'working' }),        // AI 총괄도 세지 않는다
        'unassigned:x': staffState('unassigned:x', { known: false, status: 'working' }),
      },
    });
    const c = staffStatusCounts(index, state);
    expect(c.working).toBe(1);
    expect(c.reviewing).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.waiting_approval).toBe(0);
    expect(c.idle).toBe(n - 3);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(n);
  });

  it('본부 id를 주면 그 본부 직원만 센다', () => {
    const med = index.org.staff.filter((s) => s.dept === 'med').length;
    const c = staffStatusCounts(index, baseState({ staff: { [WRITER]: staffState(WRITER, { status: 'working' }) } }), 'med');
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(med);
    expect(c.working).toBe(1);
    expect(staffStatusCounts(index, baseState({ staff: { [WRITER]: staffState(WRITER, { status: 'working' }) } }), 'inv').working).toBe(0);
  });

  it('진행 중 작업은 완료·반려 종료만 뺀다', () => {
    const state = baseState({
      tasks: {
        a: task('a', { status: 'created' }), b: task('b', { status: 'in_progress' }), c: task('c', { status: 'in_review' }),
        d: task('d', { status: 'waiting_approval' }), e: task('e', { status: 'blocked' }),
        f: task('f', { status: 'completed' }), g: task('g', { status: 'rejected' }),
      },
    });
    expect(openTaskCount(state)).toBe(5);
    expect(blockedTaskCount(state)).toBe(1);
    expect(openTaskCount(baseState())).toBe(0);
  });

  it('승인 대기는 요청 시각 순, 결정된 것은 빠진다', () => {
    const state = baseState({
      approvals: {
        late: approval('late', { requestedAt: '2026-10-17T07:10:00+09:00' }),
        early: approval('early', { requestedAt: '2026-10-17T06:05:00+09:00' }),
        done: approval('done', { status: 'approved', decidedAt: '2026-10-17T06:40:00+09:00' }),
        tie: approval('a-tie', { requestedAt: '2026-10-17T06:05:00+09:00' }),
      },
    });
    expect(pendingApprovals(state).map((a) => a.id)).toEqual(['a-tie', 'early', 'late']);
  });

  it('최근 결정은 결정 시각이 늦은 것부터 3건', () => {
    const mk = (id: string, at: string, status: 'approved' | 'rejected') => approval(id, { status, decidedAt: at });
    const state = baseState({
      approvals: {
        p: approval('p'),
        a: mk('a', '2026-10-17T06:10:00+09:00', 'approved'), b: mk('b', '2026-10-17T06:50:00+09:00', 'rejected'),
        c: mk('c', '2026-10-17T06:30:00+09:00', 'approved'), d: mk('d', '2026-10-17T06:20:00+09:00', 'approved'),
      },
    });
    expect(recentDecisions(state).map((a) => a.id)).toEqual(['b', 'c', 'd']);
    expect(recentDecisions(state, 1).map((a) => a.id)).toEqual(['b']);
  });

  it('실행 주체별: AI 4종만, 오늘 생성은 metrics, 지금 진행은 열린 작업의 실행 주체', () => {
    expect(AI_EXECUTORS).toEqual(['claude', 'codex', 'aside', 'script']);
    const state = baseState({
      metrics: { day: '2026-10-17', completed: 0, savedMinutes: 0, createdByExecutor: { claude: 5, codex: 2, aside: 3, script: 1, human: 4 } },
      tasks: {
        a: task('a', { executor: 'claude' }), b: task('b', { executor: 'claude', status: 'in_review' }), c: task('c', { executor: 'aside' }),
        d: task('d', { executor: 'codex', status: 'completed' }), e: task('e', { executor: 'human', status: 'waiting_approval' }),
      },
    });
    expect(executorStats(state)).toEqual([
      { executor: 'claude', created: 5, running: 2 },
      { executor: 'codex', created: 2, running: 0 },
      { executor: 'aside', created: 3, running: 1 },
      { executor: 'script', created: 1, running: 0 },
    ]);
    const running = runningByExecutor(state);
    expect(Object.values(running).reduce((a, b) => a + b, 0)).toBe(openTaskCount(state));
    expect(running.human).toBe(1);
  });

  it('미배정: 조직에 없는 id와 unassigned: 로 시작하는 id', () => {
    const state = baseState({
      staff: {
        [WRITER]: staffState(WRITER),
        'unassigned:rsc-99-T01': staffState('unassigned:rsc-99-T01', { known: false }),
        'zzz-99': staffState('zzz-99', { known: false }),
      },
    });
    expect(unassignedActors(state)).toEqual(['unassigned:rsc-99-T01', 'zzz-99']);
    expect(unassignedActors(baseState())).toEqual([]);
  });
});

describe('직원 선택자', () => {
  it('현재 작업·최근 작업·상태', () => {
    const state = baseState({
      staff: { [WRITER]: staffState(WRITER, { status: 'working', currentTaskId: 't2', recentTaskIds: ['t2', 'gone', 't1'] }) },
      tasks: { t1: task('t1'), t2: task('t2', { title: '모닝 브리핑 원고' }) },
    });
    expect(currentTaskOf(state, WRITER)?.title).toBe('모닝 브리핑 원고');
    expect(currentTaskOf(state, EDITOR)).toBeNull();
    expect(recentTasksOf(state, WRITER).map((t) => t.id)).toEqual(['t2', 't1']);
    expect(recentTasksOf(state, WRITER, 1)).toHaveLength(1);
    expect(statusOf(state, WRITER)).toBe('working');
    expect(statusOf(state, EDITOR)).toBe('idle');
  });

  it('접근성 이름', () => {
    const writer = index.staff.get(WRITER)!;
    expect(staffAriaLabel(writer, 'working', '모닝 브리핑 원고')).toBe(`정기 브리핑 작가, 작업 중, 모닝 브리핑 원고, ${writer.status === 'active' ? '운영 중' : writer.status === 'building' ? '구축 중' : '운영 전'}`);
    expect(staffAriaLabel(writer, 'idle', null)).toMatch(/^정기 브리핑 작가, 대기, /);
  });
});

describe('활동 피드', () => {
  it('종류 분류', () => {
    const kinds: [EventType, Partial<PbEvent>, string][] = [
      ['task_created', {}, 'progress'], ['task_started', {}, 'progress'], ['task_handoff', { payload: { to: EDITOR, kind: 'work' } }, 'progress'],
      ['task_handoff', { payload: { to: EDITOR, kind: 'review' } }, 'review'], ['task_review_requested', { payload: { reviewer: CHECKER } }, 'review'],
      ['approval_requested', {}, 'approval'], ['approval_decided', {}, 'approval'], ['task_blocked', {}, 'blocked'],
      ['task_completed', {}, 'done'], ['staff_status_changed', {}, 'status'],
    ];
    for (const [type, p, expected] of kinds) expect(feedKindOf(ev(type, WRITER, p)), `${type}`).toBe(expected);
  });

  it('필터: 최신이 위, 종류·실행 주체·본부(다중), 대표 이벤트는 본부 필터에서 빠진다', () => {
    const feed = [
      { seq: 1, event: ev('task_created', WRITER, { executor: 'aside' }) },
      { seq: 2, event: ev('task_started', WRITER, { executor: 'aside' }) },
      { seq: 3, event: ev('task_review_requested', EDITOR, { executor: 'codex', payload: { reviewer: CHECKER } }) },
      { seq: 4, event: ev('task_blocked', CHECKER, { executor: 'script', payload: { reason: '자료 대기' } }) },
      { seq: 5, event: ev('approval_decided', 'ceo', { executor: 'human', payload: { decision: 'approve' } }) },
      { seq: 6, event: ev('task_completed', 'inv-01-e01', { executor: 'claude' }) },
    ];
    expect(filterFeed(feed, EMPTY_FEED_FILTER, index).map((f) => f.seq)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(filterFeed(feed, { ...EMPTY_FEED_FILTER, kind: 'progress' }, index).map((f) => f.seq)).toEqual([2, 1]);
    expect(filterFeed(feed, { ...EMPTY_FEED_FILTER, executors: ['aside', 'script'] }, index).map((f) => f.seq)).toEqual([4, 2, 1]);
    expect(filterFeed(feed, { ...EMPTY_FEED_FILTER, depts: ['med'] }, index).map((f) => f.seq)).toEqual([3, 2, 1]);
    expect(filterFeed(feed, { ...EMPTY_FEED_FILTER, depts: ['med', 'rsk'] }, index).map((f) => f.seq)).toEqual([4, 3, 2, 1]);
    expect(filterFeed(feed, { depts: ['med'], kind: 'progress', executors: ['aside'] }, index).map((f) => f.seq)).toEqual([2, 1]);
    expect(filterFeed(feed, { depts: ['inv'], kind: 'blocked', executors: [] }, index)).toEqual([]);
  });

  it('최대 200줄만 낸다', () => {
    const feed = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, event: ev('task_started', WRITER) }));
    const out = filterFeed(feed, EMPTY_FEED_FILTER, index);
    expect(out).toHaveLength(FEED_LIMIT);
    expect(out[0]!.seq).toBe(300);
    expect(out[out.length - 1]!.seq).toBe(101);
    expect(filterFeed(feed, EMPTY_FEED_FILTER, index, 5)).toHaveLength(5);
  });

  it('필터 켜짐 판정', () => {
    expect(isFeedFilterActive(EMPTY_FEED_FILTER)).toBe(false);
    expect(isFeedFilterActive({ ...EMPTY_FEED_FILTER, kind: 'done' })).toBe(true);
    expect(isFeedFilterActive({ ...EMPTY_FEED_FILTER, depts: ['med'] })).toBe(true);
    expect(isFeedFilterActive({ ...EMPTY_FEED_FILTER, executors: ['codex'] })).toBe(true);
  });

  it('동작 문구', () => {
    expect(describeEvent(ev('task_handoff', WRITER, { payload: { to: EDITOR, kind: 'work' } }), index)).toBe('→ 편집장에게 전달');
    expect(describeEvent(ev('task_handoff', WRITER, { payload: { to: EDITOR } }), index)).toBe('→ 편집장에게 전달');
    expect(describeEvent(ev('task_handoff', WRITER, { payload: { to: EDITOR, kind: 'review' } }), index)).toBe('검토 요청 → 편집장');
    expect(describeEvent(ev('task_handoff', EDITOR, { payload: { to: WRITER, kind: 'revision' } }), index)).toBe('수정 요청 → 정기 브리핑 작가');
    expect(describeEvent(ev('task_handoff', EDITOR, { payload: { to: WRITER, kind: 'publish' } }), index)).toBe('게시 넘김 → 정기 브리핑 작가');
    expect(describeEvent(ev('task_handoff', EDITOR, { payload: {} }), index)).toBe('전달');
    expect(describeEvent(ev('task_review_requested', EDITOR, { payload: { reviewer: CHECKER } }), index)).toBe('검토 요청 → 독립 검사관(다른 회사 모델)');
    expect(describeEvent(ev('approval_requested', WRITER), index)).toBe('승인 요청');
    expect(describeEvent(ev('approval_decided', 'ceo', { payload: { decision: 'approve', auto: true } }), index)).toBe('자동 승인(시연)');
    expect(describeEvent(ev('approval_decided', 'ceo', { payload: { decision: 'approve' } }), index)).toBe('승인');
    expect(describeEvent(ev('approval_decided', 'ceo', { payload: { decision: 'reject' } }), index)).toBe('반려');
    expect(describeEvent(ev('task_blocked', WRITER, { payload: { reason: '입력 자료 대기' } }), index)).toBe('막힘: 입력 자료 대기');
    expect(describeEvent(ev('task_blocked', WRITER), index)).toBe('막힘');
    expect(describeEvent(ev('task_created', WRITER), index)).toBe('작업 생성');
    expect(describeEvent(ev('task_started', WRITER), index)).toBe('작업 시작');
    expect(describeEvent(ev('task_completed', WRITER), index)).toBe('완료');
    expect(describeEvent(ev('task_completed', WRITER, { payload: { outcome: 'rejected' } }), index)).toBe('반려로 종료');
    expect(describeEvent(ev('staff_status_changed', WRITER, { payload: { status: 'offline' } }), index)).toBe('상태 변경: 비활성');
    expect(describeEvent(ev('task_handoff', WRITER, { payload: { to: 'unassigned:rsc-99-T01' } }), index)).toBe('→ 미배정: rsc-99-T01에게 전달');
  });

  it('끝 아이콘 종류', () => {
    expect(eventIconKind(ev('task_started', WRITER))).toBe('working');
    expect(eventIconKind(ev('task_handoff', WRITER, { payload: { to: EDITOR, kind: 'review' } }))).toBe('reviewing');
    expect(eventIconKind(ev('task_handoff', WRITER, { payload: { to: EDITOR } }))).toBe('working');
    expect(eventIconKind(ev('task_review_requested', WRITER, { payload: { reviewer: CHECKER } }))).toBe('reviewing');
    expect(eventIconKind(ev('approval_requested', WRITER))).toBe('waiting_approval');
    expect(eventIconKind(ev('task_blocked', WRITER))).toBe('blocked');
    expect(eventIconKind(ev('task_completed', WRITER))).toBe('done');
    expect(eventIconKind(ev('task_completed', WRITER, { payload: { outcome: 'rejected' } }))).toBe('rejected');
    expect(eventIconKind(ev('staff_status_changed', WRITER, { payload: { status: 'offline' } }))).toBe('offline');
    expect(eventIconKind(ev('staff_status_changed', WRITER, { payload: { status: 'nope' } }))).toBeNull();
    expect(eventIconKind(ev('task_created', WRITER))).toBeNull();
    expect(eventIconKind(ev('approval_decided', 'ceo'))).toBeNull();
  });
});

describe('상세 서랍·피드 보조 선택자', () => {
  it('실행 주체가 맡은 열린 작업: 늦게 만든 것부터, 끝난 작업과 다른 주체는 뺀다', () => {
    const state = baseState({
      tasks: {
        a: task('a', { executor: 'claude', createdAt: '2026-10-17T06:00:00+09:00' }),
        b: task('b', { executor: 'claude', createdAt: '2026-10-17T06:30:00+09:00', status: 'in_review' }),
        c: task('c', { executor: 'claude', status: 'completed' }),
        d: task('d', { executor: 'codex' }),
        e: task('e', { executor: 'claude', createdAt: '2026-10-17T06:10:00+09:00', status: 'blocked' }),
      },
    });
    expect(openTasksOfExecutor(state, 'claude').map((t) => t.id)).toEqual(['b', 'e', 'a']);
    expect(openTasksOfExecutor(state, 'claude', 2).map((t) => t.id)).toEqual(['b', 'e']);
    expect(openTasksOfExecutor(state, 'aside')).toEqual([]);
  });

  it('작업의 마지막 움직임 시각과 작업 상태 아이콘', () => {
    expect(taskLastTs(task('x', { startedAt: '2026-10-17T06:05:00+09:00', endedAt: '2026-10-17T06:20:00+09:00' }))).toBe('2026-10-17T06:20:00+09:00');
    expect(taskLastTs(task('x', { startedAt: '2026-10-17T06:05:00+09:00' }))).toBe('2026-10-17T06:05:00+09:00');
    expect(taskLastTs(task('x'))).toBe('2026-10-17T06:00:00+09:00');
    expect(taskIconKind('in_progress')).toBe('working');
    expect(taskIconKind('in_review')).toBe('reviewing');
    expect(taskIconKind('waiting_approval')).toBe('waiting_approval');
    expect(taskIconKind('blocked')).toBe('blocked');
    expect(taskIconKind('completed')).toBe('done');
    expect(taskIconKind('rejected')).toBe('rejected');
    expect(taskIconKind('created')).toBe('idle');
  });

  it('피드 둘째 줄: 작업 제목, 작업이 없으면 이벤트 message', () => {
    const state = baseState({ tasks: { t1: task('t1', { title: '모닝 브리핑 원고' }) } });
    expect(feedSubtitle(state, ev('task_started', WRITER, { task_id: 't1', message: '시작' }))).toBe('모닝 브리핑 원고');
    expect(feedSubtitle(state, ev('staff_status_changed', WRITER, { task_id: null, message: '정지 파일 설정' }))).toBe('정지 파일 설정');
    expect(feedSubtitle(state, ev('task_started', WRITER, { task_id: 'gone', message: '기록 없는 작업' }))).toBe('기록 없는 작업');
    expect(feedSubtitle(state, ev('task_started', WRITER, { task_id: null, message: '' }))).toBe('');
  });
});

describe('시각·시간 표기(KST)', () => {
  it('HH:MM:SS · 날짜 · 절약 시간', () => {
    expect(formatClock('2026-10-17T10:42:13+09:00')).toBe('10:42:13');
    expect(formatClock('2026-10-17T01:42:13Z')).toBe('10:42:13');          // 시간대가 달라도 KST로
    expect(formatClock(null)).toBe('--:--:--');
    expect(formatClock('엉터리')).toBe('--:--:--');
    expect(formatDateTimeKo('2026-10-17T06:42:00+09:00')).toBe('10월 17일(토) 06:42');
    expect(formatStamp('2026-10-17T04:59:04.599Z')).toBe('2026-10-17 13:59');
    expect(formatMonthDay('2026-10-17T04:59:04.599Z')).toBe('10/17');
    expect(toKstIso(Date.parse('2026-10-17T00:00:00Z'))).toBe('2026-10-17T09:00:00+09:00');
    expect(formatDuration(0)).toBe('0분');
    expect(formatDuration(45)).toBe('45분');
    expect(formatDuration(125)).toBe('2시간 5분');
    expect(formatDuration(120)).toBe('2시간 0분');
    expect(formatDuration(-3)).toBe('0분');
    expect(formatWaited(45_000)).toBe('45초');
    expect(formatWaited(3 * 60_000 + 10_000)).toBe('3분');
    expect(formatWaited(80 * 60_000)).toBe('1시간 20분');
    expect(formatWaited(-5)).toBe('0초');
  });

  it('글자 자르기', () => {
    expect(shortLabel('정기 브리핑 작가', 7)).toBe('정기 브리핑…');
    expect(shortLabel('편집장', 7)).toBe('편집장');
    expect(firstSegment('투자리서치·전략본부')).toBe('투자리서치');
    expect(firstSegment('WM·영업본부')).toBe('WM');
    expect(firstSegment('운영실')).toBe('운영실');
    expect(truncateToWidth('편집장', 100, 11)).toBe('편집장');
    const cut = truncateToWidth('아주 긴 팀 이름이 계속 이어집니다', 80, 11);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(15);
  });
});
