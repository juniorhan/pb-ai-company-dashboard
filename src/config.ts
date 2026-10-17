// URL 쿼리 → AppConfig (docs/DESIGN.md §7). 잘못된 값은 모두 기본값으로 돌린다.
import type { AppConfig, SourceKind } from './types';

const SOURCES: readonly SourceKind[] = ['sim', 'jsonl', 'file', 'ws'];
const SPEEDS: readonly number[] = [1, 2, 5];
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 300;

/** 시험·기본값에 쓰는 설정 틀(seed는 부르는 때마다 새로 정한다) */
function defaults(): AppConfig {
  return {
    source: 'sim',
    url: null,
    intervalMs: DEFAULT_INTERVAL_S * 1000,
    scenario: 'day',
    speed: 1,
    view: 'office',
    seed: Date.now() % 1e9,
    autoApprove: true,
  };
}

function numberParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const isWsUrl = (v: string): boolean => /^wss?:\/\/\S+$/i.test(v);
/** http(s) 주소 또는 사이트 안 상대 경로(javascript:·data:·file: 같은 다른 방식과 `//호스트`·역슬래시 형태는 받지 않는다) */
const isHttpOrRelative = (v: string): boolean =>
  /^https?:\/\/\S+$/i.test(v) || (/^(\.{0,2}\/)?[^\s:?#\\]+(\?\S*)?$/.test(v) && !v.startsWith('//'));

/** 주소로 쓸 수 있는 값만 받는다. ws는 ws(s)만, jsonl은 http(s)·상대 경로만, 그 밖의 소스에서는 둘 다 받아 두고 쓰지 않는다. */
function validUrl(raw: string | null, source: SourceKind): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (source === 'ws') return isWsUrl(value) ? value : null;
  if (source === 'jsonl') return isHttpOrRelative(value) ? value : null;
  return isWsUrl(value) || isHttpOrRelative(value) ? value : null;
}

/** 현재 주소의 쿼리(또는 넘겨준 문자열)를 설정으로 읽는다. */
export function readConfig(search?: string): AppConfig {
  const text = search ?? (typeof location !== 'undefined' ? location.search : '');
  const config = defaults();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(text);
  } catch {
    return config;
  }

  const source = params.get('source');
  if (source && (SOURCES as readonly string[]).includes(source)) config.source = source as SourceKind;

  config.url = validUrl(params.get('url'), config.source);

  const interval = numberParam(params.get('interval'));
  if (interval !== null) config.intervalMs = Math.round(Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, interval)) * 1000);

  const scenario = params.get('scenario');
  if (scenario && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scenario)) config.scenario = scenario;

  const speed = numberParam(params.get('speed'));
  if (speed !== null && SPEEDS.includes(speed)) config.speed = speed;

  const view = params.get('view');
  if (view === 'office' || view === 'org') config.view = view;

  const seed = numberParam(params.get('seed'));
  if (seed !== null && Number.isInteger(seed)) config.seed = Math.abs(seed);

  if (params.get('auto') === '0') config.autoApprove = false;
  return config;
}
