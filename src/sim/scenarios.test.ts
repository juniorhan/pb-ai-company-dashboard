// 번들된 시나리오 파일이 지금 조직에서 끝까지 해석되는지 본다(조직이 바뀌어 깨지면 시나리오를 고친다).
import { describe, expect, it } from 'vitest';
import bundledOrg from '../data/org.json';
import { indexOrg, parseOrg } from '../data/org';
import { resolveActor } from '../core/resolve';
import { collectActorRefs, scenarioRealSeconds } from './compile';
import { loadScenarioLibrary } from './load';

const index = indexOrg(parseOrg(bundledOrg));
const library = loadScenarioLibrary();

describe('시나리오 라이브러리', () => {
  it('src/scenarios/*.json 전부가 경고 없이 읽힌다', () => {
    expect(library.warnings).toEqual([]);
    expect(library.scenarios.size).toBeGreaterThan(0);
    expect(library.plans.size).toBeGreaterThan(0);
  });

  it('메뉴 첫 항목은 하루 압축 재생(day)이고, 계획과 시나리오가 모두 들어 있다', () => {
    expect(library.menu[0]?.id).toBe('day');
    const ids = library.menu.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...library.plans.keys(), ...library.scenarios.keys()]) expect(ids).toContain(id);
    expect(ids).toHaveLength(library.plans.size + library.scenarios.size);
  });

  it('하루 계획의 모든 구간이 있는 시나리오를 가리킨다', () => {
    for (const plan of library.plans.values()) {
      for (const seg of plan.segments) {
        if ('scenario' in seg) expect(library.scenarios.has(seg.scenario), `${plan.id} → ${seg.scenario}`).toBe(true);
      }
    }
  });

  it('모든 시나리오의 모든 행위자(승인 분기 안 포함)가 지금 조직에서 해석된다', () => {
    for (const sc of library.scenarios.values()) {
      const refs = collectActorRefs(sc.steps);
      expect(refs.length, sc.id).toBeGreaterThan(0);
      for (const ref of refs) {
        const r = resolveActor(ref, index);
        expect(r.ok, `${sc.id}: ${JSON.stringify(ref)} → ${r.id}`).toBe(true);
      }
    }
  });

  it('시나리오 하나의 실제 길이(본 단계 + 승인 단계, 1배속)는 150~200초', () => {
    for (const sc of library.scenarios.values()) {
      const sec = scenarioRealSeconds(sc);
      expect(sec, `${sc.id} = ${sec}초`).toBeGreaterThanOrEqual(150);
      expect(sec, `${sc.id} = ${sec}초`).toBeLessThanOrEqual(200);
    }
  });

  it('승인 단계가 있는 시나리오는 승인 분기(on_approve·on_reject)가 모두 비어 있지 않다', () => {
    for (const sc of library.scenarios.values()) {
      const walk = (steps: typeof sc.steps): void => {
        for (const st of steps) {
          if (st.do !== 'approval') continue;
          expect(st.on_approve.length, `${sc.id} on_approve`).toBeGreaterThan(0);
          expect(st.on_reject.length, `${sc.id} on_reject`).toBeGreaterThan(0);
          walk(st.on_approve);
          walk(st.on_reject);
        }
      };
      walk(sc.steps);
    }
  });

  it('시뮬레이션 문구에 종목 추천·매매 지시·승인 주장이 없다', () => {
    const banned = [/매수|매도|사세요|파세요|목표주가|추천 종목|종목 추천/, /(준법감시|금융당국).{0,8}승인(을|이)?\s?(받|완료|획득)/];
    for (const sc of library.scenarios.values()) {
      const raw = JSON.stringify(sc);
      for (const re of banned) expect(re.test(raw), `${sc.id}: ${re}`).toBe(false);
    }
  });
});
