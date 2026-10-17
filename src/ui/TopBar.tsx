// 상단 바: 로고·회사명 │ 모드 배지 │ 시뮬레이션 조작 │ 시각 │ 보기 전환 │ 파일 열기 │ 테마 │ 조직 기준.
import { useRef } from 'react';
import { FolderOpen, Info, LayoutGrid, Monitor, Moon, Network, Sun, Undo2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { DashboardView, SimControl } from '../types';
import { useNow, useSimTick } from './hooks';
import type { ThemeChoice } from './hooks';
import { formatClock, formatDateTimeKo, formatMonthDay, formatStamp } from './format';
import { ModeBadge } from './ModeBadge';
import { SimControls } from './SimControls';

export type MainView = 'office' | 'org';

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path className="lm-line" d="M16 12v5M7 21v-4h18v4M16 17v4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="lm-fg" cx="16" cy="9" r="3.2" />
      <rect className="lm-fg" x="4" y="21" width="6" height="6" rx="1.4" />
      <rect className="lm-fg" x="13" y="21" width="6" height="6" rx="1.4" />
      <rect className="lm-fg" x="22" y="21" width="6" height="6" rx="1.4" />
    </svg>
  );
}

const THEME_LABEL: Record<ThemeChoice, string> = { system: '시스템', light: '라이트', dark: '다크' };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function TopClock({ view, sim }: { view: DashboardView; sim: { clock: string } | null }) {
  const { kind, status } = view.source;
  const isSim = kind === 'sim' && sim !== null;
  const needsNow = !isSim && kind !== 'file';
  const now = useNow(1000, needsNow);
  if (isSim) {
    return (
      <div className="clock" aria-label="시뮬레이션 시각">
        <span className="clock-main">{formatDateTimeKo(sim.clock)}</span>
        <span className="clock-sub">시뮬레이션 시각</span>
      </div>
    );
  }
  if (kind === 'file') {
    return (
      <div className="clock" aria-label="기록의 마지막 시각">
        <span className="clock-main">{formatDateTimeKo(view.state.lastTs)}</span>
        <span className="clock-sub">기록의 마지막 시각</span>
      </div>
    );
  }
  return (
    <div className="clock" aria-label="현재 시각">
      <span className="clock-main">{formatDateTimeKo(new Date(now).toISOString())}</span>
      <span className="clock-sub">{`마지막 기록 ${formatClock(status.lastEventTs ?? view.state.lastTs)}`}</span>
    </div>
  );
}

export interface TopBarProps {
  view: DashboardView;
  control: SimControl | undefined;
  mainView: MainView;
  onMainView(v: MainView): void;
  onOpenFile(file: File): void;
  /** 파일로 연 상태면 파일 이름 — 원래 소스로 돌아가는 단추를 보여 준다 */
  fileName: string | null;
  onReturn(): void;
  theme: ThemeChoice;
  onCycleTheme(): void;
  orgNote: string | null;
}

export function TopBar({ view, control, mainView, onMainView, onOpenFile, fileName, onReturn, theme, onCycleTheme, orgNote }: TopBarProps) {
  const sim = useSimTick(control);
  const fileInput = useRef<HTMLInputElement>(null);
  const ThemeIcon = THEME_ICON[theme];
  const { org } = view;
  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';                               // 같은 파일을 다시 골라도 반응하게
    if (file) onOpenFile(file);
  };
  const orgTitle = [`정본 해시 ${org.hash.slice(0, 8)}`, `생성 ${formatStamp(org.generatedAt)}`, orgNote].filter(Boolean).join(' · ');
  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark />
        <span className="brand-name">PB AI 회사</span>
        <span className="brand-sub">관제실</span>
      </div>
      <ModeBadge source={view.source} />
      {view.source.kind !== 'sim' && view.source.status.state !== 'error' && view.source.status.detail && (
        <span className="source-detail" title={view.source.status.detail}>{view.source.status.detail}</span>
      )}
      {control && <SimControls control={control} sim={sim} />}
      <TopClock view={view} sim={sim} />
      <div className="seg-group view-toggle" role="group" aria-label="보기 전환">
        <button type="button" className="seg seg-labeled" aria-pressed={mainView === 'office'} onClick={() => onMainView('office')}>
          <LayoutGrid size={14} aria-hidden="true" />오피스
        </button>
        <button type="button" className="seg seg-labeled" aria-pressed={mainView === 'org'} onClick={() => onMainView('org')}>
          <Network size={14} aria-hidden="true" />조직도
        </button>
      </div>
      <div className="tb-tools">
        <input ref={fileInput} type="file" accept=".jsonl,.json,application/json" hidden onChange={onPick} aria-hidden="true" tabIndex={-1} />
        <button
          type="button"
          className="btn btn-quiet"
          aria-label="파일 열기"
          title="events.jsonl·json 기록 파일을 열어 봅니다. 파일은 업로드되지 않고 이 브라우저 안에서만 읽습니다."
          onClick={() => fileInput.current?.click()}
        >
          <FolderOpen size={16} aria-hidden="true" /><span className="btn-text">파일 열기</span>
        </button>
        {fileName && (
          <button type="button" className="btn btn-quiet" aria-label="원래 소스로 돌아가기" title={`${fileName} 대신 원래 소스로 돌아갑니다`} onClick={onReturn}>
            <Undo2 size={16} aria-hidden="true" /><span className="btn-text">원래 소스로</span>
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-icon" aria-label={`테마: ${THEME_LABEL[theme]} (눌러서 바꾸기)`} title={`테마: ${THEME_LABEL[theme]} → 눌러서 바꾸기`} onClick={onCycleTheme}>
          <ThemeIcon size={16} aria-hidden="true" />
        </button>
        <span className="org-pill" title={orgTitle}>
          <Info size={12} aria-hidden="true" />
          <span>{`조직 ${formatMonthDay(org.generatedAt)}`}</span>
          <span className="org-pill-extra">{` · ${org.origin === 'live' ? 'Wiki 실시간' : '저장된 사본'}`}</span>
        </span>
      </div>
    </header>
  );
}
