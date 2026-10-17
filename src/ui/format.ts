// 시각·시간 표기 도우미(순수 함수). 모든 시각은 KST(+09:00)로 보여 준다 — 기기 시간대와 무관하게 같은 글자가 나온다.
const KST_OFFSET_MS = 9 * 3600_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const p2 = (n: number): string => String(n).padStart(2, '0');

/** ISO 문자열·밀리초 → KST 값을 UTC getter로 읽을 수 있게 민 Date. 읽을 수 없으면 null. */
function kst(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? new Date(t + KST_OFFSET_MS) : null;
}

export function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** 밀리초 → '2026-10-17T06:30:00+09:00' 꼴(KST). 시뮬레이션 시계·되감기 지점에 쓴다. */
export function toKstIso(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+09:00');
}

/** HH:MM:SS(KST). 읽을 수 없으면 '--:--:--'. */
export function formatClock(value: string | null | undefined): string {
  const d = kst(value);
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` : '--:--:--';
}

/** HH:MM(KST). */
export function formatClockShort(value: string | null | undefined): string {
  const d = kst(value);
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : '--:--';
}

/** '10월 17일(금) 06:42'(KST). */
export function formatDateTimeKo(value: string | null | undefined): string {
  const d = kst(value);
  if (!d) return '--';
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEKDAYS[d.getUTCDay()]}) ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** '2026-10-17 13:59'(KST) — 조직 사본 생성 시각 등. */
export function formatStamp(value: string | null | undefined): string {
  const d = kst(value);
  if (!d) return '시각 미확인';
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** '10/17'(KST) — 조직 기준 알약. */
export function formatMonthDay(value: string | null | undefined): string {
  const d = kst(value);
  return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : '--';
}

/** 절약 추정 분 → '45분' · '2시간 5분'. 음수·비수는 0분. */
export function formatDuration(minutes: number): string {
  const total = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

/** 기다린 시간(밀리초) → '45초' · '3분' · '1시간 20분'. */
export function formatWaited(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}
