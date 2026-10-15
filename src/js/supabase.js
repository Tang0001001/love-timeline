import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured, showConfigError } from './config.js';

if (!isConfigured()) {
  showConfigError();
  throw new Error('Missing Supabase configuration (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY)');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,     // 刷新后恢复会话
    autoRefreshToken: true,
    detectSessionInUrl: true  // 处理邮箱验证 / 密码重置回调
  }
});
