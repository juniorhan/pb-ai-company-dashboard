// 오류 화면: 조직 사본을 읽지 못했거나(OrgError) 화면을 그리다 문제가 생겼을 때.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { OrgError } from '../data/org';
import { LogoMark } from './TopBar';

export function ErrorScreen({ error }: { error: unknown }) {
  const isOrg = error instanceof OrgError;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-screen" role="alert">
      <header className="error-top">
        <LogoMark />
        <span className="brand-name">PB AI 회사</span>
        <span className="brand-sub">관제실</span>
        <div className="mode-badge" data-tone="error">
          <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" />
          <span className="mode-text">{`연결 오류 · ${isOrg ? '조직 사본을 읽지 못했습니다' : '화면을 시작하지 못했습니다'}`}</span>
        </div>
      </header>
      <main className="error-card">
        <h1 className="error-title">{isOrg ? '조직 사본이 올바르지 않습니다' : '화면을 시작하지 못했습니다'}</h1>
        <p className="error-msg">{message}</p>
        {isOrg ? (
          <>
            <p>조직 사본(<code>src/data/org.json</code>)이 형식에 맞지 않거나 참조가 어긋났습니다. 조직 사본을 다시 만드세요.</p>
            <pre className="error-cmd"><code>npm run sync:org</code></pre>
            <p className="muted small">다시 만든 뒤 이 페이지를 새로 고치면 됩니다. 직접 고치지 말고 조직 정본(Wiki)을 고친 뒤 위 명령을 실행합니다.</p>
          </>
        ) : (
          <p className="muted small">잠시 뒤 새로 고쳐도 같으면 브라우저 콘솔의 오류 내용을 확인하세요.</p>
        )}
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>다시 시도</button>
      </main>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="loading" role="status">
      <LogoMark size={28} />
      <p>조직을 불러오는 중…</p>
    </div>
  );
}

/** 화면을 그리다 던져진 오류를 오류 화면으로 보여 준다. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('알 수 없는 오류') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('화면 오류', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? <ErrorScreen error={this.state.error} /> : this.props.children;
  }
}
