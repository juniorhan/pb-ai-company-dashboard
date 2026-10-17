// 화면 전체가 같이 쓰는 값: 조직 색인, 선택한 행위자(상세 서랍), 움직임 줄이기 여부.
import { createContext, useContext } from 'react';
import type { OrgIndex } from '../types';

export interface UiContextValue {
  index: OrgIndex;
  /** 상세 서랍에 열려 있는 행위자 id(직원·대표·AI 총괄·미배정). 없으면 null */
  selectedId: string | null;
  select(id: string | null): void;
  reducedMotion: boolean;
}

export const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const value = useContext(UiContext);
  if (!value) throw new Error('UiContext 밖에서 화면 컴포넌트를 쓸 수 없습니다');
  return value;
}
