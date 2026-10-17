// 이벤트 스키마(docs/EVENT_SPEC.md §2·§3). 시뮬레이터·실제 기록 파일·WebSocket이 모두 이 검사를 지난다.
// 공통 칸 + 종류별 payload를 검사하고, 모르는 추가 칸은 받아 준다(payload 안의 추가 칸은 그대로 둔다).
import { z } from 'zod';
import { EXECUTORS, STAFF_STATUSES, isReservedId } from '../types';
import type { Executor, PbEvent, StaffStatus } from '../types';

// 길이 상한: 거대한 입력이 화면을 멈추지 않게 칸마다 둔다(EVENT_SPEC §2).
export const MAX_ID_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000;
/** 상태의 키가 되는 id: 비어 있지 않고, 200자 이하, 예약된 이름(__proto__ 등)이 아님 */
const id = z.string().min(1).max(MAX_ID_LENGTH).refine((v) => !isReservedId(v), '예약된 이름(__proto__ 등)은 id로 쓸 수 없습니다');
const text = z.string().min(1).max(MAX_TEXT_LENGTH);
const anyText = z.string().max(MAX_TEXT_LENGTH);     // 빈 문자열 허용
const minutes = z.number().min(0);
const executor = z.enum(EXECUTORS as [Executor, ...Executor[]]);
const staffStatus = z.enum(STAFF_STATUSES as [StaffStatus, ...StaffStatus[]]);
const looseObject = z.looseObject;

const common = {
  v: z.literal(1).optional(),
  event_id: id,
  ts: z.iso.datetime({ offset: true }),     // 시간대(Z 또는 ±hh:mm)가 있는 ISO 8601만
  staff_id: id,
  executor,
  message: anyText,
};

export const EventSchema = z.discriminatedUnion('type', [
  z.object({
    ...common, type: z.literal('task_created'), task_id: id,
    payload: looseObject({ title: text, parent_task_id: id.optional(), duty: text.optional(), manual_minutes: minutes.optional() }),
  }),
  z.object({ ...common, type: z.literal('task_started'), task_id: id, payload: looseObject({}).optional() }),
  z.object({
    ...common, type: z.literal('task_handoff'), task_id: id,
    payload: looseObject({ to: id, kind: z.enum(['work', 'review', 'revision', 'publish']).optional() }),
  }),
  z.object({ ...common, type: z.literal('task_review_requested'), task_id: id, payload: looseObject({ reviewer: id }) }),
  z.object({
    ...common, type: z.literal('approval_requested'), task_id: id,
    payload: looseObject({ approval_id: id, summary: anyText }),
  }),
  z.object({
    ...common, type: z.literal('approval_decided'), task_id: id,
    payload: looseObject({ approval_id: id, decision: z.enum(['approve', 'reject']), auto: z.boolean().optional() }),
  }),
  z.object({ ...common, type: z.literal('task_blocked'), task_id: id, payload: looseObject({ reason: anyText }) }),
  z.object({
    ...common, type: z.literal('task_completed'), task_id: id,
    payload: looseObject({ outcome: z.enum(['done', 'rejected']).optional(), human_minutes: minutes.optional() }).optional(),
  }),
  z.object({
    ...common, type: z.literal('staff_status_changed'), task_id: id.nullable(),   // task_id가 null일 수 있는 유일한 종류
    payload: looseObject({ status: staffStatus }),
  }),
]);

export type ParseEventResult = { ok: true; event: PbEvent } | { ok: false; error: string };

/** zod 문제 1건 → 한 줄 사유(`칸 경로: 설명`). 시나리오 파일 검사(sim/load.ts)도 쓴다. */
export function describeIssue(issue: z.core.$ZodIssue, rootLabel = '이벤트'): string {
  const where = issue.path.map(String).join('.');
  const label = where || rootLabel;
  const msg = issue.message;
  switch (issue.code) {
    case 'invalid_type':
      if (!where) return `${rootLabel}가 JSON 객체가 아닙니다`;
      return /received undefined$/.test(msg) ? `${label}: 필수 칸이 없습니다` : `${label}: 형식이 맞지 않습니다`;
    case 'invalid_value':
      return `${label}: 허용되지 않는 값입니다`;
    case 'invalid_format':
      return `${label}: ${issue.format === 'regex' ? msg : '시간대가 있는 ISO 8601 형식이어야 합니다'}`;
    case 'too_small':
      return `${label}: 비어 있거나 너무 작습니다`;
    case 'too_big':
      return issue.origin === 'string' ? `${label}: 너무 깁니다(최대 ${String(issue.maximum)}자)` : `${label}: 너무 큽니다`;
    case 'unrecognized_keys':
      return `${label}: 모르는 칸 ${issue.keys.join(', ')}`;
    case 'invalid_union':
      return `${label}: 알 수 없는 종류이거나 형식이 맞지 않습니다`;
    default:
      return `${label}: ${msg}`;
  }
}

/** 이벤트 1건 검사. 실패하면 첫 문제를 한 줄로 돌려준다. */
export function parseEvent(input: unknown): ParseEventResult {
  const result = EventSchema.safeParse(input);
  if (result.success) return { ok: true, event: result.data as unknown as PbEvent };
  const first = result.error.issues[0];
  return { ok: false, error: first ? describeIssue(first) : '이벤트 형식이 맞지 않습니다' };
}

export interface ParsedEventText { events: PbEvent[]; bad: number; errors: string[] }
const MAX_ERRORS = 5;

/**
 * 기록 파일 본문 → 이벤트 목록. 첫 공백 아닌 글자가 '['면 JSON 배열, 아니면 JSONL(한 줄에 1건, 빈 줄은 건너뜀).
 * 잘못된 줄은 건너뛰고 개수(bad)와 처음 5건의 사유(`줄 n: 사유`)를 돌려준다.
 */
export function parseEventText(textInput: string): ParsedEventText {
  const events: PbEvent[] = [];
  const errors: string[] = [];
  let bad = 0;
  const fail = (n: number, why: string): void => {
    bad += 1;
    if (errors.length < MAX_ERRORS) errors.push(`줄 ${n}: ${why}`);
  };
  const src = textInput.charCodeAt(0) === 0xfeff ? textInput.slice(1) : textInput;

  let k = 0;
  while (k < src.length && /\s/.test(src[k]!)) k += 1;
  if (k >= src.length) return { events, bad, errors };

  if (src[k] === '[') {
    let list: unknown;
    try {
      list = JSON.parse(src);
    } catch {
      fail(1, 'JSON 배열 형식 오류');
      return { events, bad, errors };
    }
    if (!Array.isArray(list)) {
      fail(1, 'JSON 배열이 아닙니다');
      return { events, bad, errors };
    }
    list.forEach((item, i) => {
      const r = parseEvent(item);
      if (r.ok) events.push(r.event);
      else fail(i + 1, r.error);
    });
    return { events, bad, errors };
  }

  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(i + 1, 'JSON 형식 오류');
      continue;
    }
    const r = parseEvent(value);
    if (r.ok) events.push(r.event);
    else fail(i + 1, r.error);
  }
  return { events, bad, errors };
}
