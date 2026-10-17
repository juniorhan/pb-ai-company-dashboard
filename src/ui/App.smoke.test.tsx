// @vitest-environment jsdom
// 화면 전체를 가짜 스토어(와 실제 코어의 파일 소스)로 그려 보는 훑기 시험. 배치·색은 못 보지만 글자·역할·동작은 본다.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import bundledOrg from '../data/org.json';
import { indexOrg, OrgError, parseOrg } from '../data/org';
import { createMockStore } from './dev/mockStore';
import type { MockStore } from './dev/mockStore';
import { ErrorBoundary, ErrorScreen } from './ErrorScreen';
import { FILE_REJECT_TEXT, isEventFileName, useFileDrop } from './FileDrop';
import { createRuntime } from './runtime';
import type { Runtime } from './runtime';

const index = indexOrg(parseOrg(bundledOrg));
const WRITER = 'med-01-e03';        // 정기 브리핑 작가
const EDITOR = 'med-01-e01';        // 편집장
const stores: MockStore[] = [];

function makeRuntime(opts: Parameters<typeof createMockStore>[1] = {}): Runtime {
  const store = createMockStore(index, { autoRun: false, seed: 3, prerun: 70, ...opts });
  stores.push(store);
  return {
    index, store, orgMeta: { origin: 'bundled', generatedAt: index.org.meta.generated_at, hash: index.org.meta.source_hash },
    orgNote: null, mode: 'mock', fileName: null, initialView: 'office',
  };
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* 저장소를 못 쓰는 환경이어도 시험은 돈다 */ }
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  while (stores.length) stores.pop()!.dispose();
});

describe('App 훑기 시험(가짜 스토어)', () => {
  it('모드 배지 · 직원 버튼 수 = 조직 직원 수 · 바닥글 문구', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);

    // 모드 배지는 늘 보인다
    expect(screen.getByText('시뮬레이션 모드 · 실제 데이터 아님')).toBeTruthy();

    // 오피스의 직원 도형은 role="button", 직원 수만큼
    const glyphs = container.querySelectorAll('[data-staff-id]');
    expect(glyphs).toHaveLength(index.org.staff.length);
    for (const g of glyphs) {
      expect(g.getAttribute('role')).toBe('button');
      expect(g.getAttribute('tabindex')).toBe('0');
      expect(g.getAttribute('aria-label')).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /^정기 브리핑 작가, / })).toBeTruthy();

    // 바닥글(늘 보임)
    expect(screen.getByText(/직원은 실행 중인 에이전트가 아니라 역할 프로필입니다/)).toBeTruthy();
    expect(screen.getByText('시뮬레이션 문구는 가상이며 투자 권유가 아닙니다.')).toBeTruthy();
    expect(screen.getByText('리스크·준법·감사실 판정은 내부 검사이며 실제 금융회사·금융당국 승인이 아닙니다.')).toBeTruthy();
    expect(screen.getByText(/^조직: Wiki 정본에서 만든 사본\(.+ 생성\)$/)).toBeTruthy();
  });

  it('요약 띠·승인 레인·활동 피드·타임라인·대표실·AI 총괄이 함께 그려진다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    expect(screen.getByText(`상태별 인원 · 전체 ${index.org.staff.length}명`)).toBeTruthy();
    expect(screen.getByText('진행 중 작업')).toBeTruthy();
    expect(screen.getByText('AI가 대신한 업무 · 오늘')).toBeTruthy();
    expect(screen.getByText('시뮬레이션 수치 · 추정')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^대표 승인 대기 \(\d+\)$/ })).toBeTruthy();
    expect(screen.getByText('체험용 시뮬레이션 — 실제 승인이 아닙니다')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '활동 피드' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '타임라인 되감기' })).toBeTruthy();
    expect(screen.getByText('대표 영역(직원 업무 아님)')).toBeTruthy();
    for (const hq of index.org.hq) expect(container.querySelector(`[data-actor-id="${hq.id}"]`)).not.toBeNull();
    expect(container.querySelectorAll('.feed-row').length).toBeGreaterThan(10);
    // 시뮬레이션 조작
    expect(screen.getByRole('switch', { name: '자동 승인(시연)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1배속' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '시나리오' })).toBeTruthy();
  });

  it('접근성 훑기: 단추·입력·슬라이더·스위치마다 이름이 있고, id가 겹치지 않으며, aria 참조가 실제 요소를 가리킨다', () => {
    const sweep = (container: HTMLElement, where: string): void => {
      for (const role of ['button', 'combobox', 'slider', 'switch', 'link', 'dialog'] as const) {
        const all = screen.queryAllByRole(role, { hidden: true });           // hidden: 접근성 트리 계산을 건너뛰어 빠르게(시험 환경에는 CSS가 없다)
        const named = screen.queryAllByRole(role, { hidden: true, name: /\S/ });
        expect(named.length, `${where}: ${role} 중 이름 없는 요소`).toBe(all.length);
      }
      const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
      expect(new Set(ids).size, `${where}: 중복 id`).toBe(ids.length);
      for (const el of container.querySelectorAll('[aria-labelledby],[aria-controls],[aria-describedby]')) {
        for (const attr of ['aria-labelledby', 'aria-controls', 'aria-describedby']) {
          // 접힌 펼침 단추(aria-expanded="false")는 안 그려진 내용을 가리켜도 된다(펼치면 그려진다).
          if (attr === 'aria-controls' && el.getAttribute('aria-expanded') === 'false') continue;
          for (const ref of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
            expect(document.getElementById(ref), `${where}: ${attr}="${ref}"가 가리키는 요소`).not.toBeNull();
          }
        }
      }
    };
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    sweep(container, '오피스');
    fireEvent.click(container.querySelector(`[data-staff-id="${WRITER}"]`)!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    sweep(container, '오피스 + 상세 서랍');
    fireEvent.click(screen.getByRole('button', { name: '상세 닫기' }));
    fireEvent.click(screen.getByRole('button', { name: /^필터$/ }));
    sweep(container, '피드 필터 펼침');
    fireEvent.click(screen.getByRole('button', { name: /조직도/ }));
    sweep(container, '조직도');
  }, 30_000);

  it('리스크·준법·감사실 방에만 "내부 검사이며 실제 준법 승인이 아님"이 붙는다', () => {
    render(<App initialRuntime={makeRuntime()} />);
    const notes = screen.queryAllByText('내부 검사이며 실제 준법 승인이 아님');
    expect(notes).toHaveLength(index.depts.has('rsk') ? 1 : 0);
  });

  it('직원을 누르면 상세 서랍이 열리고 Esc로 닫히며, 포커스가 옮겨 갔다 돌아온다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    const glyph = container.querySelector(`[data-staff-id="${WRITER}"]`) as SVGGElement;
    glyph.focus();
    fireEvent.click(glyph);
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: '정기 브리핑 작가' })).toBeTruthy();
    expect(within(drawer).getByText(WRITER)).toBeTruthy();
    expect(within(drawer).getByText('역할 프로필입니다. 실제 실행 주체는 위 배지의 AI·스크립트입니다.')).toBeTruthy();
    expect(document.activeElement).toBe(drawer);

    // 검증자 이름을 누르면 그 직원으로 바뀐다
    const checkerId = index.staff.get(WRITER)!.checker_staff[0];
    if (checkerId) {
      const name = index.staff.get(checkerId)!.name;
      fireEvent.click(within(drawer).getByRole('button', { name }));
      expect(within(screen.getByRole('dialog')).getByRole('heading', { name })).toBeTruthy();
    }

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(glyph);
  });

  it('서랍 바깥을 누르면 닫히고, 닫기 단추로도 닫힌다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    fireEvent.click(container.querySelector(`[data-staff-id="${EDITOR}"]`)!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('heading', { name: '활동 피드' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(container.querySelector(`[data-staff-id="${EDITOR}"]`)!);
    fireEvent.click(screen.getByRole('button', { name: '상세 닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('대표·AI 총괄도 같은 서랍에서 본다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    fireEvent.click(container.querySelector('[data-actor-id="ceo"]')!);
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: index.org.ceo.title })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText(/대표는 직원이 아니라 사람입니다/)).toBeTruthy();
    const hq = index.org.hq[0]!;
    fireEvent.click(container.querySelector(`[data-actor-id="${hq.id}"]`)!);
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: hq.name })).toBeTruthy();
  });

  it('조직도로 바꾸면 직원 카드가 직원 수만큼, 접기·펼치기가 저장된다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    fireEvent.click(screen.getByRole('button', { name: /조직도/ }));
    expect(container.querySelector('.office-svg')).toBeNull();
    expect(container.querySelectorAll('.staff-card')).toHaveLength(index.org.staff.length);
    expect(container.querySelectorAll('.exp-card')).toHaveLength(index.org.expansion.length);
    expect(container.querySelectorAll('.dept')).toHaveLength(index.org.depts.length);

    fireEvent.click(screen.getByRole('button', { name: '모두 접기' }));
    expect(container.querySelectorAll('.staff-card')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('pbai.collapsed') ?? 'null')).toEqual(index.org.depts.map((d) => d.id));
    fireEvent.click(screen.getByRole('button', { name: '모두 펼치기' }));
    expect(container.querySelectorAll('.staff-card')).toHaveLength(index.org.staff.length);
  });

  it('테마 단추는 시스템 → 라이트 → 다크 순으로 돌고 localStorage·<html data-theme>에 반영된다', () => {
    render(<App initialRuntime={makeRuntime()} />);
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^테마: 시스템/ }));
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('pbai.theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /^테마: 라이트/ }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /^테마: 다크/ }));
    expect(root.getAttribute('data-theme')).toBeNull();
    expect(localStorage.getItem('pbai.theme')).toBe('system');
  });

  it('타임라인: ← 키로 되감으면 띠가 나오고 [실시간으로]·End로 돌아온다', async () => {
    const rt = makeRuntime();
    render(<App initialRuntime={rt} />);
    expect(screen.queryByText(/되감기 중/)).toBeNull();
    const slider = screen.getByRole('slider', { name: '타임라인 되감기' });
    expect(slider.getAttribute('aria-valuetext')).toBe('실시간');
    expect(Number(slider.getAttribute('aria-valuenow'))).toBe(100);

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(rt.store.getView().cursor).not.toBe('live');
    await waitFor(() => expect(screen.getByText(/^되감기 중 · [0-9]{2}:[0-9]{2}:[0-9]{2} 시점$/)).toBeTruthy());
    expect(slider.getAttribute('aria-valuetext')).toMatch(/시점$/);
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeLessThan(100);

    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(Number(slider.getAttribute('aria-valuenow'))).toBe(0));

    fireEvent.click(screen.getAllByRole('button', { name: '실시간으로' })[0]!);
    expect(rt.store.getView().cursor).toBe('live');
    await waitFor(() => expect(screen.queryByText(/되감기 중/)).toBeNull());

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByText(/되감기 중/)).toBeTruthy());
    fireEvent.keyDown(slider, { key: 'End' });
    expect(rt.store.getView().cursor).toBe('live');
    await waitFor(() => expect(screen.queryByText(/되감기 중/)).toBeNull());
  });

  it('승인 대기가 있으면 [승인][반려] 단추가 있고, 누르면 레인에서 내려간다(시뮬레이션)', async () => {
    const rt = makeRuntime({ prerun: 0 });
    rt.store.source.control!.setAutoApprove(false);
    let guard = 0;
    while (!Object.values(rt.store.getView().state.approvals).some((a) => a.status === 'pending') && guard++ < 800) (rt.store as MockStore).advance(1);
    render(<App initialRuntime={rt} />);
    const before = Object.values(rt.store.getView().state.approvals).filter((a) => a.status === 'pending').length;
    expect(before).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: `대표 승인 대기 (${before})` })).toBeTruthy();
    const approve = screen.getAllByRole('button', { name: /승인$/ }).filter((b) => b.classList.contains('btn-approve'));
    expect(approve.length).toBe(before);
    expect(screen.getAllByRole('button', { name: /반려$/ })).toHaveLength(before);
    fireEvent.click(approve[0]!);
    await waitFor(() => expect(screen.getByRole('heading', { name: `대표 승인 대기 (${before - 1})` })).toBeTruthy());
  });

  it('활동 피드 필터: 종류를 고르면 줄이 줄고 해제하면 돌아온다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    const all = container.querySelectorAll('.feed-row').length;
    fireEvent.click(screen.getByRole('button', { name: /^필터$/ }));
    fireEvent.click(screen.getByRole('button', { name: '승인' }));
    const rows = [...container.querySelectorAll('.feed-row')];
    expect(rows.length).toBeLessThan(all);
    for (const r of rows) expect(r.getAttribute('data-kind')).toBe('approval');
    fireEvent.click(screen.getByRole('button', { name: '필터 해제' }));
    expect(container.querySelectorAll('.feed-row')).toHaveLength(all);
  });
});

describe('연결(runtime) · 파일 열기 · 끌어다 놓기 · 오류 화면', () => {
  it('createRuntime(?mock=1)로 시작해 로딩 화면 뒤 대시보드가 나온다', async () => {
    window.history.pushState({}, '', '/?mock=1&autorun=0&seed=4');
    try {
      render(<App />);
      expect(screen.getByRole('status').textContent).toContain('조직을 불러오는 중');
      await waitFor(() => expect(screen.getByText('시뮬레이션 모드 · 실제 데이터 아님')).toBeTruthy());
      expect(screen.getByText(/개발용 가짜 데이터로 연결했습니다/)).toBeTruthy();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('실제 코어(시뮬레이터)로 연결해도 같은 화면이 나온다', async () => {
    const rt = await createRuntime('?scenario=morning-briefing&seed=5&speed=5');
    try {
      expect(rt.mode).toBe('core');
      const { container } = render(<App initialRuntime={rt} />);
      expect(screen.getByText('시뮬레이션 모드 · 실제 데이터 아님')).toBeTruthy();
      expect(container.querySelectorAll('[data-staff-id]')).toHaveLength(rt.index.org.staff.length);
      expect(screen.getByRole('switch', { name: '자동 승인(시연)' })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: '시나리오' })).toBeTruthy();
    } finally {
      cleanup();
      rt.store.dispose();
    }
  });

  it('파일 열기: 읽기 전용 화면으로 바뀌고(조작 단추 없음) 배지가 파일 이름을 보여 준다', async () => {
    const lines = [
      { v: 1, event_id: 'f-1', ts: '2026-10-17T06:30:00+09:00', type: 'task_created', staff_id: WRITER, executor: 'aside', task_id: 'mb-1', message: '모닝 브리핑 초안 작업을 만들었습니다', payload: { title: '모닝 브리핑 초안 작성', manual_minutes: 45 } },
      { v: 1, event_id: 'f-2', ts: '2026-10-17T06:31:00+09:00', type: 'task_started', staff_id: WRITER, executor: 'aside', task_id: 'mb-1', message: '시작' },
      { v: 1, event_id: 'f-3', ts: '2026-10-17T06:40:00+09:00', type: 'approval_requested', staff_id: WRITER, executor: 'aside', task_id: 'mb-1', message: '승인 요청', payload: { approval_id: 'mb-1:A1', summary: '게시 승인 요청' } },
    ];
    const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{잘못된 줄\n`;
    const file = new File([text], 'events.sample.jsonl', { type: 'application/json' });
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('실제 기록 파일 · events.sample.jsonl')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('heading', { name: '대표 승인 대기 (1)' })).toBeTruthy());
    expect(screen.getByText('읽기 전용 — 실제 승인은 대시보드 밖에서 대표가 합니다')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '자동 승인(시연)' })).toBeNull();
    expect(screen.queryByRole('button', { name: '재생' })).toBeNull();
    expect(container.querySelectorAll('.btn-approve')).toHaveLength(0);
    expect(screen.getByText('모닝 브리핑 초안 작성', { selector: '.ap-title' })).toBeTruthy();
    expect(screen.getByText(/읽음 3건 · 잘못된 줄 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '원래 소스로 돌아가기' })).toBeTruthy();
    expect(screen.getByText('시뮬레이션 문구는 가상이며 투자 권유가 아닙니다.')).toBeTruthy();
  });

  it('끌어다 놓기: 파일을 끌면 안내 덮개가 보이고, 잘못된 확장자는 안내만 한다', () => {
    const { container } = render(<App initialRuntime={makeRuntime()} />);
    const drag = (type: string, payload: object): void => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: payload });
      act(() => { window.dispatchEvent(e); });
    };
    expect(container.querySelector('.drop-overlay')).toBeNull();
    drag('dragenter', { types: ['Files'] });
    expect(container.querySelector('.drop-overlay')).not.toBeNull();
    expect(screen.getByText('여기에 events.jsonl 파일을 놓으세요')).toBeTruthy();
    expect(screen.getByText('파일은 업로드되지 않고 이 브라우저 안에서만 읽습니다')).toBeTruthy();
    drag('dragleave', { types: ['Files'] });
    expect(container.querySelector('.drop-overlay')).toBeNull();

    drag('dragenter', { types: ['Files'] });
    drag('drop', { types: ['Files'], files: [new File(['x'], 'photo.png')] });
    expect(container.querySelector('.drop-overlay')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(FILE_REJECT_TEXT);

    drag('dragenter', { types: ['text/plain'] });                 // 파일이 아니면 덮개가 없다
    expect(container.querySelector('.drop-overlay')).toBeNull();
  });

  it('끌어다 놓기: 앞 파일을 읽는 중이면 새 파일은 넘기지 않되, 브라우저가 파일을 열어 버리지 못하게 막는다', () => {
    const got: string[] = [];
    const Harness = ({ enabled }: { enabled: boolean }) => {
      const dragging = useFileDrop((f) => got.push(f.name), () => undefined, enabled);
      return <p>{dragging ? '끄는 중' : '대기'}</p>;
    };
    const fire = (type: string, files: File[]): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files } });
      act(() => { window.dispatchEvent(e); });
      return e;
    };
    const { rerender } = render(<Harness enabled={false} />);
    expect(fire('dragenter', []).defaultPrevented).toBe(true);
    expect(screen.getByText('대기')).toBeTruthy();                       // 덮개 상태(끄는 중)로 바뀌지 않는다
    expect(fire('drop', [new File(['x'], 'a.jsonl')]).defaultPrevented).toBe(true);
    expect(got).toEqual([]);
    rerender(<Harness enabled />);
    fire('drop', [new File(['x'], 'b.jsonl')]);
    expect(got).toEqual(['b.jsonl']);
  });

  it('받는 파일 확장자', () => {
    for (const name of ['events.jsonl', 'a.JSON', 'x.ndjson', 'log.txt']) expect(isEventFileName(name), name).toBe(true);
    for (const name of ['photo.png', 'events', 'events.jsonl.exe', 'a.csv']) expect(isEventFileName(name), name).toBe(false);
  });

  it('오류 화면: 조직 사본 오류는 sync:org 안내, 그 밖의 오류는 일반 안내', () => {
    const { rerender } = render(<ErrorScreen error={new OrgError('조직 사본 검사 실패(1건) — 개수 불일치: staff 표시 68 / 실제 67')} />);
    expect(screen.getByRole('heading', { name: '조직 사본이 올바르지 않습니다' })).toBeTruthy();
    expect(screen.getByText(/개수 불일치/)).toBeTruthy();
    expect(screen.getByText('npm run sync:org')).toBeTruthy();
    expect(screen.getByText(/조직 사본을 다시 만드세요/)).toBeTruthy();
    expect(screen.getByText(/연결 오류 · 조직 사본을 읽지 못했습니다/)).toBeTruthy();
    rerender(<ErrorScreen error={new Error('이상한 일')} />);
    expect(screen.getByRole('heading', { name: '화면을 시작하지 못했습니다' })).toBeTruthy();
    expect(screen.queryByText('npm run sync:org')).toBeNull();
  });

  it('그리다 던져진 오류는 흰 화면 대신 오류 화면으로 보인다', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);   // React가 남기는 오류 기록은 이 시험에서 조용히
    const Boom = (): never => { throw new Error('그리기 실패 예시'); };
    try {
      render(<ErrorBoundary><Boom /></ErrorBoundary>);
      expect(screen.getByRole('heading', { name: '화면을 시작하지 못했습니다' })).toBeTruthy();
      expect(screen.getByText('그리기 실패 예시')).toBeTruthy();
      expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
