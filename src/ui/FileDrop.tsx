// 파일 끌어다 놓기: 창 전체가 놓는 자리. 파일을 끌고 있을 때만 안내 덮개가 보인다. 파일은 업로드하지 않는다.
import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';

/** 기록 파일로 받는 확장자(JSONL·JSON). 텍스트로 저장한 사본(.txt, .ndjson)도 받는다. */
export function isEventFileName(name: string): boolean {
  return /\.(jsonl|ndjson|json|txt)$/i.test(name);
}

export const FILE_REJECT_TEXT = '지원하지 않는 파일입니다. events.jsonl 또는 .json 파일을 놓아 주세요.';

/** 끌고 있는 동안 true. 놓으면 첫 파일을 onFile로 넘기고, 확장자가 맞지 않으면 onReject.
 *  enabled가 false(앞 파일을 읽는 중)여도 놓은 파일을 브라우저가 열어 버리지 않도록 이벤트는 받아서 막기만 한다. */
export function useFileDrop(onFile: (file: File) => void, onReject: (message: string) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; });
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!enabledRef.current) return;
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();                                   // 놓을 수 있다는 표시
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabledRef.current ? 'copy' : 'none';
    };
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e) || !enabledRef.current) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();                                   // 브라우저가 파일을 열어 버리지 않게
      depth = 0;
      setDragging(false);
      if (!enabledRef.current) return;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (isEventFileName(file.name)) onFile(file);
      else onReject(FILE_REJECT_TEXT);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      setDragging(false);
    };
  }, [onFile, onReject]);
  return dragging;
}

export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <FileUp size={30} />
        <p className="drop-title">여기에 events.jsonl 파일을 놓으세요</p>
        <p className="drop-sub">파일은 업로드되지 않고 이 브라우저 안에서만 읽습니다</p>
      </div>
    </div>
  );
}
