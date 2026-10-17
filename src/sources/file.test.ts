// FileSource: 사용자가 연 파일을 한 번 읽어 batch 1개로 내고 ended로 끝나는지 확인한다.
import { describe, expect, it } from 'vitest';
import type { EventSource, PbEvent, SourceStatus } from '../types';
import { createFileSource } from './file';
import { createFileSource as reExported } from './index';
import type { ReadableFile } from './file';

const ev = (n: number): Record<string, unknown> => ({
  v: 1, event_id: `f${n}`, ts: `2026-10-17T09:00:${String(n).padStart(2, '0')}+09:00`, type: 'task_started',
  staff_id: 'ceo', executor: 'human', task_id: `t${n}`, message: `작업 ${n}`,
});
const jsonl = (...ns: number[]): string => ns.map((n) => `${JSON.stringify(ev(n))}\n`).join('');

function fileOf(name: string, read: () => Promise<string>): ReadableFile & { reads: number } {
  const f = { name, reads: 0, text: () => { f.reads += 1; return read(); } };
  return f;
}

function watch(file: ReadableFile) {
  const source = createFileSource(file);
  const batches: PbEvent[][] = [];
  const statuses: SourceStatus[] = [];
  source.subscribe((b) => { batches.push(b); });
  source.onStatus((s) => { statuses.push(s); });
  return { source, batches, statuses };
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('FileSource', () => {
  it('종류·이름·실연결 아님(이름은 파일 이름, 조작 없음)', () => {
    const { source } = watch(fileOf('내기록.jsonl', () => Promise.resolve('')));
    expect(source).toMatchObject({ kind: 'file', live: false, label: '내기록.jsonl' });
    expect((source as EventSource).control).toBeUndefined();
    expect(source.getStatus()).toEqual({ state: 'idle', detail: '', lastEventTs: null });
  });

  it('index.ts에서도 같은 함수를 내보낸다', () => {
    expect(reExported).toBe(createFileSource);
  });

  it('start: 파일을 한 번 읽어 batch 1개, 상태는 connecting → ended `읽음 n건 · 잘못된 줄 m`', async () => {
    const file = fileOf('a.jsonl', () => Promise.resolve(`${jsonl(1, 2)}깨진 줄\n${jsonl(3)}`));
    const { source, batches, statuses } = watch(file);
    source.start();
    expect(statuses.map((s) => s.state)).toEqual(['connecting']);
    expect(statuses[0]!.detail).toBe('파일을 읽는 중');
    await flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.event_id)).toEqual(['f1', 'f2', 'f3']);
    expect(statuses.at(-1)).toMatchObject({ state: 'ended', detail: '읽음 3건 · 잘못된 줄 1', lastEventTs: '2026-10-17T09:00:03+09:00' });
    expect(file.reads).toBe(1);
  });

  it('JSON 배열 파일도 읽는다', async () => {
    const { source, batches, statuses } = watch(fileOf('a.json', () => Promise.resolve(JSON.stringify([ev(1), ev(2)]))));
    source.start();
    await flush();
    expect(batches[0]!.map((e) => e.event_id)).toEqual(['f1', 'f2']);
    expect(statuses.at(-1)!.detail).toBe('읽음 2건 · 잘못된 줄 0');
  });

  it('두 번째 start는 아무 일도 하지 않는다(다시 읽지 않는다)', async () => {
    const file = fileOf('a.jsonl', () => Promise.resolve(jsonl(1)));
    const { source, batches } = watch(file);
    source.start();
    source.start();
    await flush();
    source.start();
    await flush();
    expect(file.reads).toBe(1);
    expect(batches).toHaveLength(1);
  });

  it('빈 파일: 이벤트 0건이면 batch를 내지 않고 ended', async () => {
    const { source, batches, statuses } = watch(fileOf('빈.jsonl', () => Promise.resolve('')));
    source.start();
    await flush();
    expect(batches).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ state: 'ended', detail: '읽음 0건 · 잘못된 줄 0', lastEventTs: null });
  });

  it('전부 잘못된 파일', async () => {
    const { source, batches, statuses } = watch(fileOf('x.txt', () => Promise.resolve(['hello', 'world', ''].join('\n'))));
    source.start();
    await flush();
    expect(batches).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ state: 'ended', detail: '읽음 0건 · 잘못된 줄 2' });
  });

  it('읽기 실패: 상태 error와 사유', async () => {
    const a = watch(fileOf('a', () => Promise.reject(new Error('권한 없음'))));
    a.source.start();
    await flush();
    expect(a.statuses.at(-1)).toMatchObject({ state: 'error', detail: '파일을 읽지 못했습니다: 권한 없음' });
    const b = watch(fileOf('b', () => Promise.reject('이상한 값')));
    b.source.start();
    await flush();
    expect(b.statuses.at(-1)).toMatchObject({ state: 'error', detail: '파일을 읽지 못했습니다: 이상한 값' });
    expect(a.batches).toEqual([]);
  });

  it('읽는 중에 stop하면 결과를 버린다(성공이든 실패든)', async () => {
    let resolve: (t: string) => void = () => undefined;
    const slow = watch(fileOf('s', () => new Promise<string>((r) => { resolve = r; })));
    slow.source.start();
    slow.source.stop();
    resolve(jsonl(1));
    await flush();
    expect(slow.batches).toEqual([]);
    expect(slow.statuses.map((s) => s.state)).toEqual(['connecting']);

    let reject: (e: Error) => void = () => undefined;
    const failing = watch(fileOf('f', () => new Promise<string>((_r, rej) => { reject = rej; })));
    failing.source.start();
    failing.source.stop();
    reject(new Error('늦은 실패'));
    await flush();
    expect(failing.statuses.map((s) => s.state)).toEqual(['connecting']);
  });

  it('구독을 해지하면 알리지 않는다', async () => {
    const file = fileOf('a.jsonl', () => Promise.resolve(jsonl(1)));
    const source = createFileSource(file);
    const got: number[] = [];
    const off = source.subscribe((b) => { got.push(b.length); });
    off();
    source.start();
    await flush();
    expect(got).toEqual([]);
  });
});
