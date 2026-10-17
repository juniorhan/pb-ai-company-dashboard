// SVG <text>는 자동 말줄임이 없다. 글자 폭을 어림해 잘라 쓴다(순수 함수).

/** 글자 하나의 폭을 글자 크기(em) 비율로 어림한다: 한글·한자·전각 1.0, 영문 대문자 .68, 숫자·소문자·기호 .55, 공백 .3. */
function glyphEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x1100 && (code <= 0x11ff || (code >= 0x2e80 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef))) return 1;
  if (ch === ' ') return 0.3;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  if (code < 0x80) return 0.55;
  return 0.9;
}

export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += glyphEm(ch);
  return em * fontSize;
}

/** 폭 안에 들어가게 잘라 끝에 …을 붙인다. 이미 들어가면 그대로. */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const limit = maxWidth - fontSize * 0.9;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = glyphEm(ch) * fontSize;
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return `${out.trimEnd()}…`;
}

/** 글자 수(코드 포인트) 기준으로 자른다 — 이름표 '7자 넘으면 …'. */
export function shortLabel(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('').trimEnd()}…`;
}

/** 본부 이름의 첫 마디: '투자리서치·전략본부' → '투자리서치'. 필터 칩처럼 좁은 곳에 쓴다. */
export function firstSegment(name: string): string {
  const head = name.split(/[·・/]/)[0]?.trim();
  return head ? head : name;
}
