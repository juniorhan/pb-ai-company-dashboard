// 시험 전용 가짜 시계·타이머: 실제 시간을 기다리지 않고 SimulatorSource를 끝까지 돌린다(화면 코드는 이 파일을 가져오지 않는다).
export interface FakeClock {
  /** 지금 가짜 시각(ms) */
  now(): number;
  /** 시간이 지나면 fn을 부르고, 취소 함수를 돌려준다(SimulatorOptions.setTimer와 같은 모양) */
  setTimer(fn: () => void, ms: number): () => void;
  /** 가짜 시간을 ms만큼 보낸다. 그 사이 도래한 타이머는 시각 순(같으면 먼저 등록한 순)으로 실행한다. */
  run(ms: number): void;
  /** 아직 남은 타이머 수 */
  pending(): number;
}

export function createFakeClock(startMs = Date.parse('2026-01-01T00:00:00Z')): FakeClock {
  let nowMs = startMs;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const setTimer = (fn: () => void, ms: number): (() => void) => {
    nextId += 1;
    const id = nextId;
    timers.set(id, { at: nowMs + Math.max(0, ms), fn });
    return () => { timers.delete(id); };
  };

  const run = (ms: number): void => {
    const target = nowMs + ms;
    for (;;) {
      let pick: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) {
        if (entry[1].at > target) continue;
        if (!pick || entry[1].at < pick[1].at || (entry[1].at === pick[1].at && entry[0] < pick[0])) pick = entry;
      }
      if (!pick) break;
      timers.delete(pick[0]);
      nowMs = Math.max(nowMs, pick[1].at);
      pick[1].fn();
    }
    nowMs = target;
  };

  return { now: () => nowMs, setTimer, run, pending: () => timers.size };
}
