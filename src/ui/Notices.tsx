// 상단 바 아래 안내 줄: 파일 열기 실패, 조직 실시간 읽기 실패, 개발용 연결, 데이터 경고. 모두 접거나 닫을 수 있다.
import { Info, TriangleAlert, X } from 'lucide-react';

export interface NoticeItem {
  key: string;
  tone: 'info' | 'error';
  text: string;
  /** 있으면 닫기 단추를 보여 준다 */
  onDismiss?: () => void;
}

export function Notices({ items, warnings }: { items: NoticeItem[]; warnings: readonly string[] }) {
  if (items.length === 0 && warnings.length === 0) return null;
  const recent = warnings.slice(-10).reverse();
  return (
    <div className="notices" aria-label="안내">
      {items.map((n) => (
        <p key={n.key} className="notice" data-tone={n.tone} role={n.tone === 'error' ? 'alert' : 'status'}>
          {n.tone === 'error' ? <TriangleAlert size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
          <span className="notice-text">{n.text}</span>
          {n.onDismiss && (
            <button type="button" className="btn btn-quiet btn-icon btn-xs" aria-label="안내 닫기" onClick={n.onDismiss}>
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </p>
      ))}
      {warnings.length > 0 && (
        <details className="notice notice-warn" data-tone="info">
          <summary>
            <Info size={14} aria-hidden="true" />
            <span className="notice-text">{`데이터 경고 ${warnings.length}건 (조직에 없는 행위자 등)`}</span>
          </summary>
          <ul>
            {recent.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
