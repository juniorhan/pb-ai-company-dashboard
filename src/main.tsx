import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 글꼴은 전부 번들한다(외부 CDN 요청 없음): Pretendard Variable, 한글 글자 묶음(dynamic subset)은 쓰는 글자만 내려받는다.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소가 없습니다');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
