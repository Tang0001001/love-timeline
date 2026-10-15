import { defineConfig } from 'vite';

// 托管平台会注入 PORT 环境变量，必须监听它；本地开发回退到 5173
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  server: {
    port,
    host: '0.0.0.0',
    // 反向代理域名（*.app.workbuddy.host 等）需要放行，否则 Vite 会拒绝请求
    allowedHosts: true
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true
  },
  build: {
    target: 'es2019',
    outDir: 'dist'
  }
});
