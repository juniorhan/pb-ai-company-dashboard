# PB AI 회사 관제실

1인 + AI 조직 'PB AI 회사'의 조직도와 일하는 모습을 한 화면에서 보는 2D 대시보드입니다. 지금은 **가짜 데이터 시뮬레이션**으로 움직이고, 나중에 실제 실행 기록(events.jsonl)에 **어댑터만 바꿔** 연결합니다.

- 공개 주소: https://juniorhan.github.io/pb-ai-company-dashboard/ (시뮬레이션만)
- 설계: [docs/DESIGN.md](docs/DESIGN.md) · 이벤트 형식: [docs/EVENT_SPEC.md](docs/EVENT_SPEC.md) · 결정 기록: [docs/DECISIONS.md](docs/DECISIONS.md) · 작업 규칙: [AGENTS.md](AGENTS.md)

## 먼저 알아 둘 전제

- **직원은 역할 프로필**입니다. 실행 중인 에이전트 수가 아닙니다. 실제로 일하는 주체는 Claude·Codex·Aside·스크립트이고, 화면의 모든 작업에 실행 주체 배지가 붙습니다.
- 화면 위쪽 배지가 늘 모드를 보여 줍니다. '시뮬레이션 모드 · 실제 데이터 아님' 또는 '실시간 연결'.
- 리스크·준법·감사실의 판정은 **내부 검사**입니다. 실제 금융회사·금융당국의 승인이 아닙니다.
- 시뮬레이션 문구는 가상이며 투자 권유가 아닙니다. 대표 몫(종목·비중·매매 입력, 콜 기록 등)은 직원 업무가 아니라 '대표 영역'으로 따로 보입니다.

## 실행

Node 20.19 이상(24 권장).

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # 시험(조직 사본 무결성·상태 계산 재생·이벤트 형식·시뮬레이터·소스)
npm run build      # dist/ 생성(GitHub Pages용 경로 /pb-ai-company-dashboard/)
npm run preview    # 빌드 결과 미리 보기(http://localhost:4173/pb-ai-company-dashboard/)
npm run check:public   # 공개 저장소 검사(비밀값·개인정보·내부 경로 모양)
```

## 화면

- **오피스(관전)**: 위에서 내려다본 평면도입니다. 본부가 방, 팀이 책상 섬이고, 대표실과 AI 총괄(Claude·Codex·Aside) 자리가 가운데에 있습니다. 상태가 바뀌면 그 직원 자리가 펄스로 강조됩니다. 일감이 넘어가면 점이 방 사이를 이동합니다.
- **조직도**: 대표이사 → AI 총괄 → 본부(접기·펼치기) → 팀 → 직원 카드. 확장 대기 직책은 점선 빈자리로 보입니다.
- **승인 관문 레인**: 대표 승인 대기 항목을 모읍니다. 시뮬레이션에서는 승인·반려를 직접 눌러 볼 수 있고, 약 20초 뒤 자동으로 승인됩니다(끌 수 있음, 실제 승인 아님).
- **활동 피드**(본부·종류·실행 주체 필터), **직원 상세 패널**, **요약 카드**('AI가 대신한 업무' 추정 포함), **타임라인 되감기**, 다크 모드, 휴대폰 화면.

### 주소 쿼리

| 쿼리 | 값 | 기본 |
|---|---|---|
| `source` | `sim`(시뮬레이션) · `jsonl`(주기적 읽기) · `ws`(WebSocket, 미검증) · `file` | `sim` |
| `url` | `jsonl`·`ws`가 읽을 주소(개발 서버에서만, 공개 사이트는 무시) | 개발 서버는 `/__pbai/events`, 배포 사이트는 가짜 샘플 |
| `interval` | `jsonl` 읽기 간격(초) | `5` |
| `scenario` | `day`(하루 압축 재생) · `morning-briefing` · `closing-briefing` · `report-digest` · `anomaly` · `idle-morning` | `day` |
| `speed` | `1` · `2` · `5` | `1` |
| `view` | `office` · `org` | `office` |
| `auto` | `0`이면 자동 승인 끔 | 켬 |
| `seed` | 시뮬레이션 난수 시드(같으면 같은 흐름) | 매번 다름 |

## 실제 PB AI 회사 기록에 연결하기

대시보드가 받는 입력은 이벤트 한 종류뿐입니다. 형식은 [docs/EVENT_SPEC.md](docs/EVENT_SPEC.md)를 보세요. 종류는 9가지(작업 생성·시작·전달·검토 요청·승인 요청·승인 결정·막힘·완료·상태 변경)입니다. events.jsonl 예시 3줄:

```jsonl
{"v":1,"event_id":"ex-1","ts":"2026-10-17T06:30:00+09:00","type":"task_created","staff_id":"med-01-e03","executor":"aside","task_id":"mb-1","message":"모닝 브리핑 초안 작업을 만들었습니다","payload":{"title":"모닝 브리핑 초안 작성","duty":"com-01-T05","manual_minutes":45}}
{"v":1,"event_id":"ex-2","ts":"2026-10-17T06:41:00+09:00","type":"task_handoff","staff_id":"med-01-e03","executor":"claude","task_id":"mb-1","message":"편집장에게 초안을 넘깁니다","payload":{"to":"med-01-e01","kind":"review"}}
{"v":1,"event_id":"ex-3","ts":"2026-10-17T07:02:00+09:00","type":"approval_decided","staff_id":"ceo","executor":"human","task_id":"mb-1","message":"게시 승인","payload":{"approval_id":"mb-1:A1","decision":"approve"}}
```

실데이터는 **공개 사이트에 올리지 않습니다.** 아래 셋 중 하나로 각자의 PC에서만 봅니다. 실연결 화면은 읽기 전용이라 재생·승인 단추가 없습니다.

1. **로컬 개발 서버(권장)**: `.env.example`을 `.env.local`로 복사합니다. `PBAI_EVENTS_PATHS`에 이 PC의 events.jsonl 경로를 `;`로 구분해 적습니다(Google Drive 동기화 폴더 경로도 됩니다. 처음 있는 파일을 씁니다). 그다음 `npm run dev`를 실행하고 `http://127.0.0.1:5173/?source=jsonl`을 엽니다. 개발 서버는 기본적으로 이 PC에서 온 요청만 받습니다(`PBAI_ALLOW_LAN=1`이면 같은 네트워크 허용).
2. **파일 열기**: 상단 '파일 열기'를 누르거나 창에 events.jsonl을 끌어다 놓습니다. 파일은 브라우저 안에서만 읽고 어디에도 올리지 않습니다(50MB 이하).
3. **주소 지정(개발 서버에서만)**: `npm run dev`로 띄운 화면에서 `?source=jsonl&url=<주소>&interval=5`. 그 주소가 교차 출처 요청(CORS)을 허용해야 합니다. WebSocket은 `?source=ws&url=wss://…`이며 아직 실서버로 검증하지 않았습니다. 공개 사이트는 `url`을 무시하고 가짜 샘플만 읽습니다(남이 만든 링크로 바깥 기록을 띄우지 못하게).

`JsonlPollingSource`는 주기적으로 파일 전체를 읽어 새 `event_id`만 반영합니다. 잘못된 줄은 건너뛰고 개수를 표시합니다. 실패하면 5 → 10 → 30초 간격으로 다시 시도합니다.

### 여러 PC에서 쓰기

PC마다 이 저장소를 받고 `npm install`을 실행합니다. 그다음 그 PC의 경로로 `.env.local`을 만듭니다(`.env.local`은 git에 올라가지 않습니다). 조직 사본과 시나리오는 저장소에 있으므로 어느 PC든 같은 화면이 나옵니다.

## 조직 바꾸기(직원·팀·본부 추가·변경)

조직의 정본은 PB AI 회사 Wiki(비공개)입니다. 이 저장소의 `src/data/org.json`은 생성 사본이므로 **손으로 고치지 않습니다.**

1. Wiki에서 조직을 바꿉니다(PB AI 회사의 조직 변경 절차). 대표 역할·대표 몫 업무·AI 총괄·확장 대기 직책·본부 순서는 `04_조직 부속표`에서 고칩니다.
2. 이 저장소에서 `npm run sync:org`를 실행합니다. Wiki 위치는 `.env.local`의 `PBAI_WIKI_ORG_DIR`이고, 정본이 바뀐 경우에만 사본을 다시 씁니다. 쓸 때 경로·메일·비밀값 모양을 걸러 냅니다.
3. `npm test`(시나리오 행위자 해석 포함)와 `npm run check:public`을 통과하면 커밋하고 push합니다.

본부·팀·직원 수와 이름은 코드에 박혀 있지 않습니다. 화면 배치와 색 배정은 사본에서 계산합니다. 새 본부는 빈 색 슬롯을 씁니다. 로컬 개발 서버는 `PBAI_WIKI_ORG_DIR`이 있으면 Wiki를 바로 읽어 늘 최신 조직을 보여 줍니다.

## 시나리오 추가

`src/scenarios/`에 JSON 파일을 하나 넣으면 코드 수정 없이 시나리오 메뉴에 나타납니다. 형식은 `src/types.ts`의 `Scenario`, 설명은 [docs/DESIGN.md](docs/DESIGN.md) §5에 있습니다.

```json
{
  "id": "my-scenario", "title": "새 시나리오", "description": "한 줄 설명", "order": 60,
  "start": "11:00", "virtual_minutes": 30,
  "steps": [
    { "after": 0, "do": "create", "task": "t1", "title": "일반 작업명", "actor": { "duty": "rsc-03-T10" }, "executor": "claude", "manual_minutes": 20 },
    { "after": 3, "do": "start", "task": "t1" },
    { "after": 20, "do": "review", "task": "t1", "reviewer": { "duty": "cmp-01-T02" }, "executor": "codex" },
    { "after": 15, "do": "complete", "task": "t1" }
  ]
}
```

- 행위자는 직원 id보다 **담당 업무 id(`duty`)** 로 지정합니다. 그래야 직원이 바뀌거나 옮겨도 그대로 돕니다. 찾는 순서는 업무 → 직원 → 팀이고, 못 찾으면 '미배정'으로 보입니다.
- `after`는 앞 단계 뒤 실제 초(1x)입니다. 승인 단계는 `"do": "approval"`에 `on_approve`·`on_reject` 단계를 넣습니다.
- 문구에 종목명·매매 지시·투자 권유를 쓰지 않습니다. 일반 작업명만 씁니다.

## 폴더

```
src/
  types.ts        공유 계약(조직·이벤트·상태·소스·스토어·시나리오·표기)
  config.ts       주소 쿼리 → 설정
  data/           org.json(생성 사본) · org.ts(읽기·검사·색인) · schema.ts(이벤트 검사)
  core/           reducer(순수 상태 계산) · eventlog(정렬·중복 제거·되감기) · store · resolve
  sim/            시뮬레이터(시계·시나리오 실행·한가한 활동·자동 승인)
  sources/        SimulatorSource · JsonlPollingSource · FileSource · WebSocketSource
  scenarios/      시나리오·하루 계획·한가한 활동 설정(JSON)
  ui/             화면
  styles/         색 토큰(라이트·다크)
scripts/          sync-org(Wiki → 사본) · check-public(공개 검사) · 개발 서버 플러그인(/__pbai/*)
public/sample/    가짜 events.jsonl(배포 사이트의 jsonl 시연용)
docs/             설계 · 이벤트 명세 · 결정 기록
```

## 배포

`main`에 push하면 GitHub Actions(`.github/workflows/deploy.yml`)가 공개 검사 → 시험 → 빌드를 거쳐 GitHub Pages에 배포합니다. 처음 한 번은 저장소 Settings → Pages → Source를 'GitHub Actions'로 정해야 합니다.

## 라이선스

저장소 주인이 정합니다(아직 없음).
