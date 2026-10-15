// space.js —— 情侣空间状态、加载、创建、设置、邀请、成员管理、寄语

import { supabase } from './supabase.js';
import { INVITE_TTL_HOURS, STORAGE_BUCKET, DEFAULT_MUSIC_URL } from './config.js';
import {
  toast, openModal, confirmDialog, createPhotoPicker, readableError, showFormError, clearFormError
} from './editor.js';
import { signedUrl, uploadSingleImage, escapeHtml, removeStorageFiles, listAllObjectPaths } from './photos.js';

/** 全局共享状态 */
export const state = {
  user: null,        // 当前登录用户
  space: null,       // couple_spaces 行
  settings: null,    // space_settings 行
  members: [],       // space_members 行
  myRole: null       // 'owner' | 'partner'
};

/* ================= 数据加载 ================= */

/** 当前用户加入的空间（每人最多一个；无则返回 null） */
export async function myMembership() {
  const { data, error } = await supabase
    .from('space_members')
    .select('space_id, role')
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

/** 加载空间全部数据（成员关系 -> 空间 -> 设置） */
export async function loadSpaceData() {
  const m = await myMembership();
  if (!m) return false;

  const [spaceRes, settingsRes, membersRes] = await Promise.all([
    supabase.from('couple_spaces').select('*').eq('id', m.space_id).maybeSingle(),
    supabase.from('space_settings').select('*').eq('space_id', m.space_id).maybeSingle(),
    supabase.from('space_members').select('*').eq('space_id', m.space_id)
  ]);
  if (spaceRes.error) throw spaceRes.error;
  if (settingsRes.error) throw settingsRes.error;
  if (membersRes.error) throw membersRes.error;

  state.space = spaceRes.data;
  state.settings = settingsRes.data;
  state.members = membersRes.data || [];
  state.myRole = m.role;
  return true;
}

/* ================= 创建 / 加入 ================= */

export async function createSpace({ name, startAt, ownerNick, partnerNick }) {
  const { data, error } = await supabase.rpc('create_couple_space', {
    p_name: name,
    p_relationship_start: new Date(startAt).toISOString(),
    p_owner_nickname: ownerNick,
    p_partner_nickname: partnerNick
  });
  if (error) throw error;
  return data;
}

export async function redeemInvitation(code) {
  const { data, error } = await supabase.rpc('redeem_invitation', { p_code: code.trim() });
  if (error) throw error;
  return data;
}

/* ================= 封面渲染 ================= */

export async function renderCover() {
  const { space, settings } = state;
  if (!space || !settings) return;

  document.getElementById('cover-title').textContent = settings.title || '我们的故事';
  document.getElementById('cover-subtitle').textContent = settings.subtitle || '';

  // 昵称 + 头像
  document.getElementById('nick-owner').textContent = settings.owner_nickname;
  document.getElementById('nick-partner').textContent = settings.partner_nickname;
  await renderAvatar('owner', settings.owner_avatar_path, settings.owner_nickname);
  await renderAvatar('partner', settings.partner_avatar_path, settings.partner_nickname);

  // 开始日期（按字面显示，不做时区换算）
  const start = new Date(space.relationship_start);
  document.getElementById('cover-since').textContent =
    `SINCE ${start.getFullYear()}.${String(start.getMonth() + 1).padStart(2, '0')}.${String(start.getDate()).padStart(2, '0')}`;

  // 封面背景
  const bg = document.getElementById('cover-bg');
  if (settings.cover_photo_path) {
    const url = await signedUrl(settings.cover_photo_path);
    if (url) {
      bg.style.backgroundImage = `url("${url}")`;
      bg.classList.add('loaded');
    }
  } else {
    bg.style.backgroundImage = '';
    bg.classList.remove('loaded');
  }

  // 邀请按钮：仅 owner 且还没有 partner 时显示
  const hasPartner = state.members.some((m) => m.role === 'partner');
  document.getElementById('btn-invite').classList.toggle(
    'hidden', !(state.myRole === 'owner' && !hasPartner)
  );
}

async function renderAvatar(which, path, fallbackNick) {
  const img = document.getElementById(`avatar-${which}`);
  const ph = document.getElementById(`avatar-${which}-ph`);
  if (path) {
    const url = await signedUrl(path);
    if (url) {
      img.src = url;
      img.classList.add('show');
      ph.textContent = '';
      ph.classList.add('hidden');
      return;
    }
  }
  img.classList.remove('show');
  ph.classList.remove('hidden');
  ph.textContent = (fallbackNick || '?').slice(0, 2);
}

/* ================= 编辑我们的故事（设置弹窗） ================= */

export function openSettingsModal(onSaved) {
  const { space, settings } = state;
  const startLocal = toLocalInputValue(space.relationship_start);

  openModal({
    title: '编辑我们的故事',
    wide: true,
    body: `
      <div class="space-y-4">
        <div>
          <label class="form-label">空间名称</label>
          <input name="name" type="text" maxlength="60" required class="form-input" value="${escapeAttr(space.name)}" />
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="form-label">页面标题</label>
            <input name="title" type="text" maxlength="40" class="form-input" value="${escapeAttr(settings.title)}" />
          </div>
          <div>
            <label class="form-label">恋爱开始时间</label>
            <input name="start" type="datetime-local" required class="form-input" value="${startLocal}" />
          </div>
        </div>
        <div>
          <label class="form-label">副标题</label>
          <input name="subtitle" type="text" maxlength="80" class="form-input" value="${escapeAttr(settings.subtitle)}" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">我的昵称</label>
            <input name="owner_nick" type="text" maxlength="20" class="form-input" value="${escapeAttr(settings.owner_nickname)}" />
          </div>
          <div>
            <label class="form-label">TA 的昵称</label>
            <input name="partner_nick" type="text" maxlength="20" class="form-input" value="${escapeAttr(settings.partner_nickname)}" />
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label class="form-label">我的头像</label>
            <div data-picker="owner_avatar"></div>
          </div>
          <div>
            <label class="form-label">TA 的头像</label>
            <div data-picker="partner_avatar"></div>
          </div>
          <div>
            <label class="form-label">封面照片</label>
            <div data-picker="cover"></div>
          </div>
        </div>
        <div>
          <label class="form-label">背景音乐链接（可选，mp3 直链）</label>
          <input name="music_url" type="url" class="form-input" placeholder="https://…/song.mp3" value="${escapeAttr(settings.music_url || '')}" />
        </div>
      </div>`,
    onSubmit: async (form) => {
      clearFormError(form);
      const f = new FormData(form);
      const name = f.get('name').trim();
      const startVal = f.get('start');
      if (!name) return showFormError(form, '请填写空间名称'), false;
      if (!startVal) return showFormError(form, '请选择恋爱开始时间'), false;
      if (new Date(startVal).getTime() > Date.now()) {
        return showFormError(form, '开始时间不能在未来'), false;
      }

      // 乐观并发保护：带 updated_at 条件更新，冲突时提示刷新
      const settingsPatch = {
        title: f.get('title').trim() || '我们的故事',
        subtitle: f.get('subtitle').trim(),
        owner_nickname: f.get('owner_nick').trim() || '我',
        partner_nickname: f.get('partner_nick').trim() || '亲爱的',
        music_url: f.get('music_url').trim() || null
      };
      const spacePatch = {
        name,
        relationship_start: new Date(startVal).toISOString()
      };

      // 上传新头像/封面
      for (const key of ['owner_avatar', 'partner_avatar', 'cover']) {
        const file = pickers[key].getFiles()[0];
        if (file) {
          try {
            settingsPatch[`${key}_path`] = await uploadSingleImage({
              file,
              spaceId: state.space.id,
              folder: 'settings',
              oldPath: key === 'cover'
                ? state.settings.cover_photo_path
                : state.settings[`${key}_path`]
            });
          } catch (err) {
            return showFormError(form, `图片上传失败：${err.message}`), false;
          }
        }
      }

      const [spaceRes, settingsRes] = await Promise.all([
        supabase.from('couple_spaces')
          .update(spacePatch)
          .eq('id', state.space.id)
          .eq('updated_at', state.space.updated_at)
          .select('id'),
        supabase.from('space_settings')
          .update(settingsPatch)
          .eq('space_id', state.space.id)
          .eq('updated_at', state.settings.updated_at)
          .select('space_id')
      ]);
      if (spaceRes.error) throw spaceRes.error;
      if (settingsRes.error) throw settingsRes.error;
      // updated_at 条件未命中 = 另一方刚保存过（乐观锁冲突）
      if (!settingsRes.data || settingsRes.data.length === 0) {
        return showFormError(form, '保存冲突：TA 刚刚也修改了你们的故事，页面即将刷新为最新内容'),
          setTimeout(() => location.reload(), 1800), false;
      }

      toast('我们的故事已更新', 'success');
      if (onSaved) await onSaved();
    }
  });

  // 挂载三个单图选择器
  const pickers = {};
  for (const key of ['owner_avatar', 'partner_avatar', 'cover']) {
    const p = createPhotoPicker({ multiple: false, label: '选择图片', note: '' });
    document.querySelector(`[data-picker="${key}"]`).appendChild(p.el);
    pickers[key] = p;
  }
}

function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ================= 邀请管理（仅 owner） ================= */

export function openInviteModal() {
  if (state.myRole !== 'owner') {
    toast('只有空间主人可以管理邀请', 'error');
    return;
  }
  renderInviteModal();
}

async function renderInviteModal() {
  const hasPartner = state.members.some((m) => m.role === 'partner');

  const { data: invites, error } = await supabase
    .from('invitations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    toast(readableError(error), 'error');
    return;
  }

  const active = (invites || []).filter((i) => !i.used_at && !i.revoked_at && new Date(i.expires_at) > new Date());

  const inviteList = active.length
    ? active.map((i) => `
        <div class="flex items-center justify-between gap-3 rounded-xl border border-sakura dark:border-nightline px-4 py-3">
          <div class="text-xs text-muted dark:text-nightmuted">
            ${new Date(i.expires_at).toLocaleString('zh-CN')} 过期
          </div>
          <button type="button" data-revoke="${i.id}" class="text-xs text-[#c05b6d] underline underline-offset-2">撤销</button>
        </div>`).join('')
    : '<p class="text-xs text-muted dark:text-nightmuted">暂无有效邀请</p>';

  openModal({
    title: '邀请另一半',
    body: `
      <div class="space-y-5">
        ${hasPartner ? `
        <p class="text-sm text-muted dark:text-nightmuted">TA 已经加入了你们的空间 💕</p>
        <div class="rounded-xl bg-sakura/60 dark:bg-nightline/50 px-4 py-3 text-sm flex items-center justify-between">
          <div>
            <p class="font-medium">${escapeHtml(state.settings.partner_nickname)}</p>
            <p class="text-xs text-muted dark:text-nightmuted mt-0.5">${joinTimeOfPartner()}</p>
          </div>
          <button type="button" data-act="remove-partner" class="text-xs text-[#c05b6d] underline underline-offset-2">移除 TA</button>
        </div>` : `
        <div>
          <p class="text-xs text-muted dark:text-nightmuted leading-relaxed mb-3">
            生成一次性邀请链接发给另一半。邀请码有效期 ${INVITE_TTL_HOURS} 小时，只能使用一次，可随时撤销。
          </p>
          <div id="invite-result" class="space-y-3"></div>
        </div>
        <div class="space-y-2">
          <p class="text-xs font-medium text-ink/80 dark:text-[#EDE4EA]/80">有效邀请</p>
          ${inviteList}
        </div>`}
        <div class="pt-4 border-t border-sakura dark:border-nightline">
          <button type="button" data-act="dissolve" class="text-xs text-[#c05b6d]/80 underline underline-offset-2">
            解散情侣空间（不可恢复）
          </button>
        </div>
      </div>`,
    hideFooter: true
  });

  // 事件绑定
  const root = document.getElementById('modal-root');
  const genBtn = root.querySelector('[data-act="generate"]');
  if (genBtn) genBtn.addEventListener('click', () => generateInviteFlow());

  root.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error: rErr } = await supabase.rpc('revoke_invitation', { p_invitation_id: btn.dataset.revoke });
      if (rErr) {
        toast(readableError(rErr), 'error');
        return;
      }
      toast('邀请已撤销', 'success');
      renderInviteModal();
    });
  });

  const rmBtn = root.querySelector('[data-act="remove-partner"]');
  if (rmBtn) rmBtn.addEventListener('click', removePartnerFlow);

  const dsBtn = root.querySelector('[data-act="dissolve"]');
  if (dsBtn) dsBtn.addEventListener('click', dissolveFlow);

  // 无 partner 且无有效邀请时，自动展示生成按钮
  if (!hasPartner && !active.length) generateInviteUI();
}

function joinTimeOfPartner() {
  const p = state.members.find((m) => m.role === 'partner');
  return p ? `加入于 ${new Date(p.joined_at).toLocaleDateString('zh-CN')}` : '';
}

function generateInviteUI(code) {
  const box = document.getElementById('invite-result');
  if (!box) return;
  if (!code) {
    box.innerHTML = `<button type="button" data-act="generate" class="btn-primary w-full !h-11">生成邀请链接</button>`;
    box.querySelector('[data-act="generate"]').addEventListener('click', () => generateInviteFlow());
    return;
  }
  const link = `${location.origin}${location.pathname}?invite=${code}`;
  box.innerHTML = `
    <p class="text-xs text-muted dark:text-nightmuted">把链接发给 TA，TA 注册 / 登录后会自动加入：</p>
    <div class="invite-code-box">${escapeHtml(code)}</div>
    <div class="flex gap-2">
      <button type="button" data-copy="link" class="btn-outline flex-1 !h-10">复制链接</button>
      <button type="button" data-copy="code" class="btn-outline flex-1 !h-10">复制邀请码</button>
    </div>
    <p class="text-[11px] text-muted dark:text-nightmuted">安全说明：邀请码仅显示这一次，服务器只保存其哈希。</p>`;
  box.querySelector('[data-copy="link"]').addEventListener('click', () => copyText(link, '链接'));
  box.querySelector('[data-copy="code"]').addEventListener('click', () => copyText(code, '邀请码'));
}

async function generateInviteFlow() {
  try {
    const { data: code, error } = await supabase.rpc('create_invitation', { p_ttl_hours: INVITE_TTL_HOURS });
    if (error) throw error;
    generateInviteUI(code);
    toast('邀请已生成', 'success');
    // 刷新列表部分（保持生成的 code 展示）
  } catch (err) {
    toast(readableError(err), 'error');
  }
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`, 'success');
  } catch (_) {
    // 兼容不支持 clipboard API 的环境
    openModal({
      title: `复制${label}`,
      body: `<textarea class="form-input h-24 font-mono text-xs" readonly>${escapeHtml(text)}</textarea>`,
      hideFooter: true
    });
  }
}

async function removePartnerFlow() {
  const ok = await confirmDialog({
    title: '移除另一半',
    message: '移除后，TA 将立即失去这个空间的全部访问权限，且需要你重新邀请才能加入。确定要移除吗？',
    confirmText: '确定移除',
    danger: true
  });
  if (!ok) return;
  const { error } = await supabase.rpc('remove_partner', { p_space_id: state.space.id });
  if (error) {
    toast(readableError(error), 'error');
    return;
  }
  toast('已移除', 'success');
}

async function dissolveFlow() {
  const ok1 = await confirmDialog({
    title: '解散情侣空间',
    message: '解散将删除这个空间的全部时间轴事件、照片记录、设置与寄语（云端照片文件也将被清理）。此操作不可恢复！',
    confirmText: '我要解散',
    danger: true
  });
  if (!ok1) return;
  const ok2 = await confirmDialog({
    title: '再次确认',
    message: '真的要永久删除你们的所有回忆吗？建议先各自保存重要照片。',
    confirmText: '永久删除',
    danger: true
  });
  if (!ok2) return;

  try {
    // 先清理 Storage 文件（删除空间行后成员校验会失效，无法再删文件）
    const paths = await listAllObjectPaths(state.space.id);
    if (paths.length) {
      await removeStorageFiles(paths);
    }
    const { error } = await supabase.from('couple_spaces').delete().eq('id', state.space.id);
    if (error) throw error;
    toast('空间已解散', 'notice');
    location.href = location.pathname; // 回到初始状态重新路由
  } catch (err) {
    toast('解散失败：' + readableError(err), 'error');
  }
}

/* ================= 寄语 ================= */

export function renderLetter() {
  const s = state.settings;
  if (!s) return;
  document.getElementById('letter-title').textContent = s.letter_title || '写给未来';
  document.getElementById('letter-body').textContent = s.letter_body || '';
  document.getElementById('letter-signature').textContent = s.letter_signature || '';
  document.getElementById('letter-date').textContent = s.letter_date
    ? `— ${s.letter_date} —`
    : '';

  const bg = document.getElementById('letter-bg');
  if (s.letter_background_path) {
    signedUrl(s.letter_background_path).then((url) => {
      if (url) {
        bg.style.backgroundImage = `url("${url}")`;
        bg.classList.add('loaded');
      }
    });
  } else {
    bg.style.backgroundImage = '';
    bg.classList.remove('loaded');
  }
}

export function openLetterModal(onSaved) {
  const s = state.settings;
  openModal({
    title: '编辑寄语',
    wide: true,
    body: `
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="form-label">寄语标题</label>
            <input name="letter_title" type="text" maxlength="40" class="form-input" value="${escapeAttr(s.letter_title)}" />
          </div>
          <div>
            <label class="form-label">纪念日期（可选）</label>
            <input name="letter_date" type="date" class="form-input" value="${s.letter_date || ''}" />
          </div>
        </div>
        <div>
          <label class="form-label">正文</label>
          <textarea name="letter_body" rows="6" maxlength="1000" class="form-input !h-auto py-3 leading-7">${escapeHtml(s.letter_body)}</textarea>
        </div>
        <div>
          <label class="form-label">落款</label>
          <input name="letter_signature" type="text" maxlength="30" class="form-input" value="${escapeAttr(s.letter_signature)}" />
        </div>
        <div>
          <label class="form-label">背景照片（可选）</label>
          <div data-picker="letter_bg"></div>
        </div>
      </div>`,
    onSubmit: async (form) => {
      clearFormError(form);
      const f = new FormData(form);
      const patch = {
        letter_title: f.get('letter_title').trim() || '写给未来',
        letter_body: f.get('letter_body').trim(),
        letter_signature: f.get('letter_signature').trim(),
        letter_date: f.get('letter_date') || null
      };
      const file = letterBgPicker.getFiles()[0];
      if (file) {
        try {
          patch.letter_background_path = await uploadSingleImage({
            file,
            spaceId: state.space.id,
            folder: 'settings',
            oldPath: state.settings.letter_background_path
          });
        } catch (err) {
          return showFormError(form, `背景照片上传失败：${err.message}`), false;
        }
      }
      const { error } = await supabase
        .from('space_settings')
        .update(patch)
        .eq('space_id', state.space.id)
        .eq('updated_at', state.settings.updated_at);
      if (error) {
        if (error.code === '42501') {
          return showFormError(form, '保存冲突：TA 刚刚也修改了寄语，页面将刷新为最新内容'), setTimeout(() => location.reload(), 1800), false;
        }
        throw error;
      }
      toast('寄语已保存', 'success');
      if (onSaved) await onSaved();
    }
  });

  const letterBgPicker = createPhotoPicker({ multiple: false, label: '选择背景图', note: '' });
  document.querySelector('[data-picker="letter_bg"]').appendChild(letterBgPicker.el);
}

/* ================= 便捷 ================= */

export function musicUrl() {
  return (state.settings && state.settings.music_url) || DEFAULT_MUSIC_URL || '';
}

function escapeAttr(s) {
  return escapeHtml(s ?? '');
}
