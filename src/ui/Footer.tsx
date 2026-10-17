// 바닥글(docs/DESIGN.md §4.10, 늘 보임): 직원의 뜻 · 시뮬레이션은 가상 · 내부 검사 · 조직 기준.
import type { DashboardView } from '../types';
import { formatStamp } from './format';

export function Footer({ org }: { org: DashboardView['org'] }) {
  const stamp = formatStamp(org.generatedAt);
  return (
    <footer className="footer" aria-label="안내">
      <p>
        <span>직원은 실행 중인 에이전트가 아니라 역할 프로필입니다. 실제 실행 주체는 Claude·Codex·Aside·스크립트입니다.</span>
        <span>시뮬레이션 문구는 가상이며 투자 권유가 아닙니다.</span>
        <span>리스크·준법·감사실 판정은 내부 검사이며 실제 금융회사·금융당국 승인이 아닙니다.</span>
        <span>{org.origin === 'live' ? `조직: Wiki 정본을 실시간으로 읽음(${stamp} 기준)` : `조직: Wiki 정본에서 만든 사본(${stamp} 생성)`}</span>
      </p>
    </footer>
  );
}
