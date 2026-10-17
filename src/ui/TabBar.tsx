// 휴대폰 아래 탭 막대(docs/DESIGN.md §4.1): 요약 · 오피스 · 승인 · 피드 · 조직도.
import { Activity, Hourglass, LayoutDashboard, LayoutGrid, Network } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type PhoneTab = 'summary' | 'office' | 'approval' | 'feed' | 'org';

export const PHONE_TABS: { id: PhoneTab; label: string; Icon: LucideIcon }[] = [
  { id: 'summary', label: '요약', Icon: LayoutDashboard },
  { id: 'office', label: '오피스', Icon: LayoutGrid },
  { id: 'approval', label: '승인', Icon: Hourglass },
  { id: 'feed', label: '피드', Icon: Activity },
  { id: 'org', label: '조직도', Icon: Network },
];

export function TabBar({ active, onSelect, pending }: { active: PhoneTab; onSelect(tab: PhoneTab): void; pending: number }) {
  return (
    <nav className="tabbar" aria-label="화면 전환">
      {PHONE_TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="tab"
          aria-current={active === id ? 'page' : undefined}
          aria-label={id === 'approval' && pending > 0 ? `${label}, 대기 ${pending}건` : label}
          onClick={() => onSelect(id)}
        >
          <span className="tab-icon">
            <Icon size={20} strokeWidth={active === id ? 2.4 : 1.8} aria-hidden="true" />
            {id === 'approval' && pending > 0 && <span className="tab-badge num" aria-hidden="true">{pending > 99 ? '99+' : pending}</span>}
          </span>
          <span className="tab-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
