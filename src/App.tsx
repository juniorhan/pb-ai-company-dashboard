// 화면 골격. 연결(코어/가짜)은 ui/runtime.ts 한 곳에서만 만들고, 여기서는 DashboardStore·EventSource 인터페이스로만 쓴다.
// 데스크톱(≥1100): 상단 바 · 요약 띠 · [본문 | 사이드 360] · 타임라인 · 바닥글. 태블릿(720~1099): 사이드가 본문 아래. 휴대폰(<720): 아래 탭 막대.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityFeed } from './ui/ActivityFeed';
import { ApprovalLane } from './ui/ApprovalLane';
import { UiContext } from './ui/context';
import type { UiContextValue } from './ui/context';
import { ErrorBoundary, ErrorScreen, LoadingScreen } from './ui/ErrorScreen';
import { DropOverlay, useFileDrop } from './ui/FileDrop';
import { Footer } from './ui/Footer';
import { useIsPhone, useReducedMotion, useTheme, useView } from './ui/hooks';
import type { ThemeChoice } from './ui/hooks';
import { Notices } from './ui/Notices';
import type { NoticeItem } from './ui/Notices';
import { OfficeView } from './ui/OfficeView';
import { OrgChartView } from './ui/OrgChartView';
import { createRuntime, openFile, reconnect } from './ui/runtime';
import type { Runtime } from './ui/runtime';
import { pendingApprovals } from './ui/selectors';
import { StaffDrawer } from './ui/StaffDrawer';
import { SummaryStrip } from './ui/SummaryStrip';
import { TabBar } from './ui/TabBar';
import type { PhoneTab } from './ui/TabBar';
import { RewindBanner, Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import type { MainView } from './ui/TopBar';

type Boot =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'ready'; runtime: Runtime; key: number; owned: boolean };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface DashboardProps {
  runtime: Runtime;
  mainView: MainView;
  onMainView(v: MainView): void;
  tab: PhoneTab;
  onTab(t: PhoneTab): void;
  theme: ThemeChoice;
  onCycleTheme(): void;
  onOpenFile(file: File): void;
  onRejectFile(message: string): void;
  onReturn(): void;
  busy: boolean;
  fileNotice: string | null;
  onDismissFileNotice(): void;
}

function Dashboard({ runtime, mainView, onMainView, tab, onTab, theme, onCycleTheme, onOpenFile, onRejectFile, onReturn, busy, fileNotice, onDismissFileNotice }: DashboardProps) {
  const { store, index } = runtime;
  const view = useView(store);
  const reducedMotion = useReducedMotion();
  const isPhone = useIsPhone();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const ctx = useMemo<UiContextValue>(() => ({ index, selectedId, select, reducedMotion }), [index, selectedId, select, reducedMotion]);
  const dragging = useFileDrop(onOpenFile, onRejectFile, !busy);
  const pending = useMemo(() => pendingApprovals(view.state).length, [view.state]);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const dismiss = useCallback((key: string) => setDismissed((prev) => (prev.includes(key) ? prev : [...prev, key])), []);

  const notices: NoticeItem[] = [];
  if (busy) notices.push({ key: 'busy', tone: 'info', text: '파일을 읽는 중입니다…' });
  if (fileNotice) notices.push({ key: 'file', tone: 'error', text: fileNotice, onDismiss: onDismissFileNotice });
  if (runtime.orgNote && !dismissed.includes('org')) notices.push({ key: 'org', tone: 'info', text: runtime.orgNote, onDismiss: () => dismiss('org') });
  if (runtime.mode === 'mock' && !dismissed.includes('mock')) {
    notices.push({ key: 'mock', tone: 'info', text: '개발용 가짜 데이터로 연결했습니다(?mock=1) — 실제 시뮬레이터가 아닙니다', onDismiss: () => dismiss('mock') });
  }

  // 휴대폰은 탭 하나만 그린다(숨은 무거운 패널을 만들지 않는다). 오피스·조직도 탭은 mainView를 따른다.
  const phoneTab: PhoneTab = tab === 'office' || tab === 'org' ? mainView : tab;
  const showSummary = !isPhone || phoneTab === 'summary';
  const showMain = !isPhone || phoneTab === 'office' || phoneTab === 'org';
  const showLane = !isPhone || phoneTab === 'approval';
  const showFeed = !isPhone || phoneTab === 'feed';
  const control = store.source.control;

  const onTabSelect = (next: PhoneTab): void => {
    onTab(next);
    if (next === 'office' || next === 'org') onMainView(next);
  };

  return (
    <UiContext.Provider value={ctx}>
      <div className="app" data-view={mainView} data-tab={isPhone ? phoneTab : undefined}>
        <a className="skip-link" href="#main">본문으로 건너뛰기</a>
        <TopBar
          view={view}
          control={control}
          mainView={mainView}
          onMainView={onMainView}
          onOpenFile={onOpenFile}
          fileName={runtime.fileName}
          onReturn={onReturn}
          theme={theme}
          onCycleTheme={onCycleTheme}
          orgNote={runtime.orgNote}
        />
        <Notices items={notices} warnings={view.state.warnings} />
        <div className="workspace">
          {showSummary && <SummaryStrip view={view} index={index} />}
          <RewindBanner view={view} store={store} />
          <div className="body">
            {showMain && (
              <main className="main" id="main" tabIndex={-1} aria-label={mainView === 'org' ? '조직도' : '오피스'}>
                {mainView === 'org' ? <OrgChartView view={view} index={index} /> : <OfficeView view={view} index={index} />}
              </main>
            )}
            {(showLane || showFeed) && (
              <aside className="side" aria-label="승인과 활동">
                {showLane && <ApprovalLane view={view} index={index} source={store.source} />}
                {showFeed && <ActivityFeed view={view} index={index} />}
              </aside>
            )}
          </div>
          {isPhone && <Footer org={view.org} />}
        </div>
        <Timeline view={view} store={store} />
        {!isPhone && <Footer org={view.org} />}
        {isPhone && <TabBar active={phoneTab} onSelect={onTabSelect} pending={pending} />}
        <StaffDrawer view={view} index={index} />
        <DropOverlay show={dragging} />
      </div>
    </UiContext.Provider>
  );
}

export interface AppProps {
  /** 시험·미리보기용: 이미 만든 연결을 그대로 쓴다(없으면 createRuntime으로 만든다). 소유자는 호출한 쪽이다. */
  initialRuntime?: Runtime;
}

export function App({ initialRuntime }: AppProps = {}) {
  const [boot, setBoot] = useState<Boot>(() => (initialRuntime ? { kind: 'ready', runtime: initialRuntime, key: 0, owned: false } : { kind: 'loading' }));
  const bootRef = useRef(boot);
  const keyRef = useRef(1);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [mainViewChoice, setMainViewChoice] = useState<MainView | null>(null);
  const [tab, setTab] = useState<PhoneTab>('office');
  const { theme, cycle } = useTheme();
  useEffect(() => { bootRef.current = boot; });

  // 처음 연결. 개발 모드 StrictMode가 효과를 두 번 돌려도 먼저 끝난 쪽은 정리한다.
  useEffect(() => {
    if (initialRuntime) return undefined;
    let cancelled = false;
    createRuntime().then(
      (runtime) => {
        if (cancelled) runtime.store.dispose();
        else setBoot({ kind: 'ready', runtime, key: keyRef.current++, owned: true });
      },
      (error: unknown) => {
        if (!cancelled) setBoot({ kind: 'error', error });
      },
    );
    return () => { cancelled = true; };
  }, [initialRuntime]);

  // 화면이 사라질 때, 이 앱이 만든 연결만 정리한다.
  useEffect(() => () => {
    const b = bootRef.current;
    if (b.kind === 'ready' && b.owned) b.runtime.store.dispose();
  }, []);

  // 개발 서버 전용 확인 창구: 브라우저 자동 점검이 지금 화면에 붙은 스토어를 읽는다(StrictMode에서 버려진 쪽이 아니라). 배포 빌드에서는 지워진다.
  useEffect(() => {
    if (!import.meta.env.DEV || boot.kind !== 'ready') return;
    (window as unknown as { __pbai?: { store: Runtime['store'] } }).__pbai = { store: boot.runtime.store };
  }, [boot]);

  const swap = useCallback(async (make: (current: Runtime) => Promise<Runtime>, failure: string): Promise<void> => {
    const cur = bootRef.current;
    if (cur.kind !== 'ready' || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFileNotice(null);
    try {
      const next = await make(cur.runtime);
      setBoot({ kind: 'ready', runtime: next, key: keyRef.current++, owned: true });
    } catch (e) {
      setFileNotice(`${failure}: ${errorText(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const onOpenFile = useCallback((file: File) => { void swap((cur) => openFile(cur, file), '파일을 열지 못했습니다'); }, [swap]);
  const onReturn = useCallback(() => { void swap((cur) => reconnect(cur), '원래 소스로 돌아가지 못했습니다'); }, [swap]);
  const onRejectFile = useCallback((message: string) => setFileNotice(message), []);
  const onDismissFileNotice = useCallback(() => setFileNotice(null), []);

  if (boot.kind === 'loading') return <LoadingScreen />;
  if (boot.kind === 'error') return <ErrorScreen error={boot.error} />;
  const { runtime } = boot;
  return (
    <ErrorBoundary>
      <Dashboard
        key={boot.key}
        runtime={runtime}
        mainView={mainViewChoice ?? runtime.initialView}
        onMainView={setMainViewChoice}
        tab={tab}
        onTab={setTab}
        theme={theme}
        onCycleTheme={cycle}
        onOpenFile={onOpenFile}
        onRejectFile={onRejectFile}
        onReturn={onReturn}
        busy={busy}
        fileNotice={fileNotice}
        onDismissFileNotice={onDismissFileNotice}
      />
    </ErrorBoundary>
  );
}
