# 이벤트 명세 (v1)

대시보드가 받는 유일한 입력이다. 시뮬레이터·실제 기록(events.jsonl)·WebSocket이 모두 이 형식을 낸다. 타입은 `src/types.ts`의 `PbEvent`, 검사는 `src/data/schema.ts`(zod).

## 1. 파일 형식

- UTF-8 JSONL: 한 줄에 이벤트 1건. 또는 JSON 배열 1개(`[ {...}, {...} ]`).
- 추가만 한다(이미 쓴 줄을 고치지 않는다). 파일을 새로 시작(교체)하면 대시보드는 처음부터 다시 읽고 이미 본 `event_id`는 버린다.
- 잘못된 줄은 건너뛰고 화면 상태에 개수를 보여 준다.

## 2. 공통 칸

| 칸 | 형식 | 필수 | 설명 |
|---|---|---|---|
| v | 1 | 선택 | 형식 버전(없으면 1) |
| event_id | 문자열 | 필수 | 전체에서 유일. 같은 id가 다시 오면 버린다 |
| ts | ISO 8601 | 필수 | 시간대 포함(예: `2026-10-17T06:31:00+09:00`). 정렬 기준 |
| type | 아래 9종 | 필수 | |
| staff_id | 문자열 | 필수 | 행위자. 직원 id(`med-01-e03`), 대표 `ceo`, AI 총괄 `hq.claude`·`hq.codex`·`hq.aside`. 조직에 없는 id도 받되 '조직에 없는 행위자'로 표시 |
| executor | `claude`·`codex`·`aside`·`script`·`human` | 필수 | 이 동작 뒤 작업을 수행하는 주체. 전달(task_handoff)·검토 요청(task_review_requested)은 넘겨받는 쪽, 승인 결정은 `human`(대표). 작업의 실행 주체 배지가 이 값으로 바뀐다(승인 요청·결정 제외) |
| task_id | 문자열 또는 null | 필수 | `staff_status_changed`만 null 가능 |
| message | 문자열 | 필수 | 한 줄 설명(화면 피드에 그대로 나온다). 빈 문자열 허용 |
| payload | 객체 | 종류별 | 아래 §3 |

## 3. 종류별 payload

| type | payload 필수 | payload 선택 | 화면에 생기는 일 |
|---|---|---|---|
| task_created | `title` | `parent_task_id`, `duty`(업무 id), `manual_minutes`(사람이 할 때 걸리는 분, 추정) | 작업 생성 |
| task_started | — | — | 행위자 '작업 중' |
| task_handoff | `to`(받는 행위자) | `kind`: `work`(기본)·`review`·`revision`·`publish` | 일감 이동 애니메이션, 받는 쪽 작업 중(review면 검토 중) |
| task_review_requested | `reviewer` | — | 검토자 '검토 중' |
| approval_requested | `approval_id`, `summary` | — | 승인 관문 레인에 올라감, 행위자 '승인 대기' |
| approval_decided | `approval_id`, `decision`: `approve`·`reject` | `auto`(시뮬레이션 자동 승인이면 true) | 레인에서 내려감. **실제 연결에서는 staff_id `ceo`, executor `human`만 낸다**(아니면 경고) |
| task_blocked | `reason` | — | 행위자 '막힘' |
| task_completed | — | `outcome`: `done`(기본)·`rejected`, `human_minutes`(대표가 실제로 쓴 분) | 행위자 대기, 'AI가 대신한 업무' 집계 |
| staff_status_changed | `status`: `idle`·`working`·`reviewing`·`waiting_approval`·`blocked`·`offline` | — | 상태만 바꿈(예: 정지·비활성) |

절약 추정 = Σ max(0, `manual_minutes` − `human_minutes`). 기준 분은 추정치라 화면에 늘 '추정'을 붙인다(PB AI M5 주간 집계와 같은 정의).

## 4. 예시(events.jsonl 3줄)

```jsonl
{"v":1,"event_id":"ex-1","ts":"2026-10-17T06:30:00+09:00","type":"task_created","staff_id":"med-01-e03","executor":"aside","task_id":"mb-1","message":"모닝 브리핑 초안 작업을 만들었습니다","payload":{"title":"모닝 브리핑 초안 작성","duty":"com-01-T05","manual_minutes":45}}
{"v":1,"event_id":"ex-2","ts":"2026-10-17T06:41:00+09:00","type":"task_handoff","staff_id":"med-01-e03","executor":"claude","task_id":"mb-1","message":"편집장에게 초안을 넘깁니다","payload":{"to":"med-01-e01","kind":"review"}}
{"v":1,"event_id":"ex-3","ts":"2026-10-17T07:02:00+09:00","type":"approval_decided","staff_id":"ceo","executor":"human","task_id":"mb-1","message":"게시 승인","payload":{"approval_id":"mb-1:A1","decision":"approve"}}
```

## 5. 넣으면 안 되는 것

비밀번호·키·토큰, 고객 이름·연락처·계좌 등 개인정보, 고객 자료 내용, 내부 파일 경로, 종목 추천·매매 지시 문구. 내보내기 스크립트가 쓰기 전에 거른다(대시보드는 그대로 보여 주므로 걸러지지 않은 값이 화면에 나온다).

## 6. 실제 기록 연결(2단계 — 아직 만들지 않음)

PB AI 회사 쪽 내보내기 스크립트가 실제 실행 기록을 읽어 이 형식의 events.jsonl을 만든다. 대시보드는 그 파일만 읽는다(원장·기록을 직접 해석하지 않는다).

| 실제 기록(예) | 낼 이벤트 |
|---|---|
| 예약 작업·루틴 시작/끝(성공·실패) | task_started / task_completed · task_blocked(실패 사유) |
| 기계 검사·독립 검사 요청·결과 | task_review_requested / task_handoff(kind revision) · task_completed |
| 서명 승인 대기열 올림·결정 | approval_requested / approval_decided(ceo, human) |
| 정지 파일 설정·해제 | staff_status_changed(offline / idle) |

행위자는 그 일을 맡은 직원 id(업무 id → 직원은 `org.json`의 duties로 찾는다), executor는 실제 실행 주체다. 파일 위치는 PC마다 `.env.local`의 `PBAI_EVENTS_PATHS`(Google Drive 동기화 경로 가능). 내부 기록을 외부 동기화 폴더로 내보내는 것은 PB AI 회사 규칙의 외부 전송 절차를 따른다.
