// auth.js —— 注册 / 登录 / 退出 / 邮箱验证 / 密码重置 / 会话恢复
// 会话由 @supabase/supabase-js 自动持久化（localStorage），刷新后恢复。

import { supabase } from './supabase.js';

/**
 * 邮箱规范化：全角字符转半角（中文输入法常见坑）、去首尾空格、转小写。
 * 例如 "ｅｘａｍｐｌｅ＠ｑｑ．ｃｏｍ" -> "example@qq.com"
 */
export function normalizeEmail(email) {
  return String(email || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .trim()
    .toLowerCase();
}

/** 简单邮箱格式校验（用于提交前给出友好提示） */
export function isEmailFormatValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 注册。返回 { needsVerification } 或抛错 */
export async function signUpWithEmail(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email: normalizeEmail(email),
    password
  });
  if (error) throw error;
  // 若项目开启了「邮箱验证」，则没有 session，需要用户先验证
  const needsVerification = !data.session;
  return { needsVerification, user: data.user };
}

/** 登录。成功返回用户；失败抛错 */
export async function signInWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password
  });
  if (error) throw error;
  return data.user;
}

/** 退出登录 */
export async function signOut() {
  await supabase.auth.signOut();
}

/** 重新发送验证邮件 */
export async function resendVerification(email) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: normalizeEmail(email)
  });
  if (error) throw error;
}

/** 发送密码重置邮件（回调到当前站点） */
export async function sendPasswordReset(email) {
  const redirectTo = `${location.origin}${location.pathname}`;
  const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo });
  if (error) throw error;
}

/** 登录状态下修改密码（用于重置回调后） */
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** 恢复会话（页面加载时调用一次） */
export async function restoreSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** 当前用户（可能为 null） */
export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}
