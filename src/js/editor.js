// editor.js —— 弹窗框架、表单构建器、照片选择器、Toast、加载态
// 不直接访问业务数据，业务逻辑通过回调注入。

import { MAX_BATCH, MAX_FILE_SIZE, ACCEPTED_MIME } from './config.js';

/* ---------------- Toast ---------------- */

export function toast(message, type = 'info', ms = 2600) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .4s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 420);
  }, ms);
}

/* ---------------- 按钮提交态 ---------------- */

export function setSubmitting(btn, submitting, text = '保存中…') {
  if (!btn) return;
  if (submitting) {
    btn.dataset.origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
  }
}

/* ---------------- 模态框 ---------------- */

let onModalEsc = null;

export function closeModal() {
  const root = document.getElementById('modal-root');
  const mask = root.firstElementChild;
  if (mask) {
    mask.classList.remove('open');
    setTimeout(() => (root.innerHTML = ''), 260);
  }
  if (onModalEsc) {
    document.removeEventListener('keydown', onModalEsc);
    onModalEsc = null;
  }
}

/**
 * 打开模态框
 * @param {object} opts
 *  - title: 标题
 *  - body: HTML 字符串或 DOM 元素
 *  - submitText / cancelText: 按钮文字（传 null 隐藏整个底部）
 *  - onSubmit: async (formEl, btn) => boolean|void  返回 false 时保持弹窗打开
 *  - wide: 宽弹窗
 *  - hideFooter: 不显示底部按钮
 */
export function openModal({ title, body, submitText = '保存', cancelText = '取消', onSubmit, wide = false, hideFooter = false, danger = false }) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal-panel ${wide ? 'sm:max-w-2xl' : ''}" role="dialog" aria-modal="true" aria-label="${title || ''}">
      <div class="modal-head">
        <h3 class="modal-title">${title || ''}</h3>
        <button type="button" class="modal-close" aria-label="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <form class="modal-body" novalidate></form>
      ${hideFooter ? '' : `
      <div class="modal-foot">
        <button type="button" class="btn-outline flex-1" data-act="cancel">${cancelText}</button>
        <button type="submit" form="modal-form-btn" class="${danger ? 'btn-danger' : 'btn-primary'} flex-1" data-act="submit">${submitText}</button>
      </div>`}
    </div>`;

  const form = mask.querySelector('form');
  if (typeof body === 'string') form.innerHTML = body;
  else form.appendChild(body);

  // 底部提交按钮通过 form attribute 绑定到表单
  const submitBtn = mask.querySelector('[data-act="submit"]');
  if (submitBtn) submitBtn.setAttribute('form', form.id || '');
  if (!form.id) {
    form.id = 'modal-form-' + Date.now();
    if (submitBtn) submitBtn.setAttribute('form', form.id);
  }

  root.innerHTML = '';
  root.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  const doClose = () => closeModal();
  mask.querySelector('.modal-close').addEventListener('click', doClose);
  const cancelBtn = mask.querySelector('[data-act="cancel"]');
  if (cancelBtn) cancelBtn.addEventListener('click', doClose);

  // 点击遮罩关闭（不响应面板内点击）
  mask.addEventListener('click', (e) => {
    if (e.target === mask) doClose();
  });

  onModalEsc = (e) => {
    if (e.key === 'Escape') doClose();
  };
  document.addEventListener('keydown', onModalEsc);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return doClose();
    setSubmitting(submitBtn, true);
    let keepOpen = false;
    try {
      const r = await onSubmit(form, submitBtn);
      keepOpen = r === false;
    } catch (err) {
      console.error(err);
      toast(readableError(err), 'error', 3600);
      keepOpen = true;
    }
    setSubmitting(submitBtn, false);
    if (!keepOpen) doClose();
  });

  return { form, mask, close: doClose };
}

/** 二次确认弹窗，返回 Promise<boolean> */
export function confirmDialog({ title = '确认操作', message, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openModal({
      title,
      body: `<p class="text-sm leading-relaxed text-ink dark:text-[#EDE4EA]">${message}</p>`,
      submitText: confirmText,
      cancelText: '再想想',
      danger,
      onSubmit: () => {
        settle(true);
      }
    });
    // 取消路径：遮罩 / 关闭按钮 / 取消按钮 / Escape
    const maskEl = document.getElementById('modal-root').firstElementChild;
    maskEl.addEventListener('click', (e) => {
      if (e.target === maskEl || e.target.closest('.modal-close') || e.target.closest('[data-act="cancel"]')) {
        setTimeout(() => settle(false), 0);
      }
    });
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onEsc);
        setTimeout(() => settle(false), 0);
      }
    };
    document.addEventListener('keydown', onEsc);
  });
}

/* ---------------- 通用表单片段 ---------------- */

export function field(labelText, inputHTML) {
  return `<div><label class="form-label">${labelText}</label>${inputHTML}</div>`;
}

export function showFormError(form, message) {
  let p = form.querySelector('.form-error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'form-error';
    form.prepend(p);
  }
  p.textContent = message;
  p.classList.remove('hidden');
}

export function clearFormError(form) {
  const p = form.querySelector('.form-error');
  if (p) p.classList.add('hidden');
}

/* ---------------- 照片选择器（待上传） ---------------- */

/**
 * 初始化一个照片选择区块
 * @returns {{el: HTMLElement, getFiles: () => File[]}}
 */
export function createPhotoPicker({ multiple = true, label = '添加照片', note = '支持 JPEG / PNG / WebP，单张 ≤ 10MB' } = {}) {
  const el = document.createElement('div');
  el.className = 'mt-1';
  el.innerHTML = `
    <div class="text-xs text-muted dark:text-nightmuted">${note}${multiple ? `，一次最多 ${MAX_BATCH} 张` : ''}</div>
    <div class="pick-grid" data-pick-grid>
      <label class="pick-add cursor-pointer">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>
        <span>${label}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" ${multiple ? 'multiple' : ''} class="hidden" />
      </label>
    </div>
    <p class="form-error hidden mt-2" data-pick-error></p>`;

  const grid = el.querySelector('[data-pick-grid]');
  const addBtn = el.querySelector('.pick-add');
  const input = el.querySelector('input[type="file"]');
  const errEl = el.querySelector('[data-pick-error]');
  /** @type {Array<{file: File, itemEl: HTMLElement, previewUrl: string}>} */
  const picked = [];

  input.addEventListener('change', () => {
    errEl.classList.add('hidden');
    const files = Array.from(input.files || []);
    input.value = '';
    for (const f of files) {
      if (picked.length >= MAX_BATCH) {
        errEl.textContent = `一次最多选择 ${MAX_BATCH} 张`;
        errEl.classList.remove('hidden');
        break;
      }
      const v = validateImageFile(f);
      if (!v.ok) {
        errEl.textContent = `"${f.name}" ${v.reason}`;
        errEl.classList.remove('hidden');
        continue;
      }
      addItem(f);
    }
  });

  function addItem(file) {
    const itemEl = document.createElement('div');
    itemEl.className = 'pick-item';
    const previewUrl = URL.createObjectURL(file);
    itemEl.innerHTML = `
      <img src="${previewUrl}" alt="待上传预览" />
      <button type="button" class="pick-remove" aria-label="移除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>`;
    grid.insertBefore(itemEl, addBtn);
    itemEl.querySelector('.pick-remove').addEventListener('click', () => {
      URL.revokeObjectURL(previewUrl);
      itemEl.remove();
      const i = picked.findIndex((p) => p.itemEl === itemEl);
      if (i >= 0) picked.splice(i, 1);
    });
    picked.push({ file, itemEl, previewUrl });
  }

  return {
    el,
    getFiles: () => picked.map((p) => p.file),
    /** 标记某张正在上传 */
    markUploading(itemIndex, text) {
      const badge = document.createElement('div');
      badge.className = 'pick-uploading';
      badge.textContent = text;
      picked[itemIndex].itemEl.appendChild(badge);
    }
  };
}

/** 文件校验：类型 + 大小 */
export function validateImageFile(file) {
  if (!ACCEPTED_MIME.includes(file.type)) {
    return { ok: false, reason: '不是支持的图片格式（JPEG / PNG / WebP）' };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, reason: '超过 10MB 大小限制' };
  }
  return { ok: true };
}

/* ---------------- Supabase 错误转可读文案 ---------------- */

export function readableError(err) {
  const msg = (err && (err.message || err.error_description || err.msg)) || '';
  const map = [
    [/invalid login credentials/i, '邮箱或密码不正确'],
    [/user already registered|already been registered/i, '该邮箱已注册，请直接登录'],
    [/password should be at least/i, '密码至少 6 位'],
    [/email not confirmed/i, '邮箱还未验证，请先查收验证邮件'],
    [/email rate limit/i, 'Supabase 验证邮件发送超限（免费套餐约每小时 4 封）。解法：到 Supabase → Authentication → Users 手动点 Confirm，或关闭邮箱验证（见下一条提示），或 1 小时后再试'],
    [/rate limit|too many|over_email_send_rate/i, '操作太频繁（Supabase 认证限流，约 1 小时后重置）。本地测试建议到 Supabase → Authentication → Sign In / Providers 关闭 Confirm email，即可免验证直接注册登录'],
    [/signup requires a valid password/i, '请输入有效的密码'],
    [/同一用户|已经加入/i, msg],
    [/邀请码/i, msg]
  ];
  for (const [re, text] of map) {
    if (re.test(msg)) return text || '操作失败';
  }
  if (msg) return msg;
  return '网络异常，请稍后重试';
}
