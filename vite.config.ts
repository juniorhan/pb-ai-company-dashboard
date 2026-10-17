import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { pbaiLocal } from './scripts/vite-plugin-pbai.mjs';

// 배포(GitHub Pages)와 배포 미리보기(npm run preview)는 저장소 이름 경로, 개발은 '/'. VITE_BASE로 덮어쓸 수 있다.
export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: env.VITE_BASE || (command === 'build' || isPreview ? '/pb-ai-company-dashboard/' : '/'),
    plugins: [react(), pbaiLocal(env)],
    server: { host: env.PBAI_ALLOW_LAN === '1' ? true : '127.0.0.1', port: 5173 },
    // 단일 화면 앱이라 한 묶음(React·zod 포함 약 530kB, gzip 약 160kB)이 정상이다. 기본 경고선(500kB)만 올린다.
    build: { chunkSizeWarningLimit: 800 },
    test: {
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    },
  };
});
