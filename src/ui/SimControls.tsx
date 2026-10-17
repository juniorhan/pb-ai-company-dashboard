// 시뮬레이션 조작(SimControl이 있을 때만): ▶/⏸, 1x·2x·5x, 시나리오 선택, 자동 승인(시연) 스위치.
import { Pause, Play } from 'lucide-react';
import type { SimControl } from '../types';
import type { SimSnapshot } from './hooks';

const SPEEDS = [1, 2, 5];

export function SimControls({ control, sim }: { control: SimControl; sim: SimSnapshot | null }) {
  const scenarios = control.listScenarios();
  const playing = sim?.playing ?? control.isPlaying();
  const speed = sim?.speed ?? control.getSpeed();
  const scenario = sim?.scenario ?? control.getScenario();
  const autoApprove = sim?.autoApprove ?? control.getAutoApprove();
  const current = scenarios.find((s) => s.id === scenario);
  return (
    <div className="sim-controls" role="group" aria-label="시뮬레이션 조작">
      <button
        type="button"
        className="btn btn-icon btn-primary"
        aria-label={playing ? '일시정지' : '재생'}
        title={playing ? '일시정지' : '재생'}
        onClick={() => (playing ? control.pause() : control.play())}
      >
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <div className="segmented" role="group" aria-label="재생 속도">
        {SPEEDS.map((x) => (
          <button key={x} type="button" className="seg" aria-pressed={speed === x} aria-label={`${x}배속`} onClick={() => control.setSpeed(x)}>
            {x}x
          </button>
        ))}
      </div>
      <label className="select-wrap" title={current?.description}>
        <span className="sr-only">시나리오</span>
        <select aria-label="시나리오" value={scenario} onChange={(e) => control.setScenario(e.target.value)}>
          {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={autoApprove}
        aria-label="자동 승인(시연)"
        title="켜면 승인 요청이 약 20초 뒤 자동으로 승인됩니다(시뮬레이션 전용)"
        onClick={() => control.setAutoApprove(!autoApprove)}
      >
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-text">자동 승인(시연)</span>
      </button>
    </div>
  );
}
