import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../types';
import type { EventType } from '../types';
import { EventSchema, parseEvent, parseEventText } from './schema';

const common = { event_id: 'e-1', ts: '2026-10-17T06:31:00+09:00', staff_id: 'med-01-e03', executor: 'claude', message: '한 줄 설명' };

/** 종류마다 정상 예 1건(task_id·payload 포함) */
const valid: Record<EventType, Record<string, unknown>> = {
  task_created: { type: 'task_created', task_id: 'mb#1/draft', payload: { title: '모닝 브리핑 원고', parent_task_id: 'mb#1/brief', duty: 'com-01-T05', manual_minutes: 45 } },
  task_started: { type: 'task_started', task_id: 'mb#1/draft' },
  task_handoff: { type: 'task_handoff', task_id: 'mb#1/draft', payload: { to: 'med-01-e01', kind: 'review' } },
  task_review_requested: { type: 'task_review_requested', task_id: 'mb#1/draft', payload: { reviewer: 'rsk-01-e02' } },
  approval_requested: { type: 'approval_requested', task_id: 'mb#1/draft', payload: { approval_id: 'mb#1/draft:A1', summary: '게시 승인 요청' } },
  approval_decided: { type: 'approval_decided', task_id: 'mb#1/draft', staff_id: 'ceo', executor: 'human', payload: { approval_id: 'mb#1/draft:A1', decision: 'approve', auto: true } },
  task_blocked: { type: 'task_blocked', task_id: 'mb#1/draft', payload: { reason: '검사 대기' } },
  task_completed: { type: 'task_completed', task_id: 'mb#1/draft', payload: { outcome: 'rejected', human_minutes: 3 } },
  staff_status_changed: { type: 'staff_status_changed', task_id: null, payload: { status: 'offline' } },
};
const make = (type: EventType, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...common, ...valid[type], ...over });

describe('parseEvent — 9종 정상 예', () => {
  it('정상 예가 9종 전부를 덮는다', () => {
    expect(Object.keys(valid).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('%s 정상 예 통과', (type) => {
    const r = parseEvent(make(type));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.type).toBe(type);
      expect(r.event.event_id).toBe('e-1');
      expect(r.event.task_id).toBe(valid[type]!.task_id);
    }
  });

  it('payload 없이도 되는 종류: task_started·task_completed', () => {
    expect(parseEvent(make('task_started', { payload: undefined })).ok).toBe(true);
    expect(parseEvent(make('task_started', { payload: {} })).ok).toBe(true);
    expect(parseEvent(make('task_completed', { payload: undefined })).ok).toBe(true);
    expect(parseEvent(make('task_completed', { payload: {} })).ok).toBe(true);
  });

  it('선택 칸은 없어도 된다', () => {
    expect(parseEvent(make('task_created', { payload: { title: '제목만' } })).ok).toBe(true);
    expect(parseEvent(make('task_handoff', { payload: { to: 'a' } })).ok).toBe(true);
    expect(parseEvent(make('approval_decided', { payload: { approval_id: 'x', decision: 'reject' } })).ok).toBe(true);
  });

  it('message는 빈 문자열이어도 된다', () => {
    expect(parseEvent(make('task_started', { message: '' })).ok).toBe(true);
  });

  it('v는 1만 허용하고 없어도 된다', () => {
    expect(parseEvent(make('task_started', { v: 1 })).ok).toBe(true);
    expect(parseEvent(make('task_started', { v: 2 })).ok).toBe(false);
  });

  it('모르는 추가 칸은 받아 준다(payload 안의 추가 칸은 그대로 남는다)', () => {
    const r = parseEvent(make('task_created', { future_field: 1, payload: { title: 't', extra_note: 'keep' } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.payload).toMatchObject({ title: 't', extra_note: 'keep' });
  });

  it('돌려주는 이벤트는 입력과 별개의 객체다', () => {
    const input = make('task_created');
    const r = parseEvent(input);
    expect(r.ok && r.event !== (input as unknown)).toBe(true);
  });
});

describe('parseEvent — 실패', () => {
  const missing: [EventType, string][] = [
    ['task_created', 'title'],
    ['task_handoff', 'to'],
    ['task_review_requested', 'reviewer'],
    ['approval_requested', 'approval_id'],
    ['approval_requested', 'summary'],
    ['approval_decided', 'approval_id'],
    ['approval_decided', 'decision'],
    ['task_blocked', 'reason'],
    ['staff_status_changed', 'status'],
  ];
  it.each(missing)('%s: payload.%s가 없으면 실패', (type, key) => {
    const payload = { ...(valid[type]!.payload as Record<string, unknown>) };
    delete payload[key];
    const r = parseEvent(make(type, { payload }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`payload.${key}`);
  });

  it.each(['task_created', 'task_handoff', 'task_review_requested', 'approval_requested', 'approval_decided', 'task_blocked', 'staff_status_changed'] as EventType[])(
    '%s: payload 자체가 없으면 실패', (type) => {
      expect(parseEvent(make(type, { payload: undefined })).ok).toBe(false);
    },
  );

  it('예약된 이름(__proto__·constructor 등)은 상태의 키가 되는 어느 id 칸에도 쓸 수 없다', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      for (const input of [
        make('task_started', { staff_id: bad }),
        make('task_started', { task_id: bad }),
        make('task_started', { event_id: bad }),
        make('task_handoff', { payload: { to: bad } }),
        make('task_review_requested', { payload: { reviewer: bad } }),
        make('approval_requested', { payload: { approval_id: bad, summary: 's' } }),
        make('task_created', { payload: { title: 't', parent_task_id: bad } }),
      ]) {
        const r = parseEvent(input);
        expect(r.ok, `${bad} ${JSON.stringify(input)}`).toBe(false);
        if (!r.ok) expect(r.error).toContain('예약된 이름');
      }
    }
    expect(parseEvent(make('task_started', { task_id: 'proto-1' })).ok).toBe(true);     // 비슷한 이름은 괜찮다
  });

  it('길이 상한: id 200자, 글 2000자를 넘으면 실패', () => {
    expect(parseEvent(make('task_started', { task_id: 'x'.repeat(200) })).ok).toBe(true);
    const longId = parseEvent(make('task_started', { task_id: 'x'.repeat(201) }));
    expect(longId.ok).toBe(false);
    if (!longId.ok) expect(longId.error).toBe('task_id: 너무 깁니다(최대 200자)');
    expect(parseEvent(make('task_started', { message: 'm'.repeat(2000) })).ok).toBe(true);
    expect(parseEvent(make('task_started', { message: 'm'.repeat(2001) })).ok).toBe(false);
    expect(parseEvent(make('task_created', { payload: { title: 't'.repeat(1024 * 1024) } })).ok).toBe(false);
    expect(parseEvent(make('task_blocked', { payload: { reason: 'r'.repeat(2001) } })).ok).toBe(false);
  });

  it('시간대가 없는 ts는 실패, Z와 오프셋은 통과', () => {
    expect(parseEvent(make('task_started', { ts: '2026-10-17T06:31:00' })).ok).toBe(false);
    expect(parseEvent(make('task_started', { ts: '2026-10-17' })).ok).toBe(false);
    expect(parseEvent(make('task_started', { ts: 'yesterday' })).ok).toBe(false);
    expect(parseEvent(make('task_started', { ts: 1760650260000 })).ok).toBe(false);
    expect(parseEvent(make('task_started', { ts: '2026-10-17T06:31:00Z' })).ok).toBe(true);
    expect(parseEvent(make('task_started', { ts: '2026-10-17T06:31:00+09:00' })).ok).toBe(true);
    expect(parseEvent(make('task_started', { ts: '2026-10-17T06:31:00.250-05:00' })).ok).toBe(true);
    const bad = parseEvent(make('task_started', { ts: '2026-10-17T06:31:00' }));
    expect(!bad.ok && bad.error).toContain('ts');
  });

  it('잘못된 executor는 실패', () => {
    for (const executor of ['gpt', '', 'Claude', null, 3]) expect(parseEvent(make('task_started', { executor })).ok, String(executor)).toBe(false);
    for (const executor of ['claude', 'codex', 'aside', 'script', 'human']) expect(parseEvent(make('task_started', { executor })).ok, executor).toBe(true);
  });

  it('task_id가 null이어도 되는 것은 staff_status_changed뿐', () => {
    for (const type of EVENT_TYPES) {
      const r = parseEvent(make(type, { task_id: null }));
      expect(r.ok, type).toBe(type === 'staff_status_changed');
    }
  });

  it('task_id가 빈 문자열이거나 없으면 실패(staff_status_changed 포함: 빈 문자열은 안 됨)', () => {
    for (const type of EVENT_TYPES) {
      expect(parseEvent(make(type, { task_id: '' })).ok, `${type} 빈 문자열`).toBe(false);
      expect(parseEvent(make(type, { task_id: undefined })).ok, `${type} 없음`).toBe(false);
    }
  });

  it('필수 공통 칸이 없거나 형식이 틀리면 실패', () => {
    for (const key of ['event_id', 'ts', 'type', 'staff_id', 'executor', 'message']) {
      const input = make('task_started');
      delete input[key];
      expect(parseEvent(input).ok, key).toBe(false);
    }
    expect(parseEvent(make('task_started', { event_id: '' })).ok).toBe(false);
    expect(parseEvent(make('task_started', { staff_id: '' })).ok).toBe(false);
    expect(parseEvent(make('task_started', { message: 5 })).ok).toBe(false);
  });

  it('알 수 없는 type은 실패', () => {
    const r = parseEvent(make('task_started', { type: 'task_teleported' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });

  it('payload 값의 형식이 틀리면 실패', () => {
    expect(parseEvent(make('task_created', { payload: { title: 't', manual_minutes: -1 } })).ok).toBe(false);
    expect(parseEvent(make('task_created', { payload: { title: 't', manual_minutes: '5' } })).ok).toBe(false);
    expect(parseEvent(make('task_created', { payload: { title: '' } })).ok).toBe(false);
    expect(parseEvent(make('task_handoff', { payload: { to: 'a', kind: 'teleport' } })).ok).toBe(false);
    expect(parseEvent(make('approval_decided', { payload: { approval_id: 'x', decision: 'maybe' } })).ok).toBe(false);
    expect(parseEvent(make('staff_status_changed', { payload: { status: 'sleeping' } })).ok).toBe(false);
    expect(parseEvent(make('task_completed', { payload: { outcome: 'half' } })).ok).toBe(false);
    expect(parseEvent(make('task_started', { payload: [] })).ok).toBe(false);
  });

  it('객체가 아닌 입력은 한 줄 사유와 함께 실패', () => {
    for (const input of [null, undefined, 5, 'text', [], true]) {
      const r = parseEvent(input);
      expect(r.ok, String(input)).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('EventSchema를 직접 써도 같은 결과', () => {
    expect(EventSchema.safeParse(make('task_started')).success).toBe(true);
    expect(EventSchema.safeParse(make('task_started', { executor: 'x' })).success).toBe(false);
  });
});

describe('parseEventText', () => {
  const lines = (n: number, offset = 0): string[] =>
    Array.from({ length: n }, (_, i) => JSON.stringify(make('task_started', { event_id: `e-${offset + i + 1}` })));

  it('빈 글·공백뿐인 글은 이벤트 0건, 잘못된 줄 0', () => {
    expect(parseEventText('')).toEqual({ events: [], bad: 0, errors: [] });
    expect(parseEventText(' \n \r\n\t')).toEqual({ events: [], bad: 0, errors: [] });
  });

  it('JSONL: 한 줄에 1건, 빈 줄은 건너뛴다', () => {
    const text = [...lines(2), '', '   ', ...lines(2, 2)].join('\n');
    const r = parseEventText(text);
    expect(r.events.map((e) => e.event_id)).toEqual(['e-1', 'e-2', 'e-3', 'e-4']);
    expect(r.bad).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('JSONL: CRLF와 맨 앞 BOM, 끝 개행을 받아 준다', () => {
    const r = parseEventText(`﻿${lines(3).join('\r\n')}\r\n`);
    expect(r.events).toHaveLength(3);
    expect(r.bad).toBe(0);
  });

  it('JSON 배열: 첫 공백 아닌 글자가 [ 이면 배열로 읽는다', () => {
    const arr = JSON.stringify([make('task_started', { event_id: 'a' }), make('task_started', { event_id: 'b' })]);
    expect(parseEventText(arr).events.map((e) => e.event_id)).toEqual(['a', 'b']);
    expect(parseEventText(`﻿${arr}`).events).toHaveLength(2);
    expect(parseEventText(`  \n${arr}\n`).events).toHaveLength(2);
  });

  it('JSON 배열: 잘못된 항목은 건너뛰고 개수·사유를 센다', () => {
    const arr = JSON.stringify([make('task_started', { event_id: 'a' }), { type: 'task_started' }, 'x', make('task_started', { event_id: 'b' })]);
    const r = parseEventText(arr);
    expect(r.events.map((e) => e.event_id)).toEqual(['a', 'b']);
    expect(r.bad).toBe(2);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/^줄 2: /);
    expect(r.errors[1]).toMatch(/^줄 3: /);
  });

  it('JSON 배열: 문법이 틀리면 통째로 1건 잘못', () => {
    const r = parseEventText('[ {"a": 1}, ');
    expect(r.events).toEqual([]);
    expect(r.bad).toBe(1);
    expect(r.errors).toEqual(['줄 1: JSON 배열 형식 오류']);
  });

  it('잘못된 줄 개수와 사유: 형식 `줄 n: 사유`(n은 빈 줄을 포함한 줄 번호)', () => {
    const text = [lines(1)[0], '', 'not json', JSON.stringify({ type: 'task_started' }), '{"a":', lines(1, 1)[0]].join('\n');
    const r = parseEventText(text);
    expect(r.events).toHaveLength(2);
    expect(r.bad).toBe(3);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toBe('줄 3: JSON 형식 오류');
    expect(r.errors[1]).toMatch(/^줄 4: /);
    expect(r.errors[2]).toBe('줄 5: JSON 형식 오류');
  });

  it('사유는 최대 5개까지만 남기고 잘못된 줄 개수는 끝까지 센다', () => {
    const text = Array.from({ length: 12 }, () => 'garbage').join('\n');
    const r = parseEventText(text);
    expect(r.bad).toBe(12);
    expect(r.errors).toHaveLength(5);
    expect(r.errors[4]).toBe('줄 5: JSON 형식 오류');
  });

  it('배열이 아닌 JSON(객체 한 덩어리)은 JSONL로 읽어 잘못된 줄로 센다', () => {
    const r = parseEventText('{"a": 1}');
    expect(r.events).toEqual([]);
    expect(r.bad).toBe(1);
  });

  it('같은 event_id가 여러 번 있어도 이 단계에서는 그대로 돌려준다(중복 제거는 EventLog 몫)', () => {
    const r = parseEventText([...lines(1), ...lines(1)].join('\n'));
    expect(r.events).toHaveLength(2);
  });
});
