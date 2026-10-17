// 화면 훅. 스토어·시뮬레이션 시계를 React에 잇는다.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { DashboardStore, DashboardView, SimControl } from '../types';

/** store 알림이 초당 20회를 넘지 않게 한 번 더 묶는다(코어도 같은 한도를 지키지만 화면이 마지막 방어선). */
const NOTIFY_MIN_INTERVAL_MS = 50;

function throttledSubscribe(store: DashboardStore, listener: () => void): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => { timer = null; last = Date.now(); listener(); };
  const unsubscribe = store.subscribe(() => {
    const wait = NOTIFY_MIN_INTERVAL_MS - (Date.now() - last);
    if (wait <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      fire();
    } else if (!timer) {
      timer = setTimeout(fire, wait);
    }
  });
  return () => { unsubscribe(); if (timer) clearTimeout(timer); };
}

/** useSyncExternalStore(store.subscribe, store.getView). getView는 바뀐 것이 없으면 같은 객체를 준다. */
export function useView(store: DashboardStore): DashboardView {
  const subscribe = useCallback((listener: () => void) => throttledSubscribe(store, listener), [store]);
  const getSnapshot = useCallback(() => store.getView(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface SimSnapshot { clock: string; playing: boolean; speed: number; scenario: string; autoApprove: boolean }

function readSim(control: SimControl): SimSnapshot {
  return { clock: control.clock(), playing: control.isPlaying(), speed: control.getSpeed(), scenario: control.getScenario(), autoApprove: control.getAutoApprove() };
}
const sameSim = (a: SimSnapshot, b: SimSnapshot): boolean =>
  a.clock === b.clock && a.playing === b.playing && a.speed === b.speed && a.scenario === b.scenario && a.autoApprove === b.autoApprove;

/** subscribeTick으로 시뮬레이션 시계·재생 상태를 따라간다(초당 최대 4회). control이 없으면 null. */
export function useSimTick(control: SimControl | undefined): SimSnapshot | null {
  const [snap, setSnap] = useState<SimSnapshot | null>(() => (control ? readSim(control) : null));
  useEffect(() => {
    if (!control) { setSnap(null); return undefined; }
    const update = (): void => setSnap((prev) => { const next = readSim(control); return prev && sameSim(prev, next) ? prev : next; });
    update();
    return control.subscribeTick(update);
  }, [control]);
  return control ? snap : null;
}

/** 지금 시각(밀리초)을 intervalMs마다 갱신한다. 실연결의 '기다린 시간' 같은 곳에 쓴다. */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/* ───────────── 미디어 쿼리 ───────────── */

export function useMedia(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const mql = window.matchMedia(query);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);
  const getSnapshot = useCallback(
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useReducedMotion(): boolean {
  return useMedia('(prefers-reduced-motion: reduce)');
}

/** 휴대폰 폭(<720px). 숨겨진 무거운 패널을 만들지 않는 데만 쓴다(배치는 CSS가 정한다). */
export function useIsPhone(): boolean {
  return useMedia('(max-width: 719px)');
}

/* ───────────── 테마 ───────────── */

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY = 'pbai.theme';
const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** 시스템 → 라이트 → 다크 순으로 돌린다. localStorage 'pbai.theme'에 저장하고 <html data-theme>를 단다('시스템'이면 속성을 뺀다). */
export function useTheme(): { theme: ThemeChoice; cycle(): void } {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장을 못 해도 이번 화면에서는 적용된다 */ }
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((prev) => THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length]!);
  }, []);
  return { theme, cycle };
}

/* ───────────── 저장되는 작은 상태 ───────────── */

/** localStorage에 JSON으로 저장되는 상태. 읽기·쓰기가 막혀도(try/catch) 화면은 정상 동작한다. */
export function usePersistentState<T>(key: string, initial: T, validate: (value: unknown) => value is T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (validate(parsed)) return parsed;
      }
    } catch { /* 읽지 못하면 기본값 */ }
    return initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 실패는 무시 */ }
  }, [key, value]);
  return [value, setValue];
}
