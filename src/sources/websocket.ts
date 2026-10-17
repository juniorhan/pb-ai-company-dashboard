// WebSocket 소스 — 미검증: 실제 WebSocket 서버가 아직 없어 가짜 생성자로 시험했을 뿐, 실서버 연결은 확인하지 않았다(docs/DESIGN.md §7).
// 메시지 1개 = 이벤트 1건 또는 이벤트 배열(JSON). parseEvent로 검사하고 잘못된 것은 세어서 상태에 보여 준다.
// 연결이 끊기면 5초 뒤 다시 연결한다. 읽기 전용이라 서버로 보내는 것은 없다.
import { parseEvent } from '../data/schema';
import type { PbEvent } from '../types';
import { SourceBase } from './base';

/** 브라우저 WebSocket과 같은 최소 약속(핸들러에 들어오는 이벤트 모양은 쓰는 곳에서 좁힌다) */
export interface WebSocketLike {
  onopen: ((ev: never) => void) | null;
  onmessage: ((ev: never) => void) | null;
  onerror: ((ev: never) => void) | null;
  onclose: ((ev: never) => void) | null;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WebSocketSourceOptions {
  url: string;
  WebSocketImpl?: WebSocketCtor;     // 시험에서 가짜 생성자를 넣는다. 기본은 브라우저 WebSocket
  reconnectMs?: number;              // 기본 5000
  label?: string;
}

const DEFAULT_RECONNECT_MS = 5000;

export class WebSocketSource extends SourceBase {
  readonly kind = 'ws' as const;
  readonly live = true;
  readonly label: string;

  private readonly url: string;
  private readonly Impl: WebSocketCtor | undefined;
  private readonly reconnectMs: number;
  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private received = 0;
  private badMessages = 0;

  constructor(opts: WebSocketSourceOptions) {
    super();
    this.url = opts.url;
    this.Impl = opts.WebSocketImpl ?? (typeof WebSocket === 'function' ? (WebSocket as unknown as WebSocketCtor) : undefined);
    this.reconnectMs = Math.max(0, opts.reconnectMs ?? DEFAULT_RECONNECT_MS);
    this.label = opts.label ?? 'WebSocket';
  }

  start(): void {
    if (this.running) return;
    if (!/^wss?:\/\//i.test(this.url)) {
      this.setStatus('error', '주소는 ws:// 또는 wss:// 로 시작해야 합니다');
      return;
    }
    if (!this.Impl) {
      this.setStatus('error', '이 환경에서는 WebSocket을 쓸 수 없습니다');
      return;
    }
    this.running = true;
    this.connect('연결하는 중');
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.detach();
    if (wasRunning) this.setStatus('idle', '연결 중지');
  }

  private connect(detail: string): void {
    if (!this.running || !this.Impl) return;
    this.setStatus('connecting', detail);
    let socket: WebSocketLike;
    try {
      socket = new this.Impl(this.url);
    } catch (e) {
      this.lost(`연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setStatus('live', this.countsDetail('연결됨'));
    };
    socket.onmessage = ((ev: { data: unknown }) => {
      if (this.socket !== socket) return;
      this.receive(ev.data);
    }) as (ev: never) => void;
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.lost('연결 오류');
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.lost('연결이 끊겼습니다');
    };
  }

  /** 소켓을 떼어 내고(이벤트 무시) 닫는다. */
  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // 이미 닫힌 소켓
    }
  }

  /** 연결이 끊기거나 실패했다: 상태를 오류로 보여 주고 일정 시간 뒤 다시 연결한다. */
  private lost(reason: string): void {
    this.detach();
    if (!this.running) return;
    const secs = Math.round(this.reconnectMs / 1000);
    this.setStatus('error', `${reason} — ${secs}초 뒤 다시 연결합니다`);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect('다시 연결하는 중');
    }, this.reconnectMs);
  }

  private countsDetail(head: string): string {
    return `${head} · 받은 ${this.received}건${this.badMessages > 0 ? ` · 잘못된 메시지 ${this.badMessages}` : ''}`;
  }

  private receive(data: unknown): void {
    const events: PbEvent[] = [];
    let bad = 0;
    let value: unknown;
    if (typeof data !== 'string') {
      bad = 1;
    } else {
      try {
        value = JSON.parse(data);
      } catch {
        bad = 1;
      }
      if (bad === 0) {
        for (const item of Array.isArray(value) ? value : [value]) {
          const r = parseEvent(item);
          if (r.ok) events.push(r.event);
          else bad += 1;
        }
      }
    }
    this.received += events.length;
    this.badMessages += bad;
    this.emitBatch(events);
    this.setStatus('live', this.countsDetail('연결됨'));
  }
}
