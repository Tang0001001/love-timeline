// 全局公开配置（VITE_ 前缀变量会出现在浏览器端，只能放公开信息）
// 高权限密钥（service_role 等）绝不允许出现在这里。

function env(name) {
  return import.meta.env[name] || '';
}

export const SUPABASE_URL = env('VITE_SUPABASE_URL').replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = env('VITE_SUPABASE_PUBLISHABLE_KEY');
export const DEFAULT_MUSIC_URL = env('VITE_MUSIC_URL');

export const STORAGE_BUCKET = 'couple-photos';

// 上传限制
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_BATCH = 9;                     // 单次最多 9 张
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

// 邀请默认有效期（小时）
export const INVITE_TTL_HOURS = 48;

// 签名 URL 有效期（秒）与提前刷新阈值
export const SIGNED_URL_TTL = 3600;
export const SIGNED_URL_REFRESH_AHEAD = 600;

// 图片压缩参数
export const COMPRESS_MAX_EDGE = 2000;
export const COMPRESS_QUALITY = 0.86;

// localStorage 键名
export const LS_KEYS = {
  theme: 'love.theme',
  pendingInvite: 'love.pendingInvite',
  pendingStorageDeletes: 'love.pendingStorageDeletes'
};

/** 环境变量是否已配置 */
export function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

/** 显示配置缺失错误页（开发期提示，而不是静默白屏） */
export function showConfigError() {
  const el = document.getElementById('loading-screen');
  if (el) {
    el.innerHTML =
      '<div class="max-w-md px-6 text-center">' +
      '<p class="font-serif text-lg text-rosedeep">缺少 Supabase 配置</p>' +
      '<p class="mt-3 text-sm text-muted leading-relaxed">请复制 <code>.env.example</code> 为 <code>.env.local</code>，' +
      '填入 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 后重启开发服务器。' +
      '详细步骤见 README。</p></div>';
  }
}
