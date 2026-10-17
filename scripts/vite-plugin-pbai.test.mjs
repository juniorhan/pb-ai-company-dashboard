// 개발 서버 전용 /__pbai/* 플러그인 시험: 미들웨어를 직접 불러 상태·이벤트 파일·조직·접근 제한·경로 숨김을 확인하고,
// 실제 http 서버로도 한 번 스트림 전송을 확인한다. 임시 폴더는 시험이 끝나면 지운다.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_EVENTS_BYTES, parsePaths, pbaiLocal, safeMessage } from './vite-plugin-pbai.mjs';

const j = (...parts) => parts.join('');
const nl = (...lines) => `${lines.join('\n')}\n`;                       // 줄 목록 → 줄바꿈으로 끝나는 글자
const tmpDirs = [];
function tmp(prefix = 'pbai-plugin-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

/* ───────────── 가짜 응답·요청 ───────────── */

class FakeRes extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise((resolve) => { this.once('finish', resolve); });
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
  _write(chunk, _enc, cb) { this.chunks.push(Buffer.from(chunk)); cb(); }
  get text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

/** 플러그인 미들웨어를 하나 꺼내 요청을 직접 넣는 도구 */
function setup(env = {}, base = '/') {
  const plugin = pbaiLocal(env);
  const handlers = [];
  plugin.configureServer({ config: { base }, middlewares: { use: (fn) => { handlers.push(fn); } } });
  expect(handlers).toHaveLength(1);
  async function request({ url, method = 'GET', remote = '127.0.0.1', host = 'localhost:5173' }) {
    const req = { method, url, socket: { remoteAddress: remote }, headers: host === null ? {} : { host } };
    const res = new FakeRes();
    let nextCalled = false;
    handlers[0](req, res, () => { nextCalled = true; });
    if (nextCalled) return { nextCalled };
    await res.done;
    return { nextCalled, status: res.statusCode, headers: res.headers, text: res.text, json: () => JSON.parse(res.text) };
  }
  return { plugin, request };
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const teamNote = (name) => nl('---', 'type: team', 'id: inv-01', 'dept: inv', `name: ${name}`, 'role: 수집', 'status: active', 'phase: P0', '---');

/** 아주 작은 가짜 Wiki(본부 1·팀 1·직원 1) */
function tinyWiki() {
  const root = tmp('pbai-plugin-wiki-');
  writeFile(root, '실/inv.md', nl('---', 'type: dept', 'id: inv', 'name: 리서치본부', 'role: 자료', 'status: active', '---', '본부장 역할: 총괄(관리 역할 겸임)'));
  writeFile(root, '팀/inv-01.md', teamNote('수집팀'));
  writeFile(root, '직원/inv-01-e01.md', nl(
    '---', 'type: staff', 'id: inv-01-e01', 'team: inv-01', 'name: 수집 담당', 'role: 수집', 'status: active', 'phase: P0', 'risk_class: R0',
    'ai_writer: Claude', 'checker: Codex', 'duties: []', '---',
  ));
  return root;
}

/* ───────────── 도우미 ───────────── */

describe('parsePaths', () => {
  it('`;`로 나누고 앞뒤 공백·감싼 따옴표를 지우며 빈 항목은 뺀다', () => {
    expect(parsePaths('a.jsonl;b.jsonl')).toEqual(['a.jsonl', 'b.jsonl']);
    expect(parsePaths('  a.jsonl ; ;; "b c.jsonl" ;\'d.jsonl\'  ')).toEqual(['a.jsonl', 'b c.jsonl', 'd.jsonl']);
    expect(parsePaths('')).toEqual([]);
    expect(parsePaths(undefined)).toEqual([]);
    expect(parsePaths(null)).toEqual([]);
    expect(parsePaths(' ; ; ')).toEqual([]);
  });
});

describe('safeMessage', () => {
  it('설정한 폴더 경로는 `<폴더>`로 바꾼다(슬래시·역슬래시 모양 모두)', () => {
    const dir = j('Z', ':', '\\', 'wiki', '\\', 'org');
    expect(safeMessage(new Error(`읽을 수 없음: ${dir}\\실`), dir)).toBe('읽을 수 없음: <폴더>\\실');
    expect(safeMessage(new Error(`읽을 수 없음: ${dir.replace(/\\/g, '/')}/실`), dir)).toBe('읽을 수 없음: <폴더>/실');
  });

  it('그래도 공개 검사에 걸리면 일반 문구로 바꾼다', () => {
    expect(safeMessage(new Error(j('다른 경로 ', 'Y', ':', '\\', 'other')), 'nowhere')).toBe('조직 해석 실패');
    expect(safeMessage(new Error(j('문의 ', 'a', '@', 'b.co')), '')).toBe('조직 해석 실패');
  });

  it('빈 메시지·Error가 아닌 값·공백 정리', () => {
    expect(safeMessage(new Error(''), '')).toBe('조직 해석 실패');
    expect(safeMessage(undefined, '')).toBe('조직 해석 실패');
    expect(safeMessage('그냥   글자\n두 줄', '')).toBe('그냥 글자 두 줄');
    expect(safeMessage(new Error('정본 폴더가 없습니다: 실'), '')).toBe('정본 폴더가 없습니다: 실');
  });
});

/* ───────────── 플러그인 ───────────── */

describe('pbaiLocal', () => {
  it('개발 서버(serve)에서만 쓰는 플러그인', () => {
    const plugin = pbaiLocal({});
    expect(plugin.name).toBe('pbai-local');
    expect(plugin.apply).toBe('serve');
    expect(typeof plugin.configureServer).toBe('function');
    expect(pbaiLocal().apply).toBe('serve');
  });

  it('/__pbai/ 밖의 주소는 건드리지 않고 다음으로 넘긴다', async () => {
    const { request } = setup();
    for (const url of ['/', '/index.html', '/src/main.tsx', '/__pbaix/status', '/api/__pbai/status', '']) {
      expect((await request({ url })).nextCalled, url).toBe(true);
    }
  });

  it('쿼리 문자열과 끝 슬래시가 있어도 같은 길로 간다', async () => {
    const { request } = setup();
    expect((await request({ url: '/__pbai/status?x=1' })).status).toBe(200);
    expect((await request({ url: '/__pbai/status/' })).status).toBe(200);
  });

  it('base가 있으면 base 아래의 /__pbai/ 도 받는다(끝 슬래시 없는 base도)', async () => {
    for (const base of ['/pb-ai-company-dashboard/', '/pb-ai-company-dashboard']) {
      const { request } = setup({}, base);
      expect((await request({ url: '/pb-ai-company-dashboard/__pbai/status' })).status, base).toBe(200);
      expect((await request({ url: '/__pbai/status' })).status, base).toBe(200);
      expect((await request({ url: '/other/__pbai/status' })).nextCalled, base).toBe(true);
    }
    const { request: weird } = setup({}, './');
    expect((await weird({ url: '/__pbai/status' })).status).toBe(200);
  });

  it('GET·HEAD 말고는 405', async () => {
    const { request } = setup();
    const r = await request({ url: '/__pbai/status', method: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET, HEAD');
    expect(r.json()).toEqual({ error: '허용하지 않는 요청 방식' });
    expect((await request({ url: '/__pbai/events', method: 'DELETE' })).status).toBe(405);
  });

  it('없는 주소는 404', async () => {
    const { request } = setup();
    const r = await request({ url: '/__pbai/nothing' });
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ error: '알 수 없는 주소' });
    expect((await request({ url: '/__pbai/' })).status).toBe(404);
  });
});

describe('접근 제한', () => {
  it('루프백이 아닌 주소에서 온 요청은 403(기본)', async () => {
    const { request } = setup();
    for (const remote of ['192.168.0.5', '10.0.0.1', '8.8.8.8', '::ffff:192.168.0.5', 'fe80::1', '']) {
      const r = await request({ url: '/__pbai/status', remote });
      expect(r.status, remote).toBe(403);
      expect(r.json()).toEqual({ error: '이 PC에서만 열 수 있습니다' });
    }
  });

  it('루프백(127.0.0.1, ::1, ::ffff:127.0.0.1)은 받는다', async () => {
    const { request } = setup();
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await request({ url: '/__pbai/status', remote })).status, remote).toBe(200);
    }
  });

  it('Host가 localhost·127.0.0.1·[::1]이 아니면 403(DNS 재바인딩 방지). Host가 아예 없으면 받는다', async () => {
    const { request } = setup();
    for (const host of ['evil.example', 'evil.example:5173', '192.168.0.5:5173', 'localhost.evil.example', '127.0.0.1.evil.example']) {
      expect((await request({ url: '/__pbai/status', host })).status, host).toBe(403);
    }
    for (const host of ['localhost', 'LOCALHOST:5173', '127.0.0.1:5173', '[::1]:5173', '[::1]', null]) {
      expect((await request({ url: '/__pbai/status', host })).status, String(host)).toBe(200);
    }
  });

  it('PBAI_ALLOW_LAN=1 이면 다른 기기·다른 Host도 받는다. 그 밖의 값이면 계속 막는다', async () => {
    const { request } = setup({ PBAI_ALLOW_LAN: '1' });
    expect((await request({ url: '/__pbai/status', remote: '192.168.0.5', host: '192.168.0.7:5173' })).status).toBe(200);
    for (const value of ['0', 'true', '', undefined, ' 1']) {
      const { request: strict } = setup({ PBAI_ALLOW_LAN: value });
      expect((await strict({ url: '/__pbai/status', remote: '192.168.0.5' })).status, String(value)).toBe(403);
    }
  });

  it('403 응답에도 경로·설정 값이 없다', async () => {
    const dir = tmp();
    const file = writeFile(dir, 'e.jsonl', '');
    const { request } = setup({ PBAI_EVENTS_PATHS: file, PBAI_WIKI_ORG_DIR: dir });
    const r = await request({ url: '/__pbai/events', remote: '10.1.1.1' });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain(path.basename(dir));
  });
});

describe('/__pbai/status', () => {
  it('설정이 없으면 0개·없음·조직 설정 안 됨', async () => {
    const { request } = setup();
    const r = await request({ url: '/__pbai/status' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ events: { configured: 0, found: null }, org: { configured: false } });
  });

  it('처음으로 있는 경로의 번호만 알려 주고 절대 경로는 응답에 넣지 않는다', async () => {
    const dir = tmp();
    const second = writeFile(dir, 'second-secret-name.jsonl', nl('{"a":1}'));
    const missing = path.join(dir, 'missing-secret-name.jsonl');
    const { request } = setup({ PBAI_EVENTS_PATHS: `${missing};${second};${path.join(dir, 'third.jsonl')}`, PBAI_WIKI_ORG_DIR: dir });
    const r = await request({ url: '/__pbai/status' });
    expect(r.json()).toEqual({ events: { configured: 3, found: '경로 2' }, org: { configured: true } });
    for (const secret of [dir, path.basename(dir), 'second-secret-name', 'missing-secret-name', os.tmpdir()]) {
      expect(r.text, secret).not.toContain(secret);
    }
  });

  it('경로가 폴더이거나 없으면 found는 null', async () => {
    const dir = tmp();
    const { request } = setup({ PBAI_EVENTS_PATHS: `${dir};${path.join(dir, 'no.jsonl')}` });
    expect((await request({ url: '/__pbai/status' })).json().events).toEqual({ configured: 2, found: null });
  });

  it('HEAD 요청도 받는다', async () => {
    const { request } = setup();
    const r = await request({ url: '/__pbai/status', method: 'HEAD' });
    expect(r.status).toBe(200);
  });
});

describe('/__pbai/events', () => {
  it('설정한 경로 중 처음으로 있는 파일을 text/plain으로 보낸다(no-store)', async () => {
    const dir = tmp();
    const body = '{"v":1,"n":"가나다"}\n{"v":1,"n":2}\n';
    const first = path.join(dir, 'none.jsonl');
    const second = writeFile(dir, 'second.jsonl', body);
    const third = writeFile(dir, 'third.jsonl', nl('ignored'));
    const { request } = setup({ PBAI_EVENTS_PATHS: `${first};${second};${third}` });
    const r = await request({ url: '/__pbai/events' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(r.text).toBe(body);
  });

  it('앞 경로 파일이 생기면 그쪽을 보낸다(매 요청마다 다시 찾는다)', async () => {
    const dir = tmp();
    const early = path.join(dir, 'early.jsonl');
    const late = writeFile(dir, 'late.jsonl', nl('late'));
    const { request } = setup({ PBAI_EVENTS_PATHS: `${early};${late}` });
    expect((await request({ url: '/__pbai/events' })).text).toBe(nl('late'));
    writeFile(dir, 'early.jsonl', nl('early'));
    expect((await request({ url: '/__pbai/events' })).text).toBe(nl('early'));
  });

  it('파일이 없으면 404와 `이벤트 파일 없음`(경로는 없다). 설정이 없을 때도 같다', async () => {
    const dir = tmp();
    const { request } = setup({ PBAI_EVENTS_PATHS: path.join(dir, 'secret-file-name.jsonl') });
    const r = await request({ url: '/__pbai/events' });
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ error: '이벤트 파일 없음' });
    expect(r.text).not.toContain('secret-file-name');
    expect((await setup().request({ url: '/__pbai/events' })).status).toBe(404);
  });

  it('빈 파일은 200에 빈 본문', async () => {
    const dir = tmp();
    const { request } = setup({ PBAI_EVENTS_PATHS: writeFile(dir, 'empty.jsonl', '') });
    const r = await request({ url: '/__pbai/events' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('');
    expect(r.headers['content-length']).toBe('0');
  });

  it('HEAD는 머리글만', async () => {
    const dir = tmp();
    const { request } = setup({ PBAI_EVENTS_PATHS: writeFile(dir, 'a.jsonl', nl('abc')) });
    const r = await request({ url: '/__pbai/events', method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('4');
    expect(r.text).toBe('');
  });

  it('50MB를 넘으면 413', async () => {
    const dir = tmp();
    const big = path.join(dir, 'big.jsonl');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, MAX_EVENTS_BYTES + 1);
    const { request } = setup({ PBAI_EVENTS_PATHS: big });
    const r = await request({ url: '/__pbai/events' });
    expect(r.status).toBe(413);
    expect(r.json().error).toContain('50MB');
    expect(r.text).not.toContain('big.jsonl');
    fs.truncateSync(big, MAX_EVENTS_BYTES);                              // 딱 50MB는 보낸다
    const exact = await request({ url: '/__pbai/events', method: 'HEAD' });
    expect(exact.status).toBe(200);
    expect(exact.headers['content-length']).toBe(String(MAX_EVENTS_BYTES));
  });

  it('따옴표로 감싼 경로도 읽는다', async () => {
    const dir = tmp();
    const p = writeFile(dir, 'quoted name.jsonl', nl('q'));
    const { request } = setup({ PBAI_EVENTS_PATHS: `"${p}"` });
    expect((await request({ url: '/__pbai/events' })).text).toBe(nl('q'));
  });
});

describe('/__pbai/org', () => {
  it('폴더가 설정되지 않았으면 404', async () => {
    const { request } = setup();
    const r = await request({ url: '/__pbai/org' });
    expect(r.status).toBe(404);
    expect(r.json().error).toContain('Wiki 조직 폴더');
  });

  it('설정된 Wiki에서 조직을 만들어 JSON으로 보낸다(경로 없음)', async () => {
    const wiki = tinyWiki();
    const { request } = setup({ PBAI_WIKI_ORG_DIR: wiki });
    const r = await request({ url: '/__pbai/org' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    const org = r.json();
    expect(org.meta.counts).toEqual({ depts: 1, teams: 1, staff: 1, expansion: 0 });
    expect(org.staff[0].id).toBe('inv-01-e01');
    expect(r.text).not.toContain(path.basename(wiki));
    expect(r.text).not.toContain(os.tmpdir());
  });

  it('5초 동안은 캐시를 쓰고, 지나면 Wiki를 다시 읽는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
    const wiki = tinyWiki();
    const { request } = setup({ PBAI_WIKI_ORG_DIR: wiki });
    const first = await request({ url: '/__pbai/org' });
    expect(first.json().teams[0].name).toBe('수집팀');

    writeFile(wiki, '팀/inv-01.md', teamNote('바뀐팀'));
    vi.setSystemTime(new Date('2026-10-17T00:00:04.900Z'));
    expect((await request({ url: '/__pbai/org' })).json().teams[0].name).toBe('수집팀');
    vi.setSystemTime(new Date('2026-10-17T00:00:05.000Z'));
    expect((await request({ url: '/__pbai/org' })).json().teams[0].name).toBe('바뀐팀');
  });

  it('해석에 실패하면 500과 경로 없는 한 줄', async () => {
    const empty = tmp('pbai-plugin-emptywiki-');
    const { request } = setup({ PBAI_WIKI_ORG_DIR: empty });
    const r = await request({ url: '/__pbai/org' });
    expect(r.status).toBe(500);
    expect(r.json()).toEqual({ error: '정본 폴더가 없습니다: 실' });
    expect(r.text).not.toContain(path.basename(empty));

    const missing = path.join(os.tmpdir(), 'pbai-plugin-no-such-dir');
    const gone = await setup({ PBAI_WIKI_ORG_DIR: missing }).request({ url: '/__pbai/org' });
    expect(gone.status).toBe(500);
    expect(gone.text).not.toContain('pbai-plugin-no-such-dir');
  });

  it('실패한 결과는 캐시하지 않아 고치면 바로 읽힌다', async () => {
    const wiki = tmp('pbai-plugin-halfwiki-');
    const { request } = setup({ PBAI_WIKI_ORG_DIR: wiki });
    expect((await request({ url: '/__pbai/org' })).status).toBe(500);
    const full = tinyWiki();
    for (const sub of ['실', '팀', '직원']) fs.cpSync(path.join(full, sub), path.join(wiki, sub), { recursive: true });
    expect((await request({ url: '/__pbai/org' })).status).toBe(200);
  });
});

/* ───────────── 진짜 http 서버로 한 번 ───────────── */

describe('실제 http 서버', () => {
  it('이벤트 파일을 스트림으로 보내고, 엉뚱한 Host는 막는다', async () => {
    const dir = tmp();
    const body = `${'{"v":1,"message":"가나다라마바사"}\n'.repeat(5000)}`;       // 수백 KB: 여러 조각으로 나뉘어 간다
    const file = writeFile(dir, 'big.jsonl', body);
    const plugin = pbaiLocal({ PBAI_EVENTS_PATHS: file });
    const handlers = [];
    plugin.configureServer({ config: { base: '/' }, middlewares: { use: (fn) => { handlers.push(fn); } } });
    const server = http.createServer((req, res) => {
      handlers[0](req, res, () => { res.statusCode = 404; res.end('next'); });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const { port } = server.address();
      const ok = await fetch(`http://127.0.0.1:${port}/__pbai/events`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(await ok.text()).toBe(body);

      const other = await fetch(`http://127.0.0.1:${port}/index.html`);
      expect(other.status).toBe(404);
      expect(await other.text()).toBe('next');

      const spoofed = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/__pbai/events', headers: { Host: 'evil.example' } }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { text += c; });
          res.on('end', () => { resolve({ status: res.statusCode, text }); });
        });
        req.on('error', reject);
        req.end();
      });
      expect(spoofed.status).toBe(403);
      expect(spoofed.text).not.toContain('가나다라마바사');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    }
  });
});
