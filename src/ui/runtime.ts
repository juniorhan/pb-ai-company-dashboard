// 코어와 화면을 잇는 단 한 곳. 컴포넌트는 DashboardStore·EventSource·SimControl 인터페이스(types.ts)만 쓰고,
// 코어 구현(설정·소스·스토어)은 여기서만 부른다(AGENTS.md §4).
//
// 연결 순서: loadOrg → indexOrg → (?mock=1이면 개발용 가짜 스토어) 아니면 readConfig → createSource → createDashboardStore → source.start().
import { readConfig } from '../config';
import { createDashboardStore } from '../core/store';
import { indexOrg, loadOrg } from '../data/org';
import { createFileSource, createSource } from '../sources';
import type { DashboardStore, OrgIndex } from '../types';

export interface OrgMeta { origin: 'live' | 'bundled'; generatedAt: string; hash: string }
/** core = 실제 코어(시뮬레이터·기록 소스), mock = ?mock=1로 고른 개발용 가짜 스토어 */
export type RuntimeMode = 'mock' | 'core';

export interface Runtime {
  index: OrgIndex;
  store: DashboardStore;
  orgMeta: OrgMeta;
  /** 조직을 실시간으로 읽지 못해 사본을 쓴 이유 등(없으면 null) */
  orgNote: string | null;
  mode: RuntimeMode;
  /** 파일 열기로 만든 런타임이면 파일 이름 */
  fileName: string | null;
  initialView: 'office' | 'org';
}

function readParams(search: string): URLSearchParams {
  try { return new URLSearchParams(search); } catch { return new URLSearchParams(); }
}

/** 조직을 읽고 → 소스·스토어를 만들어 시작한다. 조직 사본이 잘못되면 OrgError로 거절한다(오류 화면에서 안내). */
export async function createRuntime(search: string = typeof location !== 'undefined' ? location.search : ''): Promise<Runtime> {
  const loaded = await loadOrg();
  const index = indexOrg(loaded.org);
  const orgMeta: OrgMeta = { origin: loaded.origin, generatedAt: loaded.org.meta.generated_at, hash: loaded.org.meta.source_hash };
  const params = readParams(search);
  const config = readConfig(search);
  const base = { index, orgMeta, orgNote: loaded.note, fileName: null as string | null, initialView: config.view };

  if (import.meta.env.DEV && params.get('mock') === '1') {
    // 개발용: 코어 없이 화면만 돌려 본다. 개발 서버에서만 켜지고 배포 번들에는 들어가지 않는다.
    const { createMockStore } = await import('./dev/mockStore');
    const seed = Number(params.get('seed'));
    const store = createMockStore(index, {
      org: orgMeta,
      autoRun: params.get('autorun') !== '0',
      ...(params.get('seed') && Number.isFinite(seed) ? { seed } : {}),
      ...(params.get('unassigned') === '1' ? { unassignedEvery: 9 } : {}),
    });
    store.source.start();
    return { ...base, store, mode: 'mock' };
  }

  const source = createSource(config, index);
  const store = createDashboardStore(index, source, orgMeta);
  source.start();
  return { ...base, store, mode: 'core' };
}

/** 파일을 열어 화면을 파일 소스로 바꾼다. 읽는 일은 브라우저 안에서만 한다(업로드 없음). 현재 store는 새 store가 만들어진 뒤 dispose한다. */
export async function openFile(current: Runtime, file: File): Promise<Runtime> {
  const source = createFileSource(file);
  const store = createDashboardStore(current.index, source, current.orgMeta);
  source.start();
  current.store.dispose();
  return { ...current, store, mode: 'core', fileName: file.name };
}

/** 원래 소스(URL 설정대로)로 돌아간다: 새로 만든 뒤 현재 store를 dispose. */
export async function reconnect(current: Runtime, search?: string): Promise<Runtime> {
  const next = await createRuntime(search);
  current.store.dispose();
  return next;
}
