// 모드 배지(늘 보임): 지금 보는 것이 가짜 시뮬레이션인지, 실시간 연결인지, 실제 기록 파일인지, 오류인지 알려 준다.
import { FileText, FlaskConical, Radio, TriangleAlert } from 'lucide-react';
import type { DashboardView } from '../types';

export type ModeTone = 'sim' | 'live' | 'file' | 'error';

export function modeBadgeInfo(source: DashboardView['source']): { tone: ModeTone; text: string; title: string } {
  const { kind, label, status } = source;
  const detail = status.detail;
  if (status.state === 'error') return { tone: 'error', text: `연결 오류 · ${detail || label}`, title: detail || label };
  if (kind === 'sim') return { tone: 'sim', text: '시뮬레이션 모드 · 실제 데이터 아님', title: detail || '화면의 모든 데이터는 가짜입니다' };
  if (kind === 'file') return { tone: 'file', text: `실제 기록 파일 · ${label}`, title: detail || '이 브라우저 안에서만 읽은 파일입니다(업로드 없음)' };
  if (!source.live) return { tone: 'sim', text: `${label} · 실제 데이터 아님`, title: detail || '공개 사이트의 가짜 샘플입니다' };
  const prefix = status.state === 'connecting' ? '연결 중' : status.state === 'ended' ? '연결 종료' : '실시간 연결';
  return { tone: 'live', text: `${prefix} · ${label}`, title: detail || label };
}

const ICON = { sim: FlaskConical, live: Radio, file: FileText, error: TriangleAlert } as const;

export function ModeBadge({ source }: { source: DashboardView['source'] }) {
  const { tone, text, title } = modeBadgeInfo(source);
  const Icon = ICON[tone];
  const pulsing = tone === 'live' && source.status.state === 'live';
  return (
    <div className="mode-badge" data-tone={tone} role="status" title={title}>
      {tone === 'live' ? <span className={`mode-dot${pulsing ? ' is-blinking' : ''}`} aria-hidden="true" /> : <Icon size={14} strokeWidth={2.2} aria-hidden="true" />}
      <span className="mode-text">{text}</span>
    </div>
  );
}
