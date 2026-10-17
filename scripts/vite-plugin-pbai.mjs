// 개발 서버(npm run dev) 전용 /__pbai/* — 이 PC의 실제 기록 파일과 Wiki 정본 조직을 화면에 준다(docs/DESIGN.md §7).
// - 기본은 이 PC(루프백)에서 온 요청만 받는다. PBAI_ALLOW_LAN=1이면 다른 기기도 받는다.
// - 응답에 절대 경로를 넣지 않는다('경로 1' 같은 이름만).
// - 배포 빌드에는 들어가지 않는다(apply: 'serve').
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { buildOrg, lintPublic } from './org-lib.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const MAX_EVENTS_BYTES = 50 * 1024 * 1024;
const ORG_CACHE_MS = 5000;

/** `;`로 나눈 경로 목록: 앞뒤 공백·감싼 따옴표를 지우고 빈 항목은 뺀다. */
export function parsePaths(value) {
  return String(value ?? '')
    .split(';')
    .map((p) => p.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter(Boolean);
}

/** 처음으로 있는 파일: { n(1부터), path, size } 또는 null */
function firstExisting(paths) {
  for (let i = 0; i < paths.length; i += 1) {
    try {
      const st = fs.statSync(paths[i]);
      if (st.isFile()) return { n: i + 1, path: paths[i], size: st.size };
    } catch {
      // 없는 경로는 다음으로
    }
  }
  return null;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/** 조직 해석 오류 → 경로가 없는 한 줄. 설정한 폴더 경로를 지우고도 공개 검사에 걸리면 일반 문구로 바꾼다. */
export function safeMessage(error, wikiDir) {
  let msg = error instanceof Error ? error.message : String(error ?? '');
  if (wikiDir) {
    for (const variant of new Set([wikiDir, wikiDir.replace(/\\/g, '/'), wikiDir.replace(/\//g, '\\')])) {
      msg = msg.split(variant).join('<폴더>');
    }
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  return !msg || lintPublic(msg).length ? '조직 해석 실패' : msg;
}

/**
 * @param {Record<string, string | undefined>} [env] loadEnv로 읽은 환경 변수(PBAI_EVENTS_PATHS, PBAI_WIKI_ORG_DIR, PBAI_ALLOW_LAN)
 * @returns {import('vite').Plugin}
 */
export function pbaiLocal(env = {}) {
  const allowLan = env.PBAI_ALLOW_LAN === '1';
  const eventPaths = parsePaths(env.PBAI_EVENTS_PATHS);
  const wikiDir = String(env.PBAI_WIKI_ORG_DIR ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  let orgCache = null;                   // { at, body }

  function handle(req, res, route) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: '허용하지 않는 요청 방식' });
    }
    if (route === 'status') {
      const found = firstExisting(eventPaths);
      return sendJson(res, 200, {
        events: { configured: eventPaths.length, found: found ? `경로 ${found.n}` : null },
        org: { configured: wikiDir !== '' },
      });
    }
    if (route === 'events') {
      const found = firstExisting(eventPaths);
      if (!found) return sendJson(res, 404, { error: '이벤트 파일 없음' });
      if (found.size > MAX_EVENTS_BYTES) return sendJson(res, 413, { error: '이벤트 파일이 너무 큽니다(50MB 초과)' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(found.size));
      if (req.method === 'HEAD' || found.size === 0) return res.end();
      const stream = fs.createReadStream(found.path, { start: 0, end: found.size - 1 });   // 읽는 동안 파일이 늘어도 처음 잰 크기만 보낸다
      return pipeline(stream, res, () => undefined);                                      // 중간에 끊겨도 파일을 닫는다
    }
    if (route === 'org') {
      if (!wikiDir) return sendJson(res, 404, { error: 'Wiki 조직 폴더가 설정되지 않았습니다' });
      const nowMs = Date.now();
      if (orgCache && nowMs - orgCache.at < ORG_CACHE_MS) return sendJson(res, 200, orgCache.body);
      try {
        const { org } = buildOrg(wikiDir, { now: new Date() });
        orgCache = { at: nowMs, body: org };
        return sendJson(res, 200, org);
      } catch (e) {
        return sendJson(res, 500, { error: safeMessage(e, wikiDir) });
      }
    }
    return sendJson(res, 404, { error: '알 수 없는 주소' });
  }

  return {
    name: 'pbai-local',
    apply: 'serve',
    configureServer(server) {
      const rawBase = String(server.config?.base ?? '/');
      const base = rawBase.startsWith('/') ? (rawBase.endsWith('/') ? rawBase : `${rawBase}/`) : '/';
      const prefixes = new Set(['/__pbai/', `${base}__pbai/`]);
      server.middlewares.use((req, res, next) => {
        const url = String(req.url ?? '');
        const pathname = url.split('?')[0];
        let prefix = null;
        for (const p of prefixes) if (pathname.startsWith(p)) prefix = p;
        if (prefix === null) return next();

        if (!allowLan) {
          const remote = req.socket?.remoteAddress ?? '';
          const host = String(req.headers?.host ?? '').toLowerCase().replace(/:\d+$/, '');
          if (!LOOPBACK.has(remote) || (host !== '' && !LOOPBACK_HOSTS.has(host))) return sendJson(res, 403, { error: '이 PC에서만 열 수 있습니다' });
        }
        return handle(req, res, pathname.slice(prefix.length).replace(/\/+$/, ''));
      });
    },
  };
}
