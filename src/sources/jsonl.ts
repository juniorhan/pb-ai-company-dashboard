// 실제 기록 파일(events.jsonl 또는 JSON 배열)을 주기적으로 읽는 읽기 전용 소스(docs/DESIGN.md §7).
// - 새 event_id만 batch로 낸다. 파일이 늘어나기만 했으면 늘어난 뒷부분만 해석하고, 짧아지거나 앞부분이 달라졌으면(교체) 전체를 다시 읽는다(본 id는 계속 버린다).
// - 쓰는 중인 마지막 줄(개행 전)은 완성될 때까지 기다린다. 완성된 JSON이면 바로 받는다.
// - 읽기에 실패하면 5 → 10 → 30초 간격으로 다시 시도하고, 성공하면 원래 간격으로 돌아간다.
import { parseEventText } from '../data/schema';
import type { PbEvent } from '../types';
import { SourceBase, timeOfDay } from './base';

/** fetch와 같은 모양의 최소 약속(시험에서 가짜를 넣는다). 진짜 fetch가 그대로 들어간다. */
export type FetchLike = (
  url: string,
  init?: { cache?: RequestCache; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface JsonlPollingOptions {
  url: string;
  intervalMs?: number;               // 기본 5000
  fetchImpl?: FetchLike;
  label?: string;
  live?: boolean;                    // 기본 true. 배포 사이트의 가짜 샘플은 false(실시간 연결로 표시하지 않음)
  requestTimeoutMs?: number;         // 응답이 이 시간(기본 20초) 안에 안 오면 실패로 본다
}

const DEFAULT_INTERVAL_MS = 5000;
const RETRY_STEPS_MS = [5000, 10000, 30000] as const;   // 연속 실패 1·2·3회째 이후 간격(최대 30초)
const DEFAULT_TIMEOUT_MS = 20000;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** 첫 공백 아닌 글자 */
function firstSignificant(text: string): string {
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

export class JsonlPollingSource extends SourceBase {
  readonly kind = 'jsonl' as const;
  readonly live: boolean;
  readonly label: string;

  private readonly url: string;
  private readonly intervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly seen = new Set<string>();
  private consumed = '';              // 이미 해석한 앞부분(다음 읽기에서 이것으로 시작하면 뒷부분만 해석한다)
  private badLines = 0;               // 지금 파일에 있는 잘못된 줄 수
  private failures = 0;
  private running = false;
  private generation = 0;             // start/stop 세대: 늦게 끝난 읽기를 버린다
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;

  constructor(opts: JsonlPollingOptions) {
    super();
    this.url = opts.url;
    this.intervalMs = Math.max(100, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = Math.max(1, opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.label = opts.label ?? '실시간 기록';
    this.live = opts.live ?? true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.failures = 0;
    this.consumed = '';
    this.badLines = 0;
    this.setStatus('connecting', '기록을 읽는 중');
    void this.poll(this.generation);
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
    if (wasRunning) this.setStatus('idle', '읽기 중지');
  }

  private schedule(gen: number, ms: number): void {
    if (gen !== this.generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll(gen);
    }, ms);
  }

  private async poll(gen: number): Promise<void> {
    let text: string;
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new HttpError(res.status);
      text = await res.text();
    } catch (e) {
      clearTimeout(timeout);
      if (gen !== this.generation) return;
      this.failures += 1;
      const detail = e instanceof HttpError
        ? e.message
        : timedOut ? `응답 시간 초과(${Math.round(this.timeoutMs / 1000)}초)` : `읽기 실패: ${e instanceof Error ? e.message : String(e)}`;
      this.setStatus('error', detail);
      this.schedule(gen, RETRY_STEPS_MS[Math.min(this.failures, RETRY_STEPS_MS.length) - 1]!);
      return;
    }
    clearTimeout(timeout);
    if (gen !== this.generation) return;
    this.failures = 0;

    const fresh = this.ingest(text);
    this.emitBatch(fresh);
    const bad = this.badLines > 0 ? ` · 잘못된 줄 ${this.badLines}` : '';
    this.setStatus('live', `마지막 읽기 ${timeOfDay(new Date())} · 새 ${fresh.length}건${bad}`);
    this.schedule(gen, this.intervalMs);
  }

  /** 읽은 본문에서 아직 못 본 이벤트만 골라낸다. */
  private ingest(text: string): PbEvent[] {
    const isArray = firstSignificant(text) === '[';
    let from = 0;
    if (!isArray && this.consumed !== '' && text.startsWith(this.consumed)) from = this.consumed.length;
    else this.badLines = 0;             // 전체를 다시 읽으면 잘못된 줄도 처음부터 센다

    let body = text.slice(from);
    let held = '';
    if (!isArray) {
      // 마지막 줄이 개행 없이 끝났으면, 온전한 이벤트일 때만 받고 아니면 완성될 때까지 보류한다
      const tailAt = body.lastIndexOf('\n') + 1;
      const tail = body.slice(tailAt);
      if (tail.trim() !== '') {
        const probe = parseEventText(tail);
        if (probe.events.length !== 1 || probe.bad !== 0) {
          held = tail;
          body = body.slice(0, tailAt);
        }
      }
    }
    this.consumed = isArray ? '' : text.slice(0, text.length - held.length);

    const parsed = parseEventText(body);
    this.badLines += parsed.bad;
    const fresh: PbEvent[] = [];
    for (const event of parsed.events) {
      if (this.seen.has(event.event_id)) continue;
      this.seen.add(event.event_id);
      fresh.push(event);
    }
    return fresh;
  }
}
