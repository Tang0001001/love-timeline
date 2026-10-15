// timeline.js —— 时光轴事件：加载、渲染、新增、编辑、删除、纪念日计算

import { supabase } from './supabase.js';
import {
  toast, openModal, confirmDialog, createPhotoPicker, showFormError, clearFormError
} from './editor.js';
import {
  photosOfEvent, uploadPhotos, removeStorageFiles, attachSignedImg,
  loadAllPhotos, allPhotos, escapeHtml, openLightbox
} from './photos.js';
import { state } from './space.js';

/** @type {Array} 事件列表（按 event_date 升序） */
export let events = [];

let revealObserver = null;

function ensureObserver() {
  if (revealObserver) return revealObserver;
  if (!('IntersectionObserver' in window)) return null;
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('revealed');
          revealObserver.unobserve(en.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
  );
  return revealObserver;
}

export function observeReveal(scope) {
  const ob = ensureObserver();
  if (!ob) {
    (scope || document).querySelectorAll('.reveal').forEach((el) => el.classList.add('revealed'));
    return;
  }
  (scope || document).querySelectorAll('.reveal:not(.revealed)').forEach((el) => ob.observe(el));
}

/* ================= 加载 ================= */

export async function loadEvents() {
  // event_date 为 date 类型按字面返回，不发生时区偏移
  const { data, error } = await supabase
    .from('timeline_events')
    .select('*')
    .order('event_date', { ascending: true })
    .order('event_time', { ascending: true, nullsFirst: true });
  if (error) throw error;
  events = data || [];
}

/* ================= 渲染 ================= */

export function renderTimeline() {
  const list = document.getElementById('timeline-list');
  const empty = document.getElementById('events-empty');
  const loading = document.getElementById('events-loading');

  loading.classList.add('hidden');
  document.getElementById('events-count').textContent = events.length ? `共 ${events.length} 个瞬间` : '';

  if (!events.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';

  for (const ev of events) {
    const li = document.createElement('li');
    li.className = 'timeline-item reveal';
    li.innerHTML = `
      <span class="timeline-dot" aria-hidden="true"></span>
      <article class="timeline-card">
        <header class="flex items-start justify-between gap-3">
          <div>
            <div class="event-date-chip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke-linecap="round"/></svg>
              ${formatEventDate(ev)}
            </div>
            <h4 class="mt-2.5 font-serif text-lg font-semibold leading-snug">${escapeHtml(ev.title)}</h4>
            ${ev.tag ? `<p class="event-tag mt-0.5"># ${escapeHtml(ev.tag)}</p>` : ''}
          </div>
          <div class="flex gap-1 shrink-0">
            <button type="button" class="icon-btn !w-8 !h-8" data-act="edit" title="编辑" aria-label="编辑事件">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
            <button type="button" class="icon-btn !w-8 !h-8" data-act="delete" title="删除" aria-label="删除事件">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </header>
        ${ev.description ? `<p class="mt-2.5 text-sm leading-7 text-ink/90 dark:text-[#EDE4EA]/90 whitespace-pre-wrap">${escapeHtml(ev.description)}</p>` : ''}
        <div class="event-photos" data-photos></div>
        <footer class="mt-3 pt-2.5 border-t border-sakura/70 dark:border-nightline/70 flex items-center justify-between text-[11px] text-muted dark:text-nightmuted">
          <span>${creatorName(ev)}</span>
          <span>记录于 ${new Date(ev.created_at).toLocaleDateString('zh-CN')}</span>
        </footer>
      </article>`;

    // 事件照片
    const grid = li.querySelector('[data-photos]');
    const phs = photosOfEvent(ev.id).filter((p) => !p._deleted);
    for (const ph of phs) {
      const img = document.createElement('img');
      img.alt = escapeHtml(ph.caption || ev.title);
      img.loading = 'lazy';
      attachSignedImg(img, ph.storage_path);
      img.addEventListener('click', () => {
        openLightbox(phs, phs.indexOf(ph));
      });
      grid.appendChild(img);
    }

    li.querySelector('[data-act="edit"]').addEventListener('click', () => openEventModal(ev));
    li.querySelector('[data-act="delete"]').addEventListener('click', () => deleteEventFlow(ev));
    list.appendChild(li);
  }
  observeReveal(list);
}

function formatEventDate(ev) {
  const d = ev.event_date; // 'YYYY-MM-DD' 字面值
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const cn = `${y} 年 ${m} 月 ${day} 日`;
  return ev.event_time ? `${cn} ${(ev.event_time || '').slice(0, 5)}` : cn;
}

function creatorName(ev) {
  const s = state.settings;
  if (!s) return '';
  const owner = state.members.find((m) => m.role === 'owner');
  if (owner && ev.created_by === owner.user_id) return `由 ${s.owner_nickname} 记录`;
  const partner = state.members.find((m) => m.role === 'partner');
  if (partner && ev.created_by === partner.user_id) return `由 ${s.partner_nickname} 记录`;
  return '';
}

/* ================= 事件弹窗（新增 / 编辑） ================= */

export function openEventModal(existing = null, onSaved) {
  const isEdit = Boolean(existing);
  openModal({
    title: isEdit ? '编辑回忆' : '记录一段回忆',
    wide: true,
    body: `
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="form-label">标题 *</label>
            <input name="title" type="text" maxlength="100" required class="form-input" value="${escapeAttr(existing?.title || '')}" placeholder="这一刻，我们…" />
          </div>
          <div>
            <label class="form-label">标签（可选）</label>
            <input name="tag" type="text" maxlength="20" class="form-input" value="${escapeAttr(existing?.tag || '')}" placeholder="例如：约会 / 旅行" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">日期 *</label>
            <input name="date" type="date" required class="form-input" value="${existing?.event_date || ''}" />
          </div>
          <div>
            <label class="form-label">时间（可选）</label>
            <input name="time" type="time" class="form-input" value="${(existing?.event_time || '').slice(0, 5)}" />
          </div>
        </div>
        <div>
          <label class="form-label">描述</label>
          <textarea name="description" rows="4" maxlength="2000" class="form-input !h-auto py-3 leading-7" placeholder="写下当时的心情…">${escapeHtml(existing?.description || '')}</textarea>
        </div>
        ${isEdit ? `
        <div>
          <label class="form-label">已有照片（点击可标记删除）</label>
          <div class="keep-grid" data-keep-grid></div>
        </div>` : ''}
        <div>
          <label class="form-label">${isEdit ? '追加新照片' : '照片（可选）'}</label>
          <div data-picker="new"></div>
        </div>
      </div>`,
    onSubmit: async (form, submitBtn) => {
      clearFormError(form);
      const f = new FormData(form);
      const title = f.get('title').trim();
      const date = f.get('date');
      const time = f.get('time') || null;
      if (!title) return showFormError(form, '请填写标题'), false;
      if (!date) return showFormError(form, '请选择日期'), false;

      const patch = {
        title,
        event_date: date,       // 字面日期，不经过时区换算
        event_time: time ? time + ':00' : null,
        description: f.get('description').trim(),
        tag: f.get('tag').trim() || null
      };

      let eventId = existing?.id;
      const newFiles = picker.getFiles();

      if (isEdit) {
        // 乐观锁：updated_at 条件更新，0 行命中 = 冲突
        const { data: updated, error } = await supabase
          .from('timeline_events')
          .update(patch)
          .eq('id', eventId)
          .eq('updated_at', existing.updated_at)
          .select()
          .single();
        if (error) throw error;
        if (!updated) {
          return showFormError(form, '保存冲突：TA 刚刚修改了这条回忆。请关闭后重新打开编辑。'), false;
        }
      } else {
        // 先建事件（含描述），再上传照片 —— 事件失败则不会有孤立文件
        const { data: created, error } = await supabase
          .from('timeline_events')
          .insert({ ...patch, space_id: state.space.id, created_by: state.user.id })
          .select()
          .single();
        if (error) throw error;
        eventId = created.id;
      }

      // 处理标记删除的旧照片
      if (isEdit) {
        const toDelete = keepRemoveSet;
        if (toDelete.size) {
          const paths = [];
          for (const pid of toDelete) {
            const ph = allPhotos.find((p) => p.id === pid);
            if (ph) paths.push(ph.storage_path);
          }
          const { error: delErr } = await supabase.from('gallery_photos').delete().in('id', [...toDelete]);
          if (delErr) toast('部分旧照片删除失败：' + delErr.message, 'error');
          else await removeStorageFiles(paths);
        }
      }

      // 上传新照片
      if (newFiles.length) {
        submitBtn.textContent = `上传照片中 0/${newFiles.length}…`;
        const { errors } = await uploadPhotos({
          files: newFiles,
          spaceId: state.space.id,
          eventId,
          onProgress: (i, n) => (submitBtn.textContent = `上传照片中 ${i}/${n}…`)
        });
        if (errors.length) {
          toast(errors[0] + (errors.length > 1 ? ` 等共 ${errors.length} 个问题` : ''), 'error', 4200);
        }
      }

      toast(isEdit ? '回忆已更新' : '回忆已记录', 'success');
      if (onSaved) await onSaved();
    }
  });

  // 新照片选择器
  const picker = createPhotoPicker({ multiple: true });
  document.querySelector('[data-picker="new"]').appendChild(picker.el);

  // 已有照片 + 标记删除集合
  const keepRemoveSet = new Set();
  const keepGrid = document.querySelector('[data-keep-grid]');
  if (keepGrid) {
    for (const ph of photosOfEvent(existing.id)) {
      const item = document.createElement('div');
      item.className = 'keep-item';
      item.innerHTML = `
        <img alt="${escapeHtml(ph.caption || existing.title)}" />
        <button type="button" class="keep-toggle" title="标记删除">✓</button>`;
      attachSignedImg(item.querySelector('img'), ph.storage_path);
      item.querySelector('.keep-toggle').addEventListener('click', () => {
        if (keepRemoveSet.has(ph.id)) {
          keepRemoveSet.delete(ph.id);
          item.classList.remove('marked-remove');
          item.querySelector('.keep-toggle').textContent = '✓';
        } else {
          keepRemoveSet.add(ph.id);
          item.classList.add('marked-remove');
          item.querySelector('.keep-toggle').textContent = '✕';
        }
      });
      keepGrid.appendChild(item);
    }
  }
}

/* ================= 删除事件 ================= */

export async function deleteEventFlow(ev) {
  const ok = await confirmDialog({
    title: '删除回忆',
    message: `确定要删除「${escapeHtml(ev.title)}」吗？关联的照片和记录将一并删除，无法恢复。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  // 1. 先记录关联照片的存储路径
  const phs = photosOfEvent(ev.id);
  const paths = phs.map((p) => p.storage_path);

  // 2. 删除事件（数据库级联删除照片记录）
  const { error } = await supabase.from('timeline_events').delete().eq('id', ev.id);
  if (error) {
    toast('删除失败：' + error.message, 'error');
    return;
  }

  // 3. 清理 Storage 文件（失败自动进入待清理队列，下次启动重试）
  await removeStorageFiles(paths);
  toast('回忆已删除', 'success');
}

/* ================= 纪念日 ================= */

export function renderAnniversaries() {
  const box = document.getElementById('anniversary-list');
  if (!state.space) return;
  const start = new Date(state.space.relationship_start);
  const today = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const t0 = startOfDay(start).getTime();
  const t1 = startOfDay(today).getTime();
  const daysTogether = Math.floor((t1 - t0) / 86400000);

  const cards = [];

  // 相恋总天数
  cards.push({
    days: daysTogether,
    label: '天，我们在一起'
  });

  // 下一个周年纪念日
  let anni = new Date(today.getFullYear(), start.getMonth(), start.getDate());
  if (startOfDay(anni).getTime() <= t1) anni = new Date(today.getFullYear() + 1, start.getMonth(), start.getDate());
  // 修正 2/29 等边缘：Date 会自动进位到 3/1，可接受
  cards.push({
    days: Math.round((startOfDay(anni).getTime() - t1) / 86400000),
    label: `天后是我们的 ${anni.getFullYear() - start.getFullYear()} 周年`
  });

  // 下一个整百天
  const next100 = (Math.floor(daysTogether / 100) + 1) * 100;
  cards.push({
    days: next100 - daysTogether,
    label: `天后是第 ${next100} 天`
  });

  box.innerHTML = cards.map((c) => `
    <div class="anni-card reveal">
      <div class="anni-days">${c.days}</div>
      <div class="anni-label">${c.label}</div>
    </div>`).join('');
  observeReveal(box);
}

/* ================= 刷新（数据变化后调用） ================= */

export async function refreshEvents() {
  await Promise.all([loadEvents(), loadAllPhotos()]);
  renderTimeline();
  renderAnniversaries();
}

function escapeAttr(s) {
  return escapeHtml(s ?? '');
}
