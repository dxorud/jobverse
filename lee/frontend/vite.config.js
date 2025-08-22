import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    plugins: [react()],

    base: isDev ? '/' : '/interview/',

    // 로컬 개발 서버 설정
    server: isDev
      ? {
          host: '0.0.0.0',
          port: 8501,
          strictPort: true,
          proxy: {
            // 인터뷰 API 프록시
            '/interview-api': {
              target: 'http://localhost:3000',
              changeOrigin: true,
            },
            // 챗봇 API 프록시
            '/chatbot-api': {
              target: 'http://localhost:3000',
              changeOrigin: true,
            },
          },
        }
      : undefined, 
  }
})
