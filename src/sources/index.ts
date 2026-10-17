// 화면이 소스를 만드는 단 한 곳(AGENTS.md §4). 설정(AppConfig)에 맞는 EventSource를 돌려준다.
import { loadScenarioLibrary } from '../sim/load';
import type { AppConfig, EventSource, OrgIndex } from '../types';
import { StaticSource } from './base';
import { JsonlPollingSource } from './jsonl';
import { SimulatorSource } from './simulator';
import { WebSocketSource } from './websocket';

export { createFileSource } from './file';

/**
 * `?source=jsonl`에 url이 없을 때의 주소.
 * 개발 서버(npm run dev)에서는 이 PC의 기록 파일(/__pbai/events), 배포 사이트에서는 가짜 기록 샘플이다.
 */
export function defaultJsonlUrl(): string {
  const base = import.meta.env.BASE_URL;
  return import.meta.env.DEV ? `${base}__pbai/events` : `${base}sample/events.sample.jsonl`;
}

export function createSource(config: AppConfig, index: OrgIndex): EventSource {
  // 주소 지정(?url=)은 이 PC의 개발 서버에서만 따른다. 공개 사이트는 시뮬레이션·가짜 샘플·파일 열기만 쓴다(DECISIONS D-6):
  // 남이 만든 링크로 바깥 기록을 이 사이트 이름 아래 '실시간'으로 띄우지 못하게 한다.
  const url = import.meta.env.DEV ? config.url : null;
  switch (config.source) {
    case 'jsonl':
      if (url) return new JsonlPollingSource({ url, intervalMs: config.intervalMs });
      if (import.meta.env.DEV) return new JsonlPollingSource({ url: defaultJsonlUrl(), intervalMs: config.intervalMs, label: '이 PC의 기록' });
      // 배포 사이트: 가짜 샘플(어댑터 시연용) — 실시간 연결로 표시하지 않는다
      return new JsonlPollingSource({ url: defaultJsonlUrl(), intervalMs: config.intervalMs, label: '가짜 샘플 기록', live: false });
    case 'ws':
      if (url) return new WebSocketSource({ url });
      return new StaticSource('ws', 'WebSocket', true, {
        state: 'error',
        detail: import.meta.env.DEV ? '주소가 없습니다 — ?url=wss://… 로 지정해 주세요' : '공개 사이트는 바깥 주소에 연결하지 않습니다 — 이 PC에서 npm run dev로 여세요',
      });
    case 'file':
      return new StaticSource('file', '파일', false, { state: 'idle', detail: '파일을 열어 주세요' });
    case 'sim':
    default:
      return new SimulatorSource({
        index,
        library: loadScenarioLibrary(),
        seed: config.seed,
        scenario: config.scenario,
        speed: config.speed,
        autoApprove: config.autoApprove,
      });
  }
}
