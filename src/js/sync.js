// sync.js —— Realtime 实时同步 + 网络状态
// 只订阅当前用户所属空间，页面卸载时正确清理订阅。

import { supabase } from './supabase.js';

let channel = null;
let paused = false;
let debounceTimer = null;
const pendingChanges = new Set();

export function pause() {
  paused = true;
}

export function resume() {
  paused = false;
  flush();
}

function flush() {
  if (!pendingChanges.size) return;
  const kinds = [...pendingChanges];
  pendingChanges.clear();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    kinds.forEach((k) => handlers[k] && handlers[k]());
  }, 300);
}

const handlers = {
  events: null,
  photos: null,
  settings: null,
  members: null
};

/**
 * 订阅空间数据变化。
 * @param {string} spaceId
 * @param {{events?:Function, photos?:Function, settings?:Function, members?:Function}} cb
 */
export function startSync(spaceId, cb) {
  stopSync();
  Object.assign(handlers, {
    events: cb.events || null,
    photos: cb.photos || null,
    settings: cb.settings || null,
    members: cb.members || null
  });

  channel = supabase
    .channel(`space-${spaceId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'timeline_events', filter: `space_id=eq.${spaceId}` },
      () => record('events')
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'gallery_photos', filter: `space_id=eq.${spaceId}` },
      () => record('photos')
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'space_settings', filter: `space_id=eq.${spaceId}` },
      () => record('settings')
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'couple_spaces', filter: `id=eq.${spaceId}` },
      () => record('settings')
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'space_members', filter: `space_id=eq.${spaceId}` },
      () => record('members')
    )
    .subscribe((status) => {
      // 断线重连后做一次全量刷新，避免漏事件
      if (status === 'SUBSCRIBED' && pendingChanges.size === 0 && hadConnected) {
        Object.values(handlers).forEach((h) => h && h());
      }
      if (status === 'SUBSCRIBED') hadConnected = true;
    });
}

let hadConnected = false;

function record(kind) {
  if (paused) {
    pendingChanges.add(kind);
    return;
  }
  pendingChanges.add(kind);
  flush();
}

export function stopSync() {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingChanges.clear();
  hadConnected = false;
}

/* ================= 网络状态 ================= */

export function initNetworkStatus(onChange) {
  const banner = document.getElementById('network-banner');
  const update = () => {
    const online = navigator.onLine;
    banner.classList.toggle('hidden', online);
    onChange && onChange(online);
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}
