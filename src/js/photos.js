// photos.js —— 照片校验、压缩、上传、签名 URL、照片墙、大图预览、存储清理

import { supabase } from './supabase.js';
import {
  STORAGE_BUCKET, SIGNED_URL_TTL, SIGNED_URL_REFRESH_AHEAD,
  COMPRESS_MAX_EDGE, COMPRESS_QUALITY, LS_KEYS
} from './config.js';
import { toast, validateImageFile, confirmDialog, openModal, showFormError } from './editor.js';

/** 全部照片元数据（时间轴事件照片 + 照片墙照片） */
export let allPhotos = [];

/** 签名 URL 缓存：path -> { url, expiresAt } */
const urlCache = new Map();

/* ================= 签名 URL ================= */

export async function signedUrl(path) {
  if (!path) return '';
  const hit = urlCache.get(path);
  if (hit && hit.expiresAt > Date.now() + SIGNED_URL_REFRESH_AHEAD * 1000) {
    return hit.url;
  }
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error || !data) {
    console.error('签名 URL 失败', path, error);
    return '';
  }
  urlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_URL_TTL * 1000 });
  return data.signedUrl;
}

function invalidateUrl(path) {
  urlCache.delete(path);
}

/** 为 <img> 异步挂载签名 URL，失败显示占位 */
export async function attachSignedImg(imgEl, path) {
  const url = await signedUrl(path);
  if (!url) {
    imgEl.src = placeholderDataUri();
    return;
  }
  imgEl.src = url;
  imgEl.addEventListener('error', () => {
    imgEl.src = placeholderDataUri();
  }, { once: true });
}

function placeholderDataUri() {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#F8E8EC"/><text x="100" y="105" text-anchor="middle" font-size="13" fill="#A96879">图片走丢了</text></svg>`
  );
}

/* ================= 压缩 ================= */

/** Canvas 压缩：最长边 2000px、JPEG 0.86 质量（保持足够视觉质量） */
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    // 先确认图片可解码
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1 && file.size <= 2 * 1024 * 1024) {
          // 尺寸与体积都合适，直接上传原文件
          URL.revokeObjectURL(url);
          resolve(file);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (blob && blob.size > 0) resolve(blob);
            else reject(new Error('图片压缩失败'));
          },
          'image/jpeg',
          COMPRESS_QUALITY
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(new Error('图片无法处理'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法解码，可能已损坏'));
    };
    img.src = url;
  });
}

/* ================= 上传 ================= */

/**
 * 上传一批照片到 Storage 并写入 gallery_photos。
 * 补偿逻辑：Storage 上传成功但数据库插入失败时，立即删除已上传对象，
 * 避免留下孤立文件。
 *
 * @returns {{ inserted: number, errors: string[] }}
 */
export async function uploadPhotos({ files, spaceId, eventId = null, caption = '', onProgress }) {
  const errors = [];
  let inserted = 0;
  const folder = eventId || 'wall';
  let order = maxSortOrder(spaceId, eventId);
  const { data: { user } } = await supabase.auth.getUser();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const v = validateImageFile(file);
    if (!v.ok) {
      errors.push(`${file.name || '第 ' + (i + 1) + ' 张'}：${v.reason}`);
      continue;
    }
    if (onProgress) onProgress(i, files.length);
    try {
      const blob = await compressImage(file);
      const ext = extOf(blob.type || file.type);
      const path = `${spaceId}/${folder}/${crypto.randomUUID()}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, blob, { contentType: blob.type || file.type, upsert: false });
      if (upErr) throw upErr;

      const { error: dbErr, data } = await supabase
        .from('gallery_photos')
        .insert({
          space_id: spaceId,
          event_id: eventId,
          storage_path: path,
          caption: caption || '',
          sort_order: ++order,
          uploaded_by: user?.id || null
        })
        .select('id')
        .single();

      if (dbErr) {
        // 补偿：删除刚上传的文件
        await supabase.storage.from(STORAGE_BUCKET).remove([path]);
        throw dbErr;
      }
      inserted++;
    } catch (err) {
      console.error('照片上传失败', err);
      errors.push(`「${file.name || '第 ' + (i + 1) + ' 张'}」上传失败：${err.message || '网络异常'}`);
    }
  }
  if (onProgress) onProgress(files.length, files.length);
  return { inserted, errors };
}

function extOf(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function maxSortOrder(spaceId, eventId) {
  const list = allPhotos.filter((p) =>
    p.space_id === spaceId && (eventId ? p.event_id === eventId : p.event_id === null)
  );
  return list.reduce((m, p) => Math.max(m, p.sort_order || 0), 0);
}

/* ================= 单图工具（头像 / 封面 / 寄语背景） ================= */

/** 上传单张图片，返回 storage_path；oldPath 会被删除 */
export async function uploadSingleImage({ file, spaceId, folder = 'settings', oldPath = null }) {
  const v = validateImageFile(file);
  if (!v.ok) throw new Error(v.reason);
  const blob = await compressImage(file);
  const path = `${spaceId}/${folder}/${crypto.randomUUID()}.${extOf(blob.type || file.type)}`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, blob, { contentType: blob.type || file.type });
  if (error) throw error;
  if (oldPath) queueStorageDeletes([oldPath]); // 旧图延迟清理（确认新图写入成功后执行）
  return path;
}

/* ================= 数据加载 ================= */

export async function loadAllPhotos() {
  const { data, error } = await supabase
    .from('gallery_photos')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  allPhotos = data || [];
  return allPhotos;
}

export function photosOfEvent(eventId) {
  return allPhotos.filter((p) => p.event_id === eventId);
}

export function wallPhotos(spaceId) {
  return allPhotos.filter((p) => p.event_id === null && p.space_id === spaceId);
}

/* ================= 照片墙渲染 ================= */

let wallManageMode = false;

export function toggleWallManage(on) {
  wallManageMode = on === undefined ? !wallManageMode : on;
  document.getElementById('wall-actions').classList.toggle('hidden', !wallManageMode);
  renderWall();
}

export function isWallManageMode() {
  return wallManageMode;
}

export async function renderWall(spaceId) {
  const grid = document.getElementById('wall-grid');
  const empty = document.getElementById('wall-empty');
  const photos = wallPhotos(spaceId).filter((p) => !p._deleted);
  if (!photos.length) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';

  for (const ph of photos) {
    const item = document.createElement('div');
    item.className = 'wall-item reveal';
    item.innerHTML = `
      <img alt="${escapeHtml(ph.caption || '回忆照片')}" loading="lazy" />
      ${ph.caption ? `<div class="wall-caption">${escapeHtml(ph.caption)}</div>` : ''}
      ${wallManageMode ? `
      <div class="wall-manage">
        <button type="button" data-act="caption" title="编辑说明">✎</button>
        <button type="button" data-act="replace" title="替换">⟳</button>
        <button type="button" data-act="delete" title="删除">✕</button>
      </div>` : ''}
    `;
    const img = item.querySelector('img');
    attachSignedImg(img, ph.storage_path);

    img.addEventListener('click', () => {
      if (!wallManageMode) openLightbox(photos, photos.indexOf(ph));
    });
    if (wallManageMode) {
      item.querySelector('[data-act="delete"]').addEventListener('click', () => deletePhotoFlow(ph));
      item.querySelector('[data-act="caption"]').addEventListener('click', () => editCaptionFlow(ph));
      item.querySelector('[data-act="replace"]').addEventListener('click', () => replacePhotoFlow(ph));
    }
    grid.appendChild(item);
  }
}

/* ================= 照片操作 ================= */

export async function deletePhotoFlow(photo) {
  const ok = await confirmDialog({
    title: '删除照片',
    message: '删除后无法恢复，确定要删除这张照片吗？',
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  const { error } = await supabase.from('gallery_photos').delete().eq('id', photo.id);
  if (error) {
    toast('删除失败：' + error.message, 'error');
    return;
  }
  // 数据库删除成功后清理 Storage 文件（失败则进入待清理队列）
  await removeStorageFiles([photo.storage_path]);
  invalidateUrl(photo.storage_path);
  toast('照片已删除', 'success');
}

export function editCaptionFlow(photo) {
  openModal({
    title: '照片说明',
    body: `
      <div class="space-y-3">
        <div>
          <label class="form-label">说明文字</label>
          <input name="caption" type="text" maxlength="60" class="form-input" value="${escapeAttr(photo.caption || '')}" placeholder="写下这一刻的故事…" />
        </div>
      </div>`,
    submitText: '保存',
    onSubmit: async (form) => {
      const caption = form.caption.value.trim();
      const { error } = await supabase
        .from('gallery_photos')
        .update({ caption })
        .eq('id', photo.id);
      if (error) throw error;
      photo.caption = caption;
      renderWall(photo.space_id);
      toast('已保存', 'success');
    }
  });
}

export function replacePhotoFlow(photo) {
  const picker = createHiddenPicker(false);
  picker.pick(async (file) => {
    try {
      toast('正在替换照片…', 'info', 1200);
      const newPath = await uploadSingleImage({
        file,
        spaceId: photo.space_id,
        folder: photo.event_id || 'wall',
        oldPath: photo.storage_path
      });
      const { error } = await supabase
        .from('gallery_photos')
        .update({ storage_path: newPath, uploaded_by: (await supabase.auth.getUser()).data.user?.id || null })
        .eq('id', photo.id);
      if (error) throw error;
      invalidateUrl(photo.storage_path);
      await flushPendingDeletes();
      photo.storage_path = newPath;
      renderWall(photo.space_id);
      toast('照片已替换', 'success');
    } catch (err) {
      toast('替换失败：' + (err.message || '网络异常'), 'error');
    }
  });
}

/** 单文件快速选择器（不渲染预览网格） */
function createHiddenPicker(multiple) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.multiple = multiple;
  return {
    pick(cb) {
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (f) cb(f);
      };
      input.click();
    }
  };
}

/* ================= 大图预览 ================= */

let lbPhotos = [];
let lbIndex = 0;

export function openLightbox(photos, index = 0) {
  lbPhotos = photos;
  lbIndex = index;
  const lb = document.getElementById('lightbox');
  lb.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderLightbox();
}

function renderLightbox() {
  const stage = document.getElementById('lightbox-stage');
  const ph = lbPhotos[lbIndex];
  if (!ph) return;
  stage.innerHTML = `
    <img alt="${escapeHtml(ph.caption || '回忆照片')}" />
    <p id="lightbox-caption">${escapeHtml(ph.caption || '')}</p>`;
  attachSignedImg(stage.querySelector('img'), ph.storage_path);
  const multi = lbPhotos.length > 1;
  document.getElementById('lightbox-prev').style.display = multi ? '' : 'none';
  document.getElementById('lightbox-next').style.display = multi ? '' : 'none';
}

export function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
}

export function initLightbox() {
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.getElementById('lightbox-prev').addEventListener('click', () => {
    lbIndex = (lbIndex - 1 + lbPhotos.length) % lbPhotos.length;
    renderLightbox();
  });
  document.getElementById('lightbox-next').addEventListener('click', () => {
    lbIndex = (lbIndex + 1) % lbPhotos.length;
    renderLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') document.getElementById('lightbox-prev').click();
    if (e.key === 'ArrowRight') document.getElementById('lightbox-next').click();
  });
}

/* ================= Storage 文件清理（可靠补偿） ================= */

/**
 * 删除 Storage 文件；失败时写入 localStorage 待清理队列，下次启动重试。
 */
export async function removeStorageFiles(paths) {
  if (!paths || !paths.length) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
  if (error) {
    queueStorageDeletes(paths);
    console.warn('Storage 删除失败，已加入待清理队列', error);
  } else {
    paths.forEach(invalidateUrl);
  }
}

export function queueStorageDeletes(paths) {
  try {
    const cur = JSON.parse(localStorage.getItem(LS_KEYS.pendingStorageDeletes) || '[]');
    localStorage.setItem(LS_KEYS.pendingStorageDeletes, JSON.stringify([...cur, ...paths]));
  } catch (_) { /* 忽略 */ }
}

/** 递归列出某个前缀下的全部文件路径（Storage 的 list 不递归） */
export async function listAllObjectPaths(prefix) {
  const out = [];
  async function walk(p) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(p, { limit: 1000 });
    if (error || !data) return;
    for (const item of data) {
      const full = p ? `${p}/${item.name}` : item.name;
      // 目录条目 id 为空且 name 无扩展名的视为目录（Supabase 返回 metadata 判断）
      if (item.id === null && !/\.[a-z0-9]+$/i.test(item.name)) {
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk(prefix);
  return out;
}

/** 启动时重试之前失败的清理 */
export async function flushPendingDeletes() {
  let paths;
  try {
    paths = JSON.parse(localStorage.getItem(LS_KEYS.pendingStorageDeletes) || '[]');
  } catch (_) {
    paths = [];
  }
  if (!paths.length) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
  if (!error) {
    localStorage.removeItem(LS_KEYS.pendingStorageDeletes);
    console.log(`已清理 ${paths.length} 个遗留文件`);
  }
}

/* ================= HTML 转义 ================= */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/* 复用 editor 的导出（统一 API） */
export { showFormError };
