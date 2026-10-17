# 설계서 — PB AI 회사 관제실 대시보드

구현 기준 문서다. 공유 계약(타입·표기)은 `src/types.ts`, 이벤트 명세는 `docs/EVENT_SPEC.md`, 결정은 `docs/DECISIONS.md`. 이 문서를 바꾸면 결정 기록에 한 줄 남긴다.

## 0. 목표와 전제

- PB AI 회사(본부·팀·AI 직원 수는 `src/data/org.json`이 정본 사본, 지금 6·26·68)의 현황을 보면서 직원이 일하는 모습을 관전하는 2D 대시보드. 지금은 시뮬레이션, 나중에 실제 기록(events.jsonl)으로 **어댑터만 바꿔** 연결한다.
- 직원 = 역할 프로필(실행 중인 에이전트 아님). 실제 실행 주체는 Claude·Codex·Aside·스크립트, 승인 결정은 대표(사람). 모든 작업·이벤트에 실행 주체 배지를 붙인다.
- 공개 사이트(GitHub Pages)는 가짜 데이터 시뮬레이션만. 실데이터는 각 PC의 로컬 개발 서버(`.env.local` 경로, Google Drive 동기화 경로 포함) 또는 브라우저에 끌어다 놓은 파일로만 본다(파일은 브라우저 밖으로 나가지 않는다).
- **조직은 언제든 바뀐다.** 본부·팀·직원 수, 이름, 색 배정, 배치, 시나리오 행위자를 코드에 박지 않는다. 조직 정본은 PB AI 회사 Wiki(비공개)이고 `org.json`은 `npm run sync:org`가 만드는 생성 사본이다(§3).
- 공개물 규칙: 비밀값·개인정보·고객 데이터·내부 경로 금지, 시뮬레이션 문구에 종목 추천·투자 권유 금지, 준법·금융당국 승인 주장 금지(리스크·준법·감사실 판정은 '내부 검사'). 화면에 '시뮬레이션 · 실제 데이터 아님'과 각 직원의 운영 상태(운영 중·구축 중·운영 전)를 늘 표시한다.

## 1. 구조

```
src/
  types.ts            공유 계약(조직·이벤트·상태·소스·스토어·설정·시나리오·표기)
  config.ts           URL 쿼리 → AppConfig
  data/org.json       생성 사본(손으로 고치지 않음)
  data/org.ts         loadOrg(개발 서버 실시간 → 없으면 사본), parseOrg(zod + 무결성 검사, 어긋나면 오류), indexOrg
  data/schema.ts      이벤트 zod 스키마(종류별 payload), parseEvent·parseEventText
  core/reducer.ts     initialState(index), reduce(state, event, index) — 순수 함수
  core/eventlog.ts    이벤트 보관·정렬·중복 제거·스냅숏(100건마다)·stateAt(cursor)
  core/store.ts       createDashboardStore(index, source, orgMeta) → DashboardStore
  core/resolve.ts     ActorRef → 행위자 id(업무 → 직원 → 팀 → 미배정)
  sources/            SimulatorSource · JsonlPollingSource · FileSource · WebSocketSource · index.ts(createSource, createFileSource)
  sim/                engine.ts(재생·시계·자동 승인) · compile.ts(시나리오 단계 → 이벤트) · idle.ts(한가한 활동) · rng.ts(시드 RNG) · load.ts(시나리오 파일 읽기·검사)
  scenarios/          *.json — 시나리오(steps)·하루 계획(segments)·한가한 활동 설정(idle.json). 파일을 넣으면 코드 수정 없이 메뉴에 추가
  ui/                 화면 컴포넌트(§4), ui/selectors.ts(요약·필터·표시용 파생값, 순수 함수)
  styles/             tokens.css(라이트·다크 색), global.css
scripts/
  org-lib.mjs         Wiki → org.json 해석·공개 검사(개발 서버와 sync가 같이 씀)
  sync-org.mjs        npm run sync:org
  vite-plugin-pbai.mjs 개발 서버 전용 /__pbai/* (로컬 실데이터·실시간 조직)
  check-public.mjs    npm run check:public — 저장소 공개 검사
public/sample/events.sample.jsonl   가짜 이벤트(실연결 어댑터 시연·시험용, 시뮬레이터로 생성)
```

데이터 흐름: `EventSource` → (batch) → `EventLog` → `reduce` → `DashboardView` → UI. **UI 컴포넌트는 `DashboardStore`·`EventSource` 인터페이스만 쓴다.** 시뮬레이터·폴링 구현을 직접 부르지 않는다(구성은 `App.tsx`에서 `createSource`로만). 실연결 모드에는 `control`·`decide`가 없어 재생·승인 버튼이 자동으로 사라진다(읽기 전용).

## 2. 상태 규칙(reducer)

`initialState(index)`: 조직 직원 전원 + `ceo` + `org.hq[]`를 `idle`, `known: true`로 만든다. 처음 보는 id는 `known: false`로 만들고 경고 1줄(`조직에 없는 행위자: id`)을 남긴다(옛 팀 id가 든 직원 id라도 그대로 보여 준다).

| 이벤트 | 작업(task) | 행위자(staff_id) | 기타 |
|---|---|---|---|
| task_created | 새 작업: title=payload.title, owner=staff_id, executor, status=created, parentTaskId·duty·manualMinutes=payload | recentTaskIds 앞에 추가 | metrics.createdByExecutor[executor]+1 |
| task_started | status=in_progress, startedAt(처음만), owner=staff_id, executor 갱신 | working, currentTaskId | |
| task_handoff | owner=payload.to, executor 갱신, status = kind=review ? in_review : in_progress | from(=staff_id): 그 작업을 들고 있었으면 idle·currentTaskId null / to: review면 reviewing 아니면 working | handoffs에 {from,to,kind} |
| task_review_requested | owner=payload.reviewer, executor 갱신, status=in_review | 요청자 idle / reviewer reviewing | handoffs {from: 요청자, to: reviewer, kind: review} |
| approval_requested | status=waiting_approval | waiting_approval | approvals[payload.approval_id]=pending, handoffs {from: staff, to: ceo, kind: approval} |
| approval_decided | approve → in_progress / reject → in_progress(이어지는 이벤트가 정함) | 결정자(대표)는 상태 그대로, 요청자: waiting_approval이면 idle | approvals 갱신(auto=payload.auto), handoffs {from: ceo, to: 요청자, kind: decision}. staff_id≠ceo면 경고 |
| task_blocked | status=blocked | blocked | |
| task_completed | outcome=rejected면 rejected 아니면 completed, endedAt, humanMinutes | 그 작업을 들고 있었으면 idle | 그날 완료·절약 추정 갱신(대표 수행·반려 제외) |
| staff_status_changed | — | payload.status | |

공통: 작업의 executor는 승인 요청·결정을 뺀 작업 이벤트의 executor로 바꾼다(전달·검토 요청은 넘겨받는 쪽). seq+1, lastTs=max, feed 추가(최대 300), 행위자 lastTs·lastMessage 갱신, 상태가 바뀌면 changeSeq+1·history 추가(최대 30), 작업이 있으면 task.history 추가. 날짜(KST)가 바뀌면 metrics 하루 값을 0부터. 같은 이벤트 열을 다시 재생하면 같은 상태가 나와야 한다(시간·난수를 쓰지 않는다).

`EventLog`: event_id 중복은 버린다. ts 순으로 넣고 같은 ts는 받은 순서. 늦게 온(과거 ts) 이벤트가 끼면 그 지점부터 다시 계산한다. 100건마다 상태 스냅숏을 두고 `stateAt(cursor)`는 가장 가까운 스냅숏부터 재생한다. 보관 상한 20,000건(넘으면 오래된 것부터 버리고 첫 스냅숏을 다시 만든다).

## 3. 조직 사본과 유연성

- 정본: Wiki `PB AI 회사` 폴더의 `실/`·`팀/`·`직원/` 노트(머리말)와 `04_조직 부속표.md`(대표 역할·대표 몫·AI 총괄·확장 대기·본부 순서). 동결(frozen) 노트는 `legacy` 승계 표로만, 시험(is_test) 노트는 뺀다.
- `npm run sync:org`: `scripts/org-lib.mjs`로 해석 → 공개 검사(경로·메일·비밀값 모양 등, 위반은 괄호 조각 삭제 → 그래도 남으면 '(공개 사본에서 생략)') → 구조 검사 → 정본 해시가 바뀐 경우에만 `src/data/org.json`을 쓴다.
- 로컬 개발 서버는 `PBAI_WIKI_ORG_DIR`이 있으면 `/__pbai/org`로 Wiki를 바로 읽는다(항상 최신). 없거나 실패하면 저장소 사본을 쓴다. 화면 상단 '조직 기준' 표시에 출처(실시간·저장된 사본)와 생성 시각을 보여 준다.
- 검사(시험): 숫자를 고정하지 않는다. `meta.counts`가 실제 개수와 같고, 모든 참조(팀→본부, 직원→팀, 확장→팀, 검증자→직원)가 맞고, 공개 검사 위반이 0인지 본다. 시나리오의 모든 행위자가 지금 조직에서 해석되는지도 시험한다(안 되면 시나리오를 고친다).
- 조직이 바뀌면(pb-org) 그 세션이 마지막 단계로 `npm run sync:org` → `npm test` → 바뀐 경우 커밋·push(공개 사이트 갱신).

## 4. 화면

### 4.1 배치

데스크톱(≥1100px)

```
┌ 상단 바(56) ─ 로고·회사명 │ 모드 배지 │ ▶/⏸ 1x 2x 5x 시나리오 자동승인 │ 시각 │ 오피스|조직도 │ 파일 열기 │ 테마 │ 조직 기준 ┐
├ 요약 띠: 상태별 인원 · 진행 중 작업 · 승인 대기 · 막힘 · 실행 주체별(오늘) · AI가 대신한 업무(오늘) ─────────────┤
├ 본문(오피스 평면도 또는 조직도) ────────────────────────────┬ 사이드 360: 승인 관문 레인 / 활동 피드 ─┤
├ 타임라인(되감기) 64 ───────────────────────────────────────┴─────────────────────────────────────┤
└ 바닥글: 전제 문구 ─────────────────────────────────────────────────────────────────────────────┘
```

- 태블릿(720~1099px): 사이드가 본문 아래로 내려간다(승인·피드 두 칸).
- 휴대폰(<720px): 상단 바 두 줄(로고+모드 배지 / 재생 조작), 아래 탭 막대(요약·오피스·승인·피드·조직도). 오피스는 폭에 맞춰 축소하고 가로 스크롤 허용. 직원 상세는 바텀시트.
- 직원 상세 패널: 오른쪽 서랍 420px(휴대폰은 바텀시트), Esc·바깥 클릭·닫기 버튼으로 닫힘, 열리면 포커스 이동.

### 4.2 오피스 보기(관전, SVG 평면도)

- 레이아웃은 데이터에서 계산한다(본부·팀·직원 수가 바뀌어도 그대로 동작). viewBox 폭 1200 기준, 높이는 계산값. 컨테이너 폭에 맞춰 늘고 줄어든다.
- 위 줄: 앞쪽 본부 ⌈n/2⌉개 방, 가운데 띠: 대표실·AI 총괄(높이 ~170), 아래 줄: 나머지 본부. 같은 줄 방 너비는 좌석 수(직원+확장 대기)에 비례(최소 220), 줄 높이는 그 줄에서 가장 큰 방에 맞춘다.
- 방: 4px 위 테두리(본부 색), 바탕은 본부 색 6% 섞인 surface, 머리에 본부명(13px 600)·본부장 직책(11px muted)·인원. 리스크·준법·감사실 방 머리 아래 '내부 검사이며 실제 준법 승인이 아님'(11px, 늘 보임).
- 팀 섬: 팀명(11px 600)+팀 id(muted) 아래 둥근 책상(rx 8, surface-2, 1px border). 좌석 칸 68×78, 한 줄 최대 4석, 넘치면 줄 추가. 확장 대기 직책은 같은 섬 끝에 점선 빈 의자(+ 표시, 움직이지 않음, 툴팁: '확장 대기: 직책 — 조건').
- 사람 도형: 머리 원(r 7)+어깨 반원(폭 22). 운영 상태: 운영 중 = 본부 색 채움 / 구축 중 = 본부 색 50% 채움 / 운영 전 = 채움 없음 + 본부 색 점선 테두리. 모든 도형에 1px 진한 테두리(대비 보강).
- 상태 표시(색만으로 구분 금지 — 고리 + 아이콘 + 글자): 작업 중 = 실선 고리 good + 연필, 검토 중 = 점선 고리 보조 잉크 + 돋보기, 승인 대기 = 실선 고리 warning + 모래시계, 막힘 = 실선 고리 critical + 느낌표, 대기 = 고리 없음, 비활성 = 도형 40% 불투명 + 달. 아이콘은 머리 오른쪽 위 작은 원(r 6.5) 안. 상태가 바뀌면 고리가 한 번 퍼지는 펄스(600ms).
- 이름표: 직책 1줄(10px, 7자 넘으면 …), 작업 중·검토 중이면 그 아래 실행 주체 알약(Claude·Codex·Aside·스크립트, 무채색).
- 대표실: 대표 자리(큰 도형, 잉크 색) + '대표 영역(직원 업무 아님)' 칩(대표 몫 업무) + 승인 서류함(대기 건수 배지, 대기 중이면 경고색 은은한 펄스). AI 총괄 자리 3개(Claude·Codex·Aside — 둥근 사각 'AI' 도형, 무채색, 이름 + 지금 그 주체로 돌고 있는 작업 수). 행위자를 못 찾은 이벤트가 있으면 '미배정' 상자가 나타난다.
- 일감 전달: handoffs의 새 항목마다 출발 좌석 → 도착 좌석 곡선(2차 베지어)을 옅은 점선으로 그리고 점(r 4, 출발 본부 색, 1px 테두리)이 1.2초에 걸쳐 이동, 도착하면 도착 좌석 펄스. 승인 요청은 대표 서류함으로, 승인 결정은 대표 → 요청자(승인 체크/반려 X 모양 점). 동시에 최대 12개. `prefers-reduced-motion`이면 이동 없이 0.8초 화살표만.
- 상호작용: 사람에 마우스를 올리거나 포커스하면 툴팁(직책·id·팀·상태 아이콘+글자·운영 상태·현재 작업·실행 주체·마지막 메시지). 클릭·Enter = 상세 패널. 사람은 `role="button"`·`tabIndex=0`·`aria-label`('정기 브리핑 작가, 작업 중, 모닝 브리핑 초안 작성').
- 왼쪽 아래 범례: 상태 6종(아이콘+글자), 운영 상태 3종(도형), 점선 의자 = 확장 대기.

### 4.3 조직도 보기(HTML)

- 맨 위 대표이사 카드: 대표 역할 칩 + '대표 영역(직원 업무 아님)' 목록(대표 몫 업무). 아래 연결선 → AI 총괄 줄(Claude 카드 넓게, Codex·Aside) — 한 줄 역할 + 지금 작업 수.
- 본부 격자(auto-fit, minmax 320px): 본부 카드 = 위 색 막대, 본부명·본부장, 상태별 인원 작은 범례, 접기/펼치기(상태는 localStorage, try/catch). '모두 펼치기·모두 접기'.
- 팀 묶음: 팀명 + id(muted) + 팀 역할(툴팁). 직원 카드(한 줄 요약): 작은 사람 도형(운영 상태 모양) · 직책 · 상태 칩(아이콘+글자) · 운영 상태 꼬리표 · 실행 주체 알약, 둘째 줄 현재 작업(말줄임) 또는 '대기'. 클릭 = 상세 패널.
- 확장 대기 직책: 점선 카드 '확장 대기 · 직책' + 조건(작게).

### 4.4 승인 관문 레인(사이드 위)

- 제목 '대표 승인 대기 (n)'. 시뮬레이션: '체험용 시뮬레이션 — 실제 승인이 아닙니다.' / 실연결: '읽기 전용 — 실제 승인은 대시보드 밖에서 대표가 합니다.'
- 항목: 작업 제목, 요청자(본부 색 점+직책), 요약, 기다린 시간(시뮬레이션 시각 기준), 자동 승인이 켜져 있으면 남은 시간 막대('n초 뒤 자동 승인(시연)'). 버튼 [승인] [반려]는 `source.decide`가 있을 때만.
- 최근 결정 3건(접힘): 승인/반려, 자동 여부.

### 4.5 활동 피드(사이드 아래)

- 필터 한 줄: 본부(색 점 칩, 다중), 종류(전체·진행·검토·승인·막힘·완료·상태), 실행 주체(칩). 필터가 직원 색을 다시 칠하지 않는다.
- 줄: 시각(HH:MM:SS, 고정폭 숫자) · 본부 색 막대 3px · 행위자 직책(눌러서 상세) · 동작 문구(예: '→ 편집장에게 전달', '검토 요청 → 독립 검사관', '승인 요청', '자동 승인(시연)', '막힘: 사유') · 작업 제목(muted) · 실행 주체 알약 · 상태 아이콘. 최신이 위, 최대 200줄. 스크롤이 위에 있지 않을 때 새 이벤트가 오면 '새 활동 n건' 단추.

### 4.6 직원 상세 패널

머리(큰 사람 도형·직책·id·닫기) → 본부·팀(색 점) · 운영 상태 · 단계(P0~P2) · 위험 등급 → 지금(상태 아이콘+글자, 현재 작업, 실행 주체, 시작 시각) → 임무(role) → 담당 업무 목록 → 실행 주체 알약 · 검증(종류 + 검증자 직원 이름, 누르면 그 직원으로) → 최근 작업 10건(제목·상태 칩·시각) → 상태 이력(세로 목록: 시각·아이콘·글자·메시지) → 꼬리말 '역할 프로필입니다. 실제 실행 주체는 위 배지의 AI·스크립트입니다.'

### 4.7 요약 띠

1. 상태별 인원: 조직 직원 전원 기준 가로 누적 막대(상태 색, 조각 사이 2px 간격) + 범례(아이콘+글자+숫자). 2. 진행 중 작업(완료·반려 종료 외). 3. 승인 대기. 4. 막힘(0보다 크면 critical 아이콘). 5. 실행 주체별(오늘 생성 작업): Claude·Codex·Aside·스크립트 막대(한 가지 무채색 + 글자), 지금 진행 수 괄호. 6. AI가 대신한 업무(오늘): 완료 n건 + '절약 추정 h시간 m분' + 각주(시뮬레이션: '시뮬레이션 수치 · 추정' / 실연결: '추정 — 기준 분 표 기준'). 큰 숫자는 28px 600.

### 4.8 상단 바

- 모드 배지(알약): 시뮬레이션 = 노랑 계열 '시뮬레이션 모드 · 실제 데이터 아님' / 실연결 = 초록 점 깜빡임 '실시간 연결 · 라벨' / 파일 = 파랑 '실제 기록 파일 · 이름' / 오류 = 빨강 '연결 오류 · 내용'. 늘 보인다.
- 시뮬레이션 조작(control 있을 때만): ▶/⏸, 속도 분할 단추 1x·2x·5x, 시나리오 선택(하루 압축 재생·모닝 브리핑·마감 브리핑·증권사 리포트 정리·이상 상황·한가한 오전), '자동 승인(시연)' 스위치.
- 시각: 시뮬레이션은 '10월 17일(금) 06:42 · 시뮬레이션 시각', 실연결은 현재 시각 + '마지막 기록 hh:mm:ss'.
- 보기 전환(오피스·조직도), '파일 열기'(events.jsonl·json 선택 → 파일 소스로 바꿈; 창 전체에 끌어다 놓기도 됨), 테마(시스템·라이트·다크 순환, localStorage), 조직 기준 알약('조직 10/17 · Wiki 실시간' 또는 '· 저장된 사본', 툴팁에 해시 앞 8자리).

### 4.9 타임라인(되감기)

받은 이벤트의 첫 시각~마지막 시각 막대. 뒤에 60칸 이벤트 밀도 막대, 승인 요청(경고색)·막힘(critical) 눈금. 끌면 그 시각의 상태로 화면 전체가 바뀌고 본문 위에 '되감기 중 · 10:42:13 시점 [실시간으로]' 띠. 되감기 중에도 새 이벤트는 계속 쌓인다. 키보드: ←/→ 1%, Home/End.

### 4.10 바닥글(늘 보임)

'직원은 실행 중인 에이전트가 아니라 역할 프로필입니다. 실제 실행 주체는 Claude·Codex·Aside·스크립트입니다.' · '시뮬레이션 문구는 가상이며 투자 권유가 아닙니다.' · '리스크·준법·감사실 판정은 내부 검사이며 실제 금융회사·금융당국 승인이 아닙니다.' · '조직: Wiki 정본에서 만든 사본(생성 시각)'.

## 5. 시뮬레이터

- 시나리오 형식은 `src/types.ts`의 `Scenario`·`ScenarioStep`. `after`는 앞 단계 뒤 실제 초(1x). 한 시나리오 합계 약 180초(±20).
- 행위자 해석(`core/resolve.ts`): 문자열 → 특별 행위자 또는 직원 id(조직에 있으면). 객체 → ① duty를 맡은 직원 ② staff가 조직에 있으면 그 직원 ③ team(옛 id면 승계 팀)의 첫 직원 ④ 못 찾으면 `unassigned:<duty|staff|team>`(경고). 업무 기준이라 직원이 바뀌거나 옮겨도 시나리오는 그대로 돈다.
- 생략 규칙: start·complete·block·approval의 actor를 비우면 그 작업의 현재 담당자, start의 executor를 비우면 작업의 executor. handoff의 from을 비우면 현재 담당자.
- 작업 id: `시나리오id#회차/로컬id`, 이벤트 id: `sim-<seed>-<리셋 회차>-<번호>`(시나리오를 바꿔도 겹치지 않음), 승인 id: `작업id:A<n>`.
- 시계: 시뮬레이션 시각(KST, +09:00)은 구간마다 비율로 흐른다. 시나리오 구간 비율 = virtual_minutes×60 ÷ (본 단계 + on_approve 단계의 Σafter), 한가한 구간 비율 = (until − 지금) ÷ real_seconds(이미 지났으면 건너뜀). 승인을 기다리는 동안 시계는 그 구간 비율로 계속 간다. 이벤트 ts = 그 순간의 시뮬레이션 시각. 일시정지면 시계도 멈춘다. 속도(1·2·5)는 실제 경과에 곱한다.
- 승인 단계: `approval_requested`를 내고 그 시나리오의 진행을 멈춘다(시계·한가한 활동은 계속). 사용자가 승인/반려하면 `approval_decided`(staff_id 'ceo', executor 'human', payload.auto false) 뒤 on_approve/on_reject 단계를 실행하고 남은 본 단계로 이어 간다. 자동 승인이 켜져 있으면 20초÷속도 뒤 `payload.auto: true`, message '시뮬레이션 자동 승인'으로 승인한다.
- 하루 압축 재생(`day.json`): 06:00부터 구간을 차례로 재생하고 18:30이 지나면 다음 날 06:00부터 반복(날짜 +1). 단일 시나리오 선택 시: 한가한 15초 → 시나리오 → 한가한 30초 → 다시. '한가한 오전'은 09:00~12:00 한가한 활동만 180초 반복.
- 한가한 활동(`idle.json`): 시드 RNG로 직원을 운영 상태 가중치(운영 중 3·구축 중 2·운영 전 1)에 따라 고르고, 그 직원의 담당 업무 제목으로 생성 → 시작 → (확률적으로 검증자에게 검토) → 완료를 8~20초에 돈다. 시나리오가 도는 동안에는 빈도를 절반으로. 이미 일하는 직원은 고르지 않는다.
- 결정성: 시드·시계·타이머를 주입할 수 있게 만든다(시험에서 가짜 시계로 끝까지 돌린다).

## 6. 색·글꼴·움직임

- 본부 색(엔티티 고정, `DEPT_COLOR_SLOTS`) — 검증 완료(dataviz 검사기, 인접 CVD ΔE ≥ 8.4, 정상 시각 ≥ 19.3). 라이트에서 슬롯 3·4·5는 바탕 대비 3:1 미만 → 이름표·범례 글자를 늘 함께 보여 준다(색만으로 구분하지 않음).

| 슬롯 | 본부 | 라이트 | 다크 |
|---|---|---|---|
| 1 | ops | #2a78d6 | #3987e5 |
| 2 | inv | #eb6834 | #d95926 |
| 3 | wms | #1baf7a | #199e70 |
| 4 | med | #eda100 | #c98500 |
| 5 | rsk | #e87ba4 | #d55181 |
| 6 | sys | #008300 | #008300 |
| 7 | (새 본부) | #6250d6 | #9085e9 |
| 8 | (새 본부) | #e34948 | #e66767 |

- 상태 색(예약, 아이콘+글자와 함께만): good #0ca30c, warning #fab219, serious #ec835a, critical #d03b3b. 검토 중은 보조 잉크 점선.
- 바탕·잉크: 라이트 page #f6f6f3 · surface-1 #fcfcfb · surface-2 #f1f0ec · 잉크 #0b0b0b / 보조 #52514e / muted #898781 · 선 rgba(11,11,11,.10). 다크 page #0d0d0d · surface-1 #1a1a19 · surface-2 #232321 · 잉크 #f0efec / 보조 #c3c2b7 / muted #898781 · 선 rgba(255,255,255,.10). 다크는 `prefers-color-scheme`과 `:root[data-theme]` 두 범위 모두 정의(수동 전환이 이김).
- 글꼴: Pretendard Variable(npm `pretendard`, dynamic subset), 대체 system-ui. 기본 14px, 작은 글 12px, 아주 작은 11px. 숫자 열은 tabular-nums.
- 움직임: UI 160ms, 이동 1.2s, cubic-bezier(.2,.7,.2,1). `prefers-reduced-motion` 존중. 장식·픽셀 아트·그림자 남용 금지(카드 그림자는 0 1px 2px 정도).
- 접근성: 상태는 색+아이콘+글자, 포커스 테두리 2px, 단추 aria-label, 대비 4.5:1(본문 글자).

## 7. 실연결(읽기 전용)

- `?source=jsonl&url=…&interval=5`: 주기적으로 읽어 새 event_id만 반영. JSONL(줄마다 1건) 또는 JSON 배열. 잘못된 줄은 건너뛰고 개수를 상태에 표시. 파일이 짧아지면(교체) 처음부터 다시 읽되 이미 본 id는 버린다. 실패하면 5→10→30초로 재시도.
- 개발 서버(`npm run dev`)만 `/__pbai/events`(PBAI_EVENTS_PATHS 중 처음 있는 파일), `/__pbai/status`, `/__pbai/org`를 제공한다. 기본은 이 PC(루프백)에서 온 요청만 받는다(`PBAI_ALLOW_LAN=1`이면 허용). 응답에 절대 경로를 넣지 않는다(`경로 1`, `경로 2` 같은 이름만).
- 개발 서버에서 `?source=jsonl`에 url이 없으면 `/__pbai/events`, 배포 사이트에서는 `sample/events.sample.jsonl`(가짜)을 쓴다.
- 파일 열기·끌어다 놓기: 브라우저 안에서만 읽는다(업로드 없음). 배지 '실제 기록 파일 · 이름'.
- WebSocket: `?source=ws&url=wss://…` — 메시지 1개 = 이벤트 1건 또는 배열. 서버가 아직 없어 '미검증'.

## 8. 참고한 사례

| 사례 | 가져온 것 | 가져오지 않은 것 |
|---|---|---|
| Sococo(위에서 내려다본 평면도, 방 단위, 활동을 깜빡임으로 표시) https://www.sococo.com/ | 본부 = 방, 팀 = 책상 섬, 은은한 활동 펄스 | 화상·음성 기능 |
| Roam(AI 에이전트가 사무실 지도의 상주 인원) https://ro.am/ | Claude·Codex·Aside를 대표실 옆 상주 자리로 | 여러 층 |
| Pixel Agents(Claude Code JSONL 기록으로 캐릭터가 실제 활동을 따라 움직임, 폴더 = 구역) https://github.com/pixel-agents-hq/pixel-agents | 이벤트 기록(JSONL) 기반 활동, 구역 = 본부 | 픽셀 아트 |
| Ctrl/Cubicles(에이전트 사무실 + 공유 웹 대시보드) | 정적 웹 대시보드로 공유 | 실데이터 공개 공유 |
| claw-empire(로컬 우선 AI 에이전트 회사 시뮬레이터, React+Vite) https://github.com/GreenSheep01201/claw-empire | 가상 회사 비유, 같은 스택 | 에이전트 실제 실행(여기는 관전만) |

## 9. 품질 기준

- `npm test`(조직 구조·reducer 재생·스키마·시뮬레이터 끝까지·폴링 파싱·org-lib), `npm run build`, `npm run check:public` 통과.
- 브라우저에서 시나리오 4개 + 한가한 오전 + 하루 압축 재생이 끝까지 돌고, 승인/반려 버튼·자동 승인·되감기·다크 모드·휴대폰 폭이 동작하는지 직접 확인(확인한 것과 못 한 것을 나눠 기록).
