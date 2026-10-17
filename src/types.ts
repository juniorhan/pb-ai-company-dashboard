// 공유 계약: 조직·이벤트·상태·소스·스토어 타입과 화면 표기.
// 코어(src/core·src/sources·src/sim·src/data)와 화면(src/ui)이 함께 쓴다.
// 바꾸면 docs/EVENT_SPEC.md·docs/DESIGN.md를 같이 고치고 docs/DECISIONS.md에 한 줄 남긴다.

/* ───────────── 조직(src/data/org.json — Wiki 정본에서 만든 생성 사본, 손으로 고치지 않음) ───────────── */

export type Executor = 'claude' | 'codex' | 'aside' | 'script' | 'human';
export const EXECUTORS: Executor[] = ['claude', 'codex', 'aside', 'script', 'human'];
export type OpStatus = 'active' | 'building' | 'planned' | 'paused';
export type Phase = 'P0' | 'P1' | 'P2';
export type Risk = 'R0' | 'R1' | 'R2';

export interface OrgDept { id: string; name: string; head: string; role: string }
export interface OrgTeam { id: string; dept: string; name: string; role: string; status: OpStatus; phase: Phase | null }
export interface OrgDuty { id: string; title: string }
export interface OrgStaff {
  id: string;
  team: string;
  dept: string;
  name: string;               // 직책
  role: string;               // 임무 한 줄
  status: OpStatus;           // 운영 상태(조직 정본)
  phase: Phase | null;
  risk: Risk | null;
  executors: Executor[];      // 작성·수행 주체
  checkers: Executor[];       // 검증 주체 종류
  checker_staff: string[];    // 검증자 직원 id
  duties: OrgDuty[];          // 담당 업무(업무 인벤토리 id) — 시나리오는 이것으로 행위자를 찾는다
}
export interface OrgHq { id: string; name: string; executor: Executor; role: string }
export interface OrgExpansion { team: string; role: string; trigger: string }
export interface Org {
  format: 1;
  meta: {
    generated_at: string;
    source: 'wiki' | 'fixture';
    source_hash: string;
    counts: { depts: number; teams: number; staff: number; expansion: number };
  };
  ceo: { title: string; holds: string[]; owner_only: { task: string; title: string }[] };
  hq: OrgHq[];                // AI 총괄 체계(Claude·Codex·Aside)
  depts: OrgDept[];           // 표시 순서대로
  teams: OrgTeam[];
  staff: OrgStaff[];
  expansion: OrgExpansion[];  // 확장 대기 직책(점선 빈 자리, 움직이지 않음)
  legacy: { teams: Record<string, string>; depts: Record<string, string> };   // 동결 id → 승계 id
}

/** 특별 행위자: 대표(사람). AI 총괄은 org.hq[].id(hq.claude 등). 미배정은 UNASSIGNED_PREFIX + 업무 id. */
export const CEO_ID = 'ceo';
export const UNASSIGNED_PREFIX = 'unassigned:';

/** 본부 색 슬롯(1~8, docs/DESIGN.md §6 팔레트). 엔티티 고정 — 순서·필터로 다시 칠하지 않는다. 모르는 본부는 빈 슬롯 7·8 순. */
export const DEPT_COLOR_SLOTS: Record<string, number> = { ops: 1, inv: 2, wms: 3, med: 4, rsk: 5, sys: 6 };

/* ───────────── 이벤트(docs/EVENT_SPEC.md) ───────────── */

export type EventType =
  | 'task_created'
  | 'task_started'
  | 'task_handoff'
  | 'task_review_requested'
  | 'approval_requested'
  | 'approval_decided'
  | 'task_blocked'
  | 'task_completed'
  | 'staff_status_changed';
export const EVENT_TYPES: EventType[] = [
  'task_created', 'task_started', 'task_handoff', 'task_review_requested', 'approval_requested',
  'approval_decided', 'task_blocked', 'task_completed', 'staff_status_changed',
];
export type HandoffKind = 'work' | 'review' | 'revision' | 'publish';
export type StaffStatus = 'idle' | 'working' | 'reviewing' | 'waiting_approval' | 'blocked' | 'offline';
export const STAFF_STATUSES: StaffStatus[] = ['working', 'reviewing', 'waiting_approval', 'blocked', 'idle', 'offline'];

export interface PbEvent {
  v?: 1;
  event_id: string;
  ts: string;                       // ISO 8601, 시간대 포함
  type: EventType;
  staff_id: string;                 // 행위자: 직원 id · 'ceo' · org.hq[].id · 'unassigned:…'
  executor: Executor;               // 수행 주체. 전달·검토 요청은 넘겨받아 수행하는 쪽, 승인 결정은 'human'
  task_id: string | null;           // staff_status_changed만 null 가능
  message: string;
  payload?: Record<string, unknown>; // 종류별 칸은 EVENT_SPEC §3(zod로 검사)
}

/* ───────────── 상태(src/core/reducer.ts가 만드는 순수 상태) ───────────── */

export type TaskStatus = 'created' | 'in_progress' | 'in_review' | 'waiting_approval' | 'blocked' | 'completed' | 'rejected';

export interface StaffState {
  id: string;
  known: boolean;                   // 조직(또는 특별 행위자)에 있는 id인가
  status: StaffStatus;
  currentTaskId: string | null;
  lastMessage: string | null;
  lastTs: string | null;
  changeSeq: number;                // 상태가 바뀔 때마다 +1(펄스 애니메이션 키)
  history: { ts: string; status: StaffStatus; message: string }[];   // 최근 30
  recentTaskIds: string[];          // 최근 10(최신이 앞)
}
export interface TaskState {
  id: string;
  title: string;
  owner: string;
  executor: Executor;
  status: TaskStatus;
  parentTaskId: string | null;
  duty: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  manualMinutes: number | null;     // 사람이 직접 할 때 걸리는 분(기준 분, 추정)
  humanMinutes: number | null;      // 대표가 실제로 쓴 분(기록이 있을 때만)
  history: { ts: string; type: EventType; staffId: string; message: string }[];
}
export interface ApprovalState {
  id: string;
  taskId: string;
  requestedBy: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  decidedAt: string | null;
  auto: boolean;                    // 시뮬레이션 자동 승인이면 true
}
export interface FeedItem { seq: number; event: PbEvent }
export interface HandoffItem { seq: number; ts: string; taskId: string; from: string; to: string; kind: HandoffKind | 'approval' | 'decision' }
export interface DayMetrics {
  day: string | null;               // 마지막 이벤트의 KST 날짜(YYYY-MM-DD)
  completed: number;                // 그날 완료(대표 수행 제외, 반려 종료 제외)
  savedMinutes: number;             // Σ max(0, manualMinutes − humanMinutes) — '추정'
  createdByExecutor: Record<Executor, number>;
}
export interface DashboardState {
  seq: number;
  lastTs: string | null;
  staff: Record<string, StaffState>;
  tasks: Record<string, TaskState>;
  approvals: Record<string, ApprovalState>;
  feed: FeedItem[];                 // 오래된 것 → 최신, 최대 300
  handoffs: HandoffItem[];          // 최근 50
  metrics: DayMetrics;
  warnings: string[];               // 최근 50
}

/* ───────────── 소스(src/sources) ───────────── */

export type SourceKind = 'sim' | 'jsonl' | 'file' | 'ws';
export interface SourceStatus {
  state: 'idle' | 'connecting' | 'live' | 'paused' | 'error' | 'ended';
  detail: string;
  lastEventTs: string | null;
}
export interface ScenarioInfo { id: string; title: string; description: string }
export interface SimControl {
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  setSpeed(x: number): void;        // 1 · 2 · 5
  getSpeed(): number;
  listScenarios(): ScenarioInfo[];  // 'day'(하루 압축 재생)가 맨 앞
  getScenario(): string;
  setScenario(id: string): void;    // 바꾸면 처음부터 다시(이벤트 기록은 새로 시작)
  setAutoApprove(on: boolean): void;
  getAutoApprove(): boolean;
  clock(): string;                  // 시뮬레이션 시각(ISO, +09:00)
  autoApproveDue(approvalId: string): number | null;   // 자동 승인까지 남은 실제 ms
  subscribeTick(listener: () => void): () => void;      // 시계·재생 상태 변화(초당 최대 4회)
}
export interface EventSource {
  readonly kind: SourceKind;
  readonly label: string;
  readonly live: boolean;           // 실데이터 연결(jsonl·ws)이면 true
  subscribe(handler: (batch: PbEvent[]) => void): () => void;
  onStatus(handler: (s: SourceStatus) => void): () => void;
  start(): void;
  stop(): void;
  readonly control?: SimControl;    // 시뮬레이션만
  decide?(approvalId: string, decision: 'approve' | 'reject'): void;   // 시뮬레이션만. 실연결은 읽기 전용
  onReset?(handler: () => void): () => void;   // 기록을 처음부터 다시 받을 때(시나리오 변경). 스토어가 로그를 비운다
}

/* ───────────── 조직 색인·스토어(src/data/org.ts, src/core/store.ts) ───────────── */

export interface OrgIndex {
  org: Org;
  staff: ReadonlyMap<string, OrgStaff>;
  teams: ReadonlyMap<string, OrgTeam>;
  depts: ReadonlyMap<string, OrgDept>;
  teamsByDept: ReadonlyMap<string, OrgTeam[]>;
  staffByTeam: ReadonlyMap<string, OrgStaff[]>;
  expansionByTeam: ReadonlyMap<string, OrgExpansion[]>;
  dutyHolder: ReadonlyMap<string, string>;   // 업무 id → 직원 id
  deptSlot: ReadonlyMap<string, number>;     // 본부 id → 색 슬롯 1~8
  actorName(id: string): string;             // 직책·'대표이사'·AI 이름·'미배정: 업무'·'조직에 없는 id(…)'
  actorDept(id: string): string | null;      // 직원의 본부(특별 행위자는 null)
  resolveTeam(id: string): string | null;    // 현재 팀 id 그대로, 옛 팀 id → 승계 팀 id, 모르면 null
}

export interface DashboardView {
  state: DashboardState;                     // 커서 시점의 상태(실시간이면 최신)
  cursor: 'live' | string;                   // 'live' 또는 ISO 시각
  range: { start: string | null; end: string | null };
  density: number[];                         // 타임라인 60칸 이벤트 수
  marks: { ts: string; kind: 'approval' | 'blocked' }[];
  source: { kind: SourceKind; label: string; live: boolean; status: SourceStatus };
  org: { origin: 'live' | 'bundled'; generatedAt: string; hash: string };
}
export interface DashboardStore {
  readonly index: OrgIndex;
  readonly source: EventSource;
  getView(): DashboardView;                  // 바뀐 것이 없으면 같은 객체(useSyncExternalStore)
  subscribe(listener: () => void): () => void;
  setCursor(cursor: 'live' | string): void;
  dispose(): void;
}

/* ───────────── 설정(src/config.ts — URL 쿼리 + 기본값) ───────────── */

export interface AppConfig {
  source: SourceKind;               // ?source=sim|jsonl|file|ws (기본 sim)
  url: string | null;               // ?url=… (jsonl·ws)
  intervalMs: number;               // ?interval=초 (jsonl, 기본 5초)
  scenario: string;                 // ?scenario=day|morning-briefing|… (기본 day)
  speed: number;                    // ?speed=1|2|5
  view: 'office' | 'org';           // ?view=
  seed: number;                     // ?seed= (없으면 매번 다름)
  autoApprove: boolean;             // ?auto=0 이면 끔
}

/* ───────────── 시나리오(src/scenarios/*.json, docs/DESIGN.md §5) ───────────── */

/** 문자열이면 특별 행위자 id('ceo', 'hq.claude' …) 또는 직원 id. 객체면 duty(담당 업무) 우선 → staff → team 순으로 찾는다. */
export type ActorRef = string | { duty?: string; staff?: string; team?: string };
interface StepBase { after: number; message?: string }      // after: 앞 단계 뒤 실제 초(1x)
/**
 * 생략 규칙: actor를 비우면 그 작업의 현재 담당자(create·status 제외), executor를 비우면 작업의 현재 실행 주체(status는 'script').
 * executor는 그 동작 뒤 작업을 수행하는 주체다 — 전달(handoff)·검토 요청(review)은 넘겨받는 쪽.
 * message를 비우면 엔진이 기본 문구를 만든다.
 */
export type ScenarioStep = StepBase & (
  | { do: 'create'; task: string; title: string; actor: ActorRef; executor: Executor; parent?: string; duty?: string; manual_minutes?: number }
  | { do: 'start'; task: string; actor?: ActorRef; executor?: Executor }
  | { do: 'handoff'; task: string; to: ActorRef; executor: Executor; kind?: HandoffKind; from?: ActorRef }
  | { do: 'review'; task: string; reviewer: ActorRef; executor: Executor; actor?: ActorRef }
  | { do: 'approval'; task: string; summary: string; actor?: ActorRef; executor?: Executor; on_approve: ScenarioStep[]; on_reject: ScenarioStep[] }
  | { do: 'block'; task: string; reason: string; actor?: ActorRef; executor?: Executor }
  | { do: 'complete'; task: string; actor?: ActorRef; executor?: Executor; outcome?: 'done' | 'rejected'; human_minutes?: number }
  | { do: 'status'; actor: ActorRef; status: StaffStatus; executor?: Executor }
);
/** src/scenarios/*.json 파일 1개 = steps가 있으면 시나리오, segments가 있으면 하루 계획. idle.json은 한가한 활동 설정. */
export interface Scenario {
  id: string;
  title: string;
  description: string;
  order?: number;                   // 선택 메뉴 순서(작을수록 앞)
  start: string;                    // 시뮬레이션 시작 시각 'HH:MM'(KST)
  virtual_minutes: number;          // 본 단계 + on_approve 단계가 덮는 가상 시간(분)
  steps: ScenarioStep[];
}
export type DaySegment = { idle: true; until: string; real_seconds: number } | { scenario: string };
export interface DayPlan { id: string; title: string; description: string; order?: number; start: string; segments: DaySegment[] }
export interface IdleConfig {
  rate_per_min: number;             // 1x 실제 1분당 새 작업 수
  duration_seconds: [number, number];
  review_chance: number;            // 검증자에게 검토를 넘길 확률
  weights: Record<OpStatus, number>;
  manual_minutes: [number, number];
}

/* ───────────── 화면 표기 ───────────── */

export const EXECUTOR_LABEL: Record<Executor, string> = { claude: 'Claude', codex: 'Codex', aside: 'Aside', script: '스크립트', human: '대표' };
export const STAFF_STATUS_LABEL: Record<StaffStatus, string> = {
  idle: '대기', working: '작업 중', reviewing: '검토 중', waiting_approval: '승인 대기', blocked: '막힘', offline: '비활성',
};
export const OP_STATUS_LABEL: Record<OpStatus, string> = { active: '운영 중', building: '구축 중', planned: '운영 전', paused: '일시 중지' };
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  created: '생성', in_progress: '진행 중', in_review: '검토 중', waiting_approval: '승인 대기', blocked: '막힘', completed: '완료', rejected: '반려 종료',
};
export const EVENT_LABEL: Record<EventType, string> = {
  task_created: '작업 생성', task_started: '작업 시작', task_handoff: '전달', task_review_requested: '검토 요청',
  approval_requested: '승인 요청', approval_decided: '승인 결정', task_blocked: '막힘', task_completed: '완료', staff_status_changed: '상태 변경',
};
export const HANDOFF_LABEL: Record<HandoffKind, string> = { work: '전달', review: '검토 요청', revision: '수정 요청', publish: '게시 넘김' };
