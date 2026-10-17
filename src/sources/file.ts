// 사용자가 연 기록 파일(events.jsonl 또는 JSON 배열)을 브라우저 안에서 한 번 읽는 소스. 파일은 브라우저 밖으로 보내지 않는다(docs/DESIGN.md §7).
import { parseEventText } from '../data/schema';
import { SourceBase } from './base';

/** 브라우저 File과 같은 최소 약속 */
export interface ReadableFile {
  name: string;
  size?: number;
  text(): Promise<string>;
}

/** 이보다 큰 파일은 읽지 않는다(화면이 멈추지 않게). 개발 서버 /__pbai/events의 상한과 같다. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class FileSource extends SourceBase {
  readonly kind = 'file' as const;
  readonly live = false;
  readonly label: string;
  private readonly file: ReadableFile;
  private started = false;
  private stopped = false;

  constructor(file: ReadableFile) {
    super();
    this.file = file;
    this.label = file.name;
  }

  /** 파일을 한 번 읽어 batch 1개로 내고 상태를 ended로 바꾼다. 두 번째 호출부터는 아무 일도 없다. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setStatus('connecting', '파일을 읽는 중');
    void this.read();
  }

  stop(): void {
    this.stopped = true;
  }

  private async read(): Promise<void> {
    const size = this.file.size;
    if (typeof size === 'number' && size > MAX_FILE_BYTES) {
      this.setStatus('error', `파일이 너무 큽니다(${(size / 1024 / 1024).toFixed(1)}MB) — ${MAX_FILE_BYTES / 1024 / 1024}MB 이하만 엽니다`);
      return;
    }
    let text: string;
    try {
      text = await this.file.text();
    } catch (e) {
      if (this.stopped) return;
      this.setStatus('error', `파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.stopped) return;
    const parsed = parseEventText(text);
    this.emitBatch(parsed.events);
    this.setStatus('ended', `읽음 ${parsed.events.length}건 · 잘못된 줄 ${parsed.bad}`);
  }
}

export function createFileSource(file: ReadableFile): FileSource {
  return new FileSource(file);
}
