// main.js —— 应用入口：路由、认证视图、计时器、深色模式、音乐、动效、邀请兑换

import '../css/style.css';

import { supabase } from './supabase.js';
import { LS_KEYS, isConfigured, showConfigError } from './config.js';
import {
  signInWithEmail, signUpWithEmail, signOut, resendVerification,
  sendPasswordReset, updatePassword, normalizeEmail, isEmailFormatValid
} from './auth.js';
import {
  state, loadSpaceData, renderCover, renderLetter, openSettingsModal,
  openInviteModal, openLetterModal, createSpace, redeemInvitation, musicUrl
} from './space.js';
import {
  loadEvents, renderTimeline, renderAnniversaries, openEventModal,
  refreshEvents, observeReveal
} from './timeline.js';
import {
  loadAllPhotos, renderWall, initLightbox, uploadPhotos, flushPendingDeletes,
  toggleWallManage
} from './photos.js';
import { openModal, toast, showFormError, clearFormError, readableError, createPhotoPicker } from './editor.js';
import { startSync, stopSync, initNetworkStatus } from './sync.js';

/* ================= 视图路由 ================= */

const VIEWS = ['auth', 'setup', 'app'];

function showView(name) {
  VIEWS.forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (!el) return;
    const isTarget = v === name;
    el.classList.toggle('hidden', !isTarget);
    el.style.display = isTarget ? 'block' : 'none';
  });
  window.scrollTo(0, 0);
}

/** 主路由：根据登录状态与空间归属切换视图 */
async function route() {
  console.log('[route] 开始路由...');
  const { data } = await supabase.auth.getSession();
  console.log('[route] 会话状态:', data.session ? '已登录' : '未登录');

  if (!data.session) {
    state.user = null;
    state.space = null;
    stopSync();
    stopTimer();
    console.log('[route] 显示登录页');
    showView('auth');
    return;
  }
  state.user = data.session.user;
  console.log('[route] 用户:', state.user.email);

  // 尝试兑换 URL / 本地暂存的邀请码
  await tryRedeemPendingInvite();

  try {
    console.log('[route] 正在加载空间数据...');
    const has = await loadSpaceData();
    console.log('[route] 空间数据:', has ? '有空间' : '无空间');
    if (!has) {
      stopSync();
      stopTimer();
      const emailEl = document.getElementById('setup-user-email');
      if (emailEl) emailEl.textContent = `当前账号：${state.user.email || ''}`;
      console.log('[route] 显示创建空间页');
      showView('setup');
      return;
    }
    console.log('[route] 正在初始化应用视图...');
    await initAppView();
    console.log('[route] 显示应用主页');
    showView('app');
  } catch (err) {
    console.error('[route] 错误:', err);
    toast('数据加载失败：' + readableError(err), 'error', 4000);
    // 降级到登录页（而非设置页），确保用户总能看到可用界面
    showView('auth');
  }
}

async function initAppView() {
  console.log('[initApp] 开始初始化应用视图...');
  // 重试之前失败的存储清理
  flushPendingDeletes().catch(() => {});

  try {
    console.log('[initApp] 加载事件和照片...');
    await Promise.all([loadEvents(), loadAllPhotos()]);
    console.log('[initApp] 渲染封面...');
    await renderCover();
    console.log('[initApp] 渲染时光轴...');
    renderTimeline();
    console.log('[initApp] 渲染纪念日...');
    renderAnniversaries();
    console.log('[initApp] 渲染寄语...');
    renderLetter();
    console.log('[initApp] 渲染照片墙...');
    renderWall(state.space.id);
    console.log('[initApp] 启动计时器...');
    startTimer();
    console.log('[initApp] 初始化滚动动画...');
    observeReveal(document);
    console.log('[initApp] ✅ 所有渲染完成');
  } catch (err) {
    console.error('[initApp] ❌ 渲染错误:', err);
    throw err; // 继续抛出，让 route() 的 catch 处理
  }

  // 实时同步：另一方修改后自动刷新（处理函数只读不写，不会循环触发）
  startSync(state.space.id, {
    events: async () => { await refreshEvents(); },
    photos: async () => {
      await loadAllPhotos();
      renderWall(state.space.id);
      renderTimeline();
    },
    settings: async () => {
      await loadSpaceData();
      await renderCover();
      renderLetter();
      renderAnniversaries();
      startTimer();
    },
    members: async () => {
      const stillMember = await loadSpaceData();
      if (!stillMember) {
        toast('你已被移出情侣空间', 'notice', 4000);
        route();
        return;
      }
      await renderCover();
    }
  });
}

/* ================= 邀请码：捕获与兑换 ================= */

function captureInviteFromUrl() {
  const code = new URLSearchParams(location.search).get('invite');
  if (code && /^[0-9a-f]{32}$/i.test(code.trim())) {
    localStorage.setItem(LS_KEYS.pendingInvite, code.trim());
    // 清理 URL，避免刷新时重复提示
    history.replaceState(null, '', location.pathname);
  }
  updateAuthInviteNote();
}

function updateAuthInviteNote() {
  const note = document.getElementById('auth-invite-note');
  const has = Boolean(localStorage.getItem(LS_KEYS.pendingInvite));
  note.classList.toggle('hidden', !has);
}

async function tryRedeemPendingInvite() {
  const code = localStorage.getItem(LS_KEYS.pendingInvite);
  if (!code) return false;
  // 兑换前先确认还没有空间（避免自己空间的 owner 误兑）
  try {
    await redeemInvitation(code);
    localStorage.removeItem(LS_KEYS.pendingInvite);
    toast('已成功加入 TA 的情侣空间 💕', 'success', 3600);
    updateAuthInviteNote();
    return true;
  } catch (err) {
    localStorage.removeItem(LS_KEYS.pendingInvite);
    toast('邀请码未能使用：' + readableError(err), 'notice', 4500);
    updateAuthInviteNote();
    return false;
  }
}

/* ================= 恋爱计时器（真实时间戳计算） ================= */

let timerHandle = null;

export function startTimer() {
  stopTimer();
  const daysEl = document.getElementById('t-days');
  const detailEl = document.getElementById('timer-detail');
  const invalidEl = document.getElementById('timer-invalid');

  function tick() {
    const start = state.space ? new Date(state.space.relationship_start).getTime() : NaN;
    if (!Number.isFinite(start) || start > Date.now()) {
      invalidEl.classList.remove('hidden');
      detailEl.textContent = '— 小时 — 分 — 秒';
      daysEl.textContent = '…';
      return;
    }
    invalidEl.classList.add('hidden');
    const diff = Date.now() - start; // 毫秒，基于真实时间戳
    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    daysEl.textContent = String(days);
    detailEl.textContent = `${String(hours).padStart(2, '0')} 小时 ${String(minutes).padStart(2, '0')} 分 ${String(seconds).padStart(2, '0')} 秒`;
  }
  tick();
  timerHandle = setInterval(tick, 1000); // 每秒只更新 4 个数字节点，不重绘页面
}

function stopTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

/* ================= 深色模式 ================= */

function applyTheme(dark, animate = false) {
  const root = document.documentElement;
  if (animate) root.classList.add('theme-transition');
  root.classList.toggle('dark', dark);
  localStorage.setItem(LS_KEYS.theme, dark ? 'dark' : 'light');
  document.getElementById('theme-icon-moon').classList.toggle('hidden', dark);
  document.getElementById('theme-icon-sun').classList.toggle('hidden', !dark);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#221E26' : '#FFF9F7');
  if (animate) setTimeout(() => root.classList.remove('theme-transition'), 400);
}

function initTheme() {
  const saved = localStorage.getItem(LS_KEYS.theme);
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark);
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(!document.documentElement.classList.contains('dark'), true);
  });
}

/* ================= 背景音乐 ================= */

let audioEl = null;
let musicPlaying = false;

function setMusicIcon(playing) {
  document.getElementById('music-icon-on').classList.toggle('hidden', !playing);
  document.getElementById('music-icon-off').classList.toggle('hidden', playing);
}

function toggleMusic() {
  const url = musicUrl();
  if (!url) {
    toast('还没有配置背景音乐，可在「编辑我们的故事」中填写音乐链接', 'notice', 3600);
    return;
  }
  if (!audioEl) {
    audioEl = new Audio(url);
    audioEl.loop = true;
    audioEl.preload = 'none';
    audioEl.addEventListener('error', () => {
      toast('音乐链接无法播放，请检查地址是否有效', 'error');
      musicPlaying = false;
      setMusicIcon(false);
    });
  }
  if (musicPlaying) {
    audioEl.pause();
    musicPlaying = false;
    setMusicIcon(false);
  } else {
    audioEl.play().then(() => {
      musicPlaying = true;
      setMusicIcon(true);
    }).catch(() => {
      toast('播放失败：浏览器可能阻止了自动播放，请再点一次', 'error');
    });
  }
}

/* ================= 飘落爱心（低密度） ================= */

function initFloatingHearts() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.getElementById('hearts-layer');
  const COUNT = 7;
  for (let i = 0; i < COUNT; i++) {
    const h = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const size = 10 + Math.random() * 10;
    h.setAttribute('viewBox', '0 0 24 24');
    h.setAttribute('width', size);
    h.setAttribute('height', size);
    h.classList.add('float-heart');
    h.innerHTML = '<path fill="currentColor" d="M12 21s-7.5-4.8-10-9.3C.5 8.4 2.6 5 6 5c2 0 3.4 1 4 2.2h4c.6-1.2 2-2.2 4-2.2 3.4 0 5.5 3.4 4 6.7C19.5 16.2 12 21 12 21z"/>';
    h.style.left = (4 + Math.random() * 92) + '%';
    h.style.animationDuration = (16 + Math.random() * 12) + 's';
    h.style.animationDelay = (-Math.random() * 20) + 's';
    layer.appendChild(h);
  }
}

/* ================= 认证视图 ================= */

function initAuthView() {
  const tabs = document.querySelectorAll('.auth-tab');
  const panes = {
    login: document.getElementById('form-login'),
    register: document.getElementById('form-register'),
    forgot: document.getElementById('form-forgot')
  };
  let activePane = 'login';
  let lastRegisterEmail = '';

  function switchPane(name) {
    activePane = name;
    Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.authTab === name));
    document.getElementById('verify-notice').classList.add('hidden');
  }
  tabs.forEach((t) => t.addEventListener('click', () => switchPane(t.dataset.authTab)));
  document.getElementById('link-forgot').addEventListener('click', () => switchPane('forgot'));
  document.getElementById('back-to-login').addEventListener('click', () => switchPane('login'));

  // 登录
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFormError(form);
    const email = form.querySelector('#login-email').value;
    const password = form.querySelector('#login-password').value;
    if (!email || !password) return showFormError(form, '请填写邮箱和密码');
    if (!isEmailFormatValid(normalizeEmail(email))) {
      return showFormError(form, '邮箱格式不正确（请检查是否误用了中文输入法的全角 @ 或 . 符号）');
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      await signInWithEmail(email, password);
      await route();
    } catch (err) {
      showFormError(form, readableError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  // 密码框「显示/隐藏」开关（用于核对是否被输入法加空格或被浏览器自动填充）
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('.ic-eye').classList.toggle('hidden', show);
      btn.querySelector('.ic-eye-off').classList.toggle('hidden', !show);
    });
  });

  // 注册
  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFormError(form);
    const email = form.querySelector('#reg-email').value;
    let pw = form.querySelector('#reg-password').value;
    let pw2 = form.querySelector('#reg-password2').value;
    if (!email || !pw) return showFormError(form, '请填写邮箱和密码');
    if (!isEmailFormatValid(normalizeEmail(email))) {
      return showFormError(form, '邮箱格式不正确（请检查是否误用了中文输入法的全角 @ 或 . 符号）');
    }
    if (pw.length < 6) return showFormError(form, '密码至少 6 位');
    // 常见坑：中文输入法自动在首尾加空格 —— 若两次输入仅首尾空格不同，自动忽略
    if (pw !== pw2 && pw.trim() === pw2.trim()) {
      pw = pw.trim();
      pw2 = pw2.trim();
    }
    if (pw !== pw2) {
      return showFormError(form, '两次输入的密码不一致。可点输入框右侧 👁 核对：常见原因是输入法自动加了空格，或浏览器自动填充了旧密码（清除后重新输入即可）');
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      lastRegisterEmail = email;
      const { needsVerification } = await signUpWithEmail(email, pw);
      if (needsVerification) {
        switchPane('login');
        document.getElementById('verify-notice').classList.remove('hidden');
        toast('注册成功，请查收验证邮件', 'success', 3600);
      } else {
        toast('注册成功，欢迎 💕', 'success');
        await route();
      }
    } catch (err) {
      showFormError(form, readableError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = '创建账号';
    }
  });

  // 重发验证邮件
  document.getElementById('btn-resend').addEventListener('click', async () => {
    const email = lastRegisterEmail || document.getElementById('login-email').value.trim();
    if (!email) return toast('请先在登录框填写注册邮箱', 'notice');
    try {
      await resendVerification(email);
      toast('验证邮件已重新发送，请查收', 'success', 3600);
    } catch (err) {
      toast(readableError(err), 'error');
    }
  });

  // 忘记密码
  document.getElementById('form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFormError(form);
    document.getElementById('forgot-success').classList.add('hidden');
    const email = form.querySelector('#forgot-email').value;
    if (!email) return showFormError(form, '请填写邮箱');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      await sendPasswordReset(email);
      const p = document.getElementById('forgot-success');
      p.textContent = '重置邮件已发送（若该邮箱已注册）。请查收并按邮件指引操作。';
      p.classList.remove('hidden');
    } catch (err) {
      showFormError(form, readableError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = '发送重置邮件';
    }
  });
}

/** 密码重置回调：打开设置新密码弹窗 */
function maybeHandleRecovery() {
  const isRecovery =
    location.hash.includes('type=recovery') ||
    new URLSearchParams(location.search).get('type') === 'recovery';
  if (!isRecovery) return;
  history.replaceState(null, '', location.pathname);
  openModal({
    title: '设置新密码',
    body: `
      <div class="space-y-4">
        <p class="text-xs text-muted dark:text-nightmuted">你正在通过重置链接修改密码。</p>
        <div>
          <label class="form-label">新密码（至少 6 位）</label>
          <input name="pw" type="password" minlength="6" required class="form-input" autocomplete="new-password" />
        </div>
        <div>
          <label class="form-label">确认新密码</label>
          <input name="pw2" type="password" minlength="6" required class="form-input" autocomplete="new-password" />
        </div>
      </div>`,
    submitText: '更新密码',
    onSubmit: async (form) => {
      clearFormError(form);
      if (form.pw.value.length < 6) return showFormError(form, '密码至少 6 位'), false;
      if (form.pw.value !== form.pw2.value) return showFormError(form, '两次输入不一致'), false;
      await updatePassword(form.pw.value);
      toast('密码已更新', 'success');
      setTimeout(() => route(), 600);
    }
  });
}

/* ================= 建空间 / 加空间视图 ================= */

function initSetupView() {
  // 默认值：恋爱开始于一个月前
  const dt = document.getElementById('start-datetime');
  if (dt && !dt.value) {
    const d = new Date(Date.now() - 30 * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    dt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  document.getElementById('form-create-space').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFormError(form);
    const name = document.getElementById('space-name').value.trim();
    const start = document.getElementById('start-datetime').value;
    if (!name) return showFormError(form, '请填写空间名称');
    if (!start) return showFormError(form, '请选择恋爱开始时间');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      await createSpace({
        name,
        startAt: start,
        ownerNick: document.getElementById('owner-nick').value.trim(),
        partnerNick: document.getElementById('partner-nick').value.trim()
      });
      toast('空间创建成功，快邀请另一半吧 💕', 'success', 4000);
      await route();
    } catch (err) {
      showFormError(form, readableError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = '创建空间';
    }
  });

  document.getElementById('form-join-space').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFormError(form);
    document.getElementById('join-space-success').classList.add('hidden');
    const code = document.getElementById('invite-code').value.trim();
    if (!code) return showFormError(form, '请粘贴邀请码');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '加入中…';
    try {
      await redeemInvitation(code);
      toast('加入成功，你们的空间已就绪 💕', 'success', 3600);
      await route();
    } catch (err) {
      showFormError(form, readableError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = '加入空间';
    }
  });

  document.getElementById('setup-logout').addEventListener('click', async () => {
    await signOut();
    route();
  });
}

/* ================= 主应用视图事件 ================= */

function initAppButtons() {
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await signOut();
    route();
  });
  document.getElementById('btn-music').addEventListener('click', toggleMusic);
  document.getElementById('btn-add-memory').addEventListener('click', () => {
    openEventModal(null, refreshEvents);
  });
  document.getElementById('btn-add-anniversary').addEventListener('click', () => {
    openEventModal(null, refreshEvents);
  });
  document.getElementById('btn-edit-story').addEventListener('click', () => {
    openSettingsModal(async () => {
      await loadSpaceData();
      await renderCover();
      renderAnniversaries();
      startTimer();
    });
  });
  document.getElementById('btn-invite').addEventListener('click', openInviteModal);
  document.getElementById('btn-edit-letter').addEventListener('click', () => {
    openLetterModal(async () => {
      await loadSpaceData();
      renderLetter();
    });
  });
  document.getElementById('btn-manage-wall').addEventListener('click', () => {
    toggleWallManage();
  });

  // 上传到照片墙（带预览的确认弹窗）
  document.getElementById('btn-upload-wall').addEventListener('click', () => {
    if (!state.space) return;
    const picker = createPhotoPicker({ multiple: true, label: '选择照片' });
    openModal({
      title: '上传到照片墙',
      body: picker.el,
      submitText: '开始上传',
      onSubmit: async (form, submitBtn) => {
        const files = picker.getFiles();
        if (!files.length) {
          toast('还没有选择照片', 'notice');
          return false;
        }
        const { inserted, errors } = await uploadPhotos({
          files,
          spaceId: state.space.id,
          eventId: null,
          onProgress: (i, n) => (submitBtn.textContent = `上传中 ${i}/${n}…`)
        });
        if (errors.length) toast(errors[0], 'error', 4200);
        if (inserted) toast(`已上传 ${inserted} 张照片`, 'success');
        await loadAllPhotos();
        renderWall(state.space.id);
      }
    });
  });
}

/* ================= 启动 ================= */

async function boot() {
  console.log('[boot] 开始启动...');

  // 全局错误捕获
  window.addEventListener('error', (e) => {
    console.error('[全局错误]', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[未捕获的Promise拒绝]', e.reason);
  });

  try {
    if (!isConfigured()) {
      showConfigError();
      return;
    }

    captureInviteFromUrl();
    initTheme();
    initFloatingHearts();
    initLightbox();
    initAuthView();
    initSetupView();
    initAppButtons();
    initNetworkStatus();

    // 认证状态变化（含邮箱验证回调、密码重置回调、多标签页登出）
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') route();
    });

    maybeHandleRecovery();

    // 路由：根据登录状态显示对应视图（无加载遮罩，内容立即可见）
    await route();
  } catch (err) {
    console.error('启动失败:', err);
    toast('启动异常：' + readableError(err), 'error', 5000);
    // 降级：确保用户至少能看到登录页面
    document.getElementById('view-auth').classList.remove('hidden');
  }
}

boot();
