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
  switch (config.source) {
    case 'jsonl':
      if (config.url) return new JsonlPollingSource({ url: config.url, intervalMs: config.intervalMs });
      if (import.meta.env.DEV) return new JsonlPollingSource({ url: defaultJsonlUrl(), intervalMs: config.intervalMs, label: '이 PC의 기록' });
      // 배포 사이트: 가짜 샘플(어댑터 시연용) — 실시간 연결로 표시하지 않는다
      return new JsonlPollingSource({ url: defaultJsonlUrl(), intervalMs: config.intervalMs, label: '가짜 샘플 기록', live: false });
    case 'ws':
      if (config.url) return new WebSocketSource({ url: config.url });
      return new StaticSource('ws', 'WebSocket', true, { state: 'error', detail: '주소가 없습니다 — ?url=wss://… 로 지정해 주세요' });
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
