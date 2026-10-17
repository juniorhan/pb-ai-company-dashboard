// PB AI 회사 Wiki 정본(실·팀·직원 노트 + 04_조직 부속표) → 공개용 org.json.
// `npm run sync:org`와 로컬 개발 서버(/__pbai/org)가 같은 코드를 쓴다. 정본 해석이 바뀌면 이 파일만 고친다.
// 공개 저장소에 들어가므로 공개해도 되는 칸만 뽑고, 모든 글자에 공개 검사(lintPublic)를 건다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

export const FORMAT = 1;
export const LIB_VERSION = 'org-lib/1';        // 해석 규칙을 바꾸면 올린다(정본이 같아도 사본을 다시 만든다)
const FOLDERS = { dept: '실', team: '팀', staff: '직원' };
const EXTRA_NOTE = '04_조직 부속표.md';
const EXECUTOR_WORDS = [['Claude', 'claude'], ['Codex', 'codex'], ['Aside', 'aside'], ['스크립트', 'script'], ['사람', 'human']];
const STAFF_ID_RE = /\b[a-z]{2,3}-\d{2}-e\d{2}\b/g;
const OP_STATUSES = new Set(['active', 'building', 'planned', 'paused']);
const PHASES = new Set(['P0', 'P1', 'P2']);
const RISKS = new Set(['R0', 'R1', 'R2']);

// 공개 검사: 공개 사본에 들어가면 안 되는 모양. check-public.mjs도 이 목록을 쓴다.
export const PUBLIC_RULES = [
  [/[A-Za-z]:[\\/]/, '드라이브 경로'],
  [/(?:^|[\s(`'"])(?:[\w.-]+\\)+[\w.*-]+/, '역슬래시 경로'],
  [/[\\/](?:Users|home)[\\/]/i, '홈 폴더 경로'],
  [/MY OS|AppData|Desktop[\\/]/i, '내부 폴더 이름'],
  [/(?:^|[\s(`'"])(?:work|ops|ledger|evals|fixtures|queue)\/[\w./*-]+/, '내부 상대 경로'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, '메일 주소'],
  [/holdout[\\/]/i, '평가 정답 폴더 경로'],
  [/(?:ghp_|github_pat_|gho_|sk-[a-z0-9]|AKIA|AIza|xox[abpr]-)[\w-]{8,}/i, '비밀값 모양'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인 키'],
  [/\b[0-9a-f]{40,}\b/i, '긴 16진 문자열'],
  [/\b\d{6}\s?-\s?[1-8]\d{6}\b/, '주민등록번호 모양'],
  [/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/, '휴대폰 번호 모양'],
];

export function lintPublic(s) {
  return PUBLIC_RULES.filter(([re]) => re.test(String(s))).map(([, why]) => why);
}

// 위반 글자는 괄호 조각부터 지우고, 그래도 남으면 통째로 생략한다(규칙이 정해져 있어 결과가 늘 같다).
export function sanitizeText(s, where, report) {
  const text = String(s ?? '').trim();
  const hit = lintPublic(text);
  if (!hit.length) return text;
  const cut = text.replace(/\([^()]*\)/g, (seg) => (lintPublic(seg).length ? '' : seg)).replace(/\s{2,}/g, ' ').trim();
  if (cut && !lintPublic(cut).length) {
    report.push({ where, rules: hit, action: '괄호 조각 삭제' });
    return cut;
  }
  report.push({ where, rules: hit, action: '공개 사본에서 생략' });
  return '(공개 사본에서 생략)';
}

export function splitNote(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: null, body: text };
  return { fm: YAML.parse(m[1]) ?? {}, body: m[2] };
}

// '## 제목' 절 안의 마크다운 표 → 행 배열(머리줄·구분줄 제외). 절이 없으면 null.
export function sectionTable(body, heading) {
  const sec = section(body, heading);
  if (sec == null) return null;
  const rows = sec.split(/\r?\n/).filter((l) => /^\s*\|/.test(l));
  return rows.slice(2).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

export function sectionBullets(body, heading) {
  const sec = section(body, heading);
  if (sec == null) return null;
  return sec.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l)).map((l) => l.replace(/^\s*-\s+/, '').trim());
}

function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/\s+$/, '').startsWith(`## ${heading}`));
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

export function parseExecutors(text) {
  const t = String(text ?? '');
  return EXECUTOR_WORDS.filter(([w]) => t.includes(w)).map(([, e]) => e);
}

export function loadLocalEnv(root) {
  const env = {};
  for (const name of ['.env', '.env.local']) {          // 뒤 파일이 앞 파일을 덮는다
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return env;
}

export function buildOrg(wikiDir, { now = new Date() } = {}) {
  if (!wikiDir || !fs.existsSync(wikiDir)) throw new Error('Wiki 정본 폴더를 찾지 못했습니다(PBAI_WIKI_ORG_DIR 확인).');
  const warnings = [];
  const sanitized = [];
  const files = [];
  const read = (rel) => {
    const text = fs.readFileSync(path.join(wikiDir, rel), 'utf8');
    files.push([rel.split(path.sep).join('/'), text]);
    return text;
  };
  const notes = (kind) => {
    const dir = path.join(wikiDir, FOLDERS[kind]);
    if (!fs.existsSync(dir)) throw new Error(`정본 폴더가 없습니다: ${FOLDERS[kind]}`);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      .map((f) => ({ file: f, ...splitNote(read(path.join(FOLDERS[kind], f))) }))
      .filter((n) => n.fm && n.fm.is_test !== true);
  };
  const S = (v, where) => sanitizeText(v, where, sanitized);

  // 부속표(대표 몫·AI 총괄·확장 대기·본부 순서)
  let extra = { fm: {}, body: '' };
  if (fs.existsSync(path.join(wikiDir, EXTRA_NOTE))) extra = splitNote(read(EXTRA_NOTE));
  else warnings.push(`${EXTRA_NOTE}이 없어 대표 몫·AI 총괄·확장 대기 직책을 비워 둡니다.`);

  const legacy = { teams: {}, depts: {} };
  // 실
  const deptNotes = notes('dept').filter((n) => n.fm.type === 'dept');
  const depts = [];
  for (const n of deptNotes) {
    if (n.fm.status === 'frozen') {
      if (n.fm.successor) legacy.depts[n.fm.id] = String(n.fm.successor);
      continue;
    }
    const head = /본부장 역할:\s*(.+?)\(관리 역할/.exec(n.body)?.[1]?.trim();
    if (!head) warnings.push(`실 ${n.fm.id}: 본문에서 본부장 직책을 찾지 못해 '본부장'으로 둡니다.`);
    depts.push({ id: String(n.fm.id), name: S(n.fm.name, `dept ${n.fm.id}.name`), head: S(head || '본부장', `dept ${n.fm.id}.head`), role: S(n.fm.role ?? '', `dept ${n.fm.id}.role`) });
  }
  const order = Array.isArray(extra.fm?.dept_order) ? extra.fm.dept_order.map(String) : [];
  depts.sort((a, b) => rank(order, a.id) - rank(order, b.id) || a.id.localeCompare(b.id));
  const deptIds = new Set(depts.map((d) => d.id));

  // 팀
  const teams = [];
  for (const n of notes('team').filter((x) => x.fm.type === 'team')) {
    if (n.fm.status === 'frozen') {
      if (n.fm.successor) legacy.teams[n.fm.id] = String(n.fm.successor);
      continue;
    }
    const dept = String(n.fm.dept);
    if (!deptIds.has(dept)) { warnings.push(`팀 ${n.fm.id}: 본부 ${dept}가 활성 본부가 아니어서 뺍니다.`); continue; }
    teams.push({ id: String(n.fm.id), dept, name: S(n.fm.name, `team ${n.fm.id}.name`), role: S(n.fm.role ?? '', `team ${n.fm.id}.role`),
      status: opStatus(n.fm.status, `팀 ${n.fm.id}`, warnings), phase: PHASES.has(n.fm.phase) ? n.fm.phase : null });
  }
  teams.sort((a, b) => rank(order, a.dept) - rank(order, b.dept) || a.id.localeCompare(b.id));
  const teamIds = new Set(teams.map((t) => t.id));

  // 직원
  const staff = [];
  for (const n of notes('staff').filter((x) => x.fm.type === 'staff')) {
    if (n.fm.status === 'frozen') continue;
    const id = String(n.fm.id);
    const team = String(n.fm.team);
    if (!teamIds.has(team)) { warnings.push(`직원 ${id}: 팀 ${team}가 활성 팀이 아니어서 뺍니다.`); continue; }
    const titles = new Map();
    for (const b of sectionBullets(n.body, '담당 업무') ?? []) {
      const m = /^`([^`]+)`\s+(.+)$/.exec(b);
      if (m) titles.set(m[1], m[2]);
    }
    const duties = (Array.isArray(n.fm.duties) ? n.fm.duties : []).map(String)
      .map((d) => ({ id: d, title: S(titles.get(d) ?? d, `staff ${id}.duty ${d}`) }));
    const checker = String(n.fm.checker ?? '');
    staff.push({
      id, team, dept: team.slice(0, team.indexOf('-')), name: S(n.fm.name, `staff ${id}.name`), role: S(n.fm.role ?? '', `staff ${id}.role`),
      status: opStatus(n.fm.status, `직원 ${id}`, warnings), phase: PHASES.has(n.fm.phase) ? n.fm.phase : null,
      risk: RISKS.has(n.fm.risk_class) ? n.fm.risk_class : null,
      executors: parseExecutors(n.fm.ai_writer),
      checkers: parseExecutors(checker.replace(STAFF_ID_RE, '')),
      checker_staff: [...new Set(checker.match(STAFF_ID_RE) ?? [])].filter((x) => x !== id),
      duties,
    });
  }
  staff.sort((a, b) => a.id.localeCompare(b.id));
  const staffIds = new Set(staff.map((s) => s.id));
  for (const s of staff) {
    if (!s.executors.length) warnings.push(`직원 ${s.id}: 작성·수행 주체(ai_writer)를 읽지 못했습니다.`);
    const gone = s.checker_staff.filter((x) => !staffIds.has(x));
    if (gone.length) warnings.push(`직원 ${s.id}: 검증자 ${gone.join(', ')}가 활성 직원이 아닙니다.`);
  }
  for (const t of teams) if (!staff.some((s) => s.team === t.id)) warnings.push(`팀 ${t.id}: 직원이 0명입니다.`);

  // 대표·AI 총괄·확장 대기
  const holds = (sectionBullets(extra.body, '대표 역할') ?? []).map((h, i) => S(h, `ceo.holds[${i}]`));
  const ownerOnly = (sectionTable(extra.body, '대표 몫') ?? []).filter((r) => r.length >= 2)
    .map((r) => ({ task: r[0], title: S(r[1], `owner_only ${r[0]}`) }));
  const hq = (sectionTable(extra.body, 'AI 총괄 체계') ?? []).filter((r) => r.length >= 4).map((r) => ({
    id: r[0], name: S(r[1], `hq ${r[0]}.name`), executor: parseExecutors(r[1])[0] ?? r[2], role: S(r[3], `hq ${r[0]}.role`),
  }));
  const expansion = [];
  for (const r of sectionTable(extra.body, '확장 대기 직책') ?? []) {
    if (r.length < 3) continue;
    if (!teamIds.has(r[0])) { warnings.push(`확장 대기 직책 '${r[1]}': 팀 ${r[0]}가 활성 팀이 아니어서 뺍니다.`); continue; }
    expansion.push({ team: r[0], role: S(r[1], `expansion ${r[0]}.role`), trigger: S(r[2], `expansion ${r[0]}.trigger`) });
  }

  const hash = crypto.createHash('sha256').update(LIB_VERSION);
  for (const [rel, text] of files.sort((a, b) => a[0].localeCompare(b[0]))) hash.update(`\0${rel}\0${text}`);
  const org = {
    format: FORMAT,
    meta: {
      generated_at: now.toISOString(),
      source: 'wiki',
      source_hash: hash.digest('hex'),
      counts: { depts: depts.length, teams: teams.length, staff: staff.length, expansion: expansion.length },
    },
    ceo: { title: S(extra.fm?.ceo_title ?? '대표이사', 'ceo.title'), holds, owner_only: ownerOnly },
    hq,
    depts,
    teams,
    staff,
    expansion,
    legacy,
  };
  const problems = validateOrgShape(org);
  if (problems.length) throw new Error(`조직 사본 검사 실패:\n- ${problems.join('\n- ')}`);
  return { org, warnings, sanitized };
}

// 구조 검사(앱의 zod 검사와 같은 뜻). 숫자를 고정하지 않고 서로 맞는지만 본다.
export function validateOrgShape(org) {
  const p = [];
  const dup = (arr, what) => {
    const seen = new Set();
    for (const x of arr) { if (seen.has(x.id)) p.push(`${what} id 중복: ${x.id}`); seen.add(x.id); }
  };
  dup(org.depts, '본부'); dup(org.teams, '팀'); dup(org.staff, '직원'); dup(org.hq, 'AI 총괄');
  const d = new Set(org.depts.map((x) => x.id));
  const t = new Set(org.teams.map((x) => x.id));
  for (const x of org.teams) if (!d.has(x.dept)) p.push(`팀 ${x.id}의 본부 ${x.dept} 없음`);
  for (const x of org.staff) {
    if (!t.has(x.team)) p.push(`직원 ${x.id}의 팀 ${x.team} 없음`);
    if (!x.team.startsWith(`${x.dept}-`)) p.push(`직원 ${x.id}의 본부 표기 불일치`);
  }
  for (const x of org.expansion) if (!t.has(x.team)) p.push(`확장 대기 직책의 팀 ${x.team} 없음`);
  const c = org.meta.counts;
  if (c.depts !== org.depts.length || c.teams !== org.teams.length || c.staff !== org.staff.length || c.expansion !== org.expansion.length) p.push('meta.counts가 실제 개수와 다름');
  const text = JSON.stringify({ ...org, meta: { ...org.meta, source_hash: '' } });
  const hit = lintPublic(text);
  if (hit.length) p.push(`공개 검사 위반: ${[...new Set(hit)].join(', ')}`);
  return p;
}

function rank(order, id) {
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
}

function opStatus(v, where, warnings) {
  if (OP_STATUSES.has(v)) return v;
  warnings.push(`${where}: 운영 상태 '${v}'를 몰라 planned로 둡니다.`);
  return 'planned';
}
