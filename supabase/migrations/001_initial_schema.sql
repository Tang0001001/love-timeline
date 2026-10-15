-- ============================================================================
-- Our Love Story · 001 初始数据库结构
-- 适用于 Supabase SQL Editor 或 supabase db push
--
-- 表结构：
--   couple_spaces    情侣空间（一个空间 = 一对情侣）
--   space_members    空间成员（owner / partner，最多 2 人，联合主键防重复加入）
--   space_settings   空间设置（标题、副标题、昵称、头像、封面、寄语、音乐等）
--   timeline_events  时光轴事件（event_date 用 date 类型，避免时区导致日期偏移）
--   gallery_photos   照片元数据（只存 Storage 路径，不存签名 URL）
--   invitations      邀请（只保存 SHA-256 哈希，不存明文邀请码）
--
-- 删除规则：删除 couple_spaces 级联删除成员/设置/事件/照片记录/邀请；
--           删除 timeline_events 级联删除其照片记录。
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. 数据表
-- ---------------------------------------------------------------------------

create table if not exists public.couple_spaces (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(btrim(name)) between 1 and 60),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  relationship_start  timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.space_members (
  space_id   uuid not null references public.couple_spaces (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'partner')),
  joined_at  timestamptz not null default now(),
  primary key (space_id, user_id)  -- 联合主键：同一用户不能重复加入同一空间
);

create table if not exists public.space_settings (
  space_id              uuid primary key references public.couple_spaces (id) on delete cascade,
  title                 text not null default '我们的故事',
  subtitle              text not null default '从遇见你的那天起，平凡的日子也开始闪闪发光。',
  owner_nickname        text not null default '我',
  partner_nickname      text not null default '亲爱的',
  owner_avatar_path     text,
  partner_avatar_path   text,
  cover_photo_path      text,
  letter_title          text not null default '写给未来',
  letter_body           text not null default '希望未来的日子里，我们依然有分享不完的小事，有说走就走的勇气，也有在疲惫的时候，给彼此一个拥抱的温柔。愿往后的每个春夏秋冬，都有你在身旁。',
  letter_signature      text not null default '爱你的我们',
  letter_date           date,
  letter_background_path text,
  music_url             text,
  updated_at            timestamptz not null default now()
);

create table if not exists public.timeline_events (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.couple_spaces (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 100),
  event_date  date not null,          -- 纯日期，按字面存储，不做时区换算
  event_time  time,                   -- 可选时间
  description text not null default '',
  tag         text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.gallery_photos (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references public.couple_spaces (id) on delete cascade,
  event_id     uuid references public.timeline_events (id) on delete cascade, -- 为空 = 照片墙
  storage_path text not null,
  caption      text not null default '',
  sort_order   integer not null default 0,
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.couple_spaces (id) on delete cascade,
  code_hash   text not null unique,          -- 只保存 SHA-256 哈希
  created_by  uuid not null references auth.users (id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_events_space_date  on public.timeline_events (space_id, event_date, event_time);
create index if not exists idx_photos_space       on public.gallery_photos (space_id);
create index if not exists idx_photos_event       on public.gallery_photos (event_id);
create index if not exists idx_members_user       on public.space_members (user_id);
create index if not exists idx_invitations_space  on public.invitations (space_id);

-- ---------------------------------------------------------------------------
-- 2. updated_at 自动维护触发器
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_spaces_touch on public.couple_spaces;
create trigger trg_spaces_touch before update on public.couple_spaces
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_settings_touch on public.space_settings;
create trigger trg_settings_touch before update on public.space_settings
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_events_touch on public.timeline_events;
create trigger trg_events_touch before update on public.timeline_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 权限辅助函数（SECURITY DEFINER：绕过 space_members 的 RLS，避免递归；
--    search_path 固定，防止搜索路径劫持）
-- ---------------------------------------------------------------------------

create or replace function public.is_space_member(p_space_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_space_owner(p_space_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space_id and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- 辅助函数只允许已登录用户调用，禁止匿名和公共角色执行
revoke execute on function public.is_space_member(uuid) from public, anon;
revoke execute on function public.is_space_owner(uuid) from public, anon;
grant execute on function public.is_space_member(uuid) to authenticated;
grant execute on function public.is_space_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. 安全 RPC：创建空间（原子插入空间 + 成员 + 设置 + 预置事件）
-- ---------------------------------------------------------------------------

create or replace function public.create_couple_space(
  p_name               text,
  p_relationship_start timestamptz,
  p_owner_nickname     text default '我',
  p_partner_nickname   text default '亲爱的'
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_space uuid;
  v_day   date;
begin
  if v_user is null then
    raise exception '请先登录';
  end if;
  if p_relationship_start is null or p_relationship_start > now() then
    raise exception '恋爱开始时间无效或晚于当前时间';
  end if;
  -- 每个用户只加入一个空间
  if exists (select 1 from public.space_members where user_id = v_user) then
    raise exception '你已经加入了一个情侣空间';
  end if;

  insert into public.couple_spaces (name, owner_id, relationship_start)
    values (btrim(p_name), v_user, p_relationship_start)
    returning id into v_space;

  insert into public.space_members (space_id, user_id, role)
    values (v_space, v_user, 'owner');

  insert into public.space_settings (space_id, owner_nickname, partner_nickname)
    values (
      v_space,
      coalesce(nullif(btrim(p_owner_nickname), ''), '我'),
      coalesce(nullif(btrim(p_partner_nickname), ''), '亲爱的')
    );

  -- 预置示例事件（均可编辑或删除）
  v_day := p_relationship_start::date;
  insert into public.timeline_events (space_id, title, event_date, description, tag, created_by)
  values
    (v_space, '初次相遇',       v_day,           '那一天，我们在人海里认出了彼此，故事悄悄开始了。', '相遇', v_user),
    (v_space, '正式在一起',     v_day,           '从这一天起，我们决定：往后余生，一起走。',         '告白', v_user),
    (v_space, '第一次约会',     v_day + 3,       '紧张又心动的一次见面，连空气都是甜的。',           '约会', v_user),
    (v_space, '第一次旅行',     v_day + 45,      '第一次一起看外面的世界，从此最爱 « 一起 » 这两个字。', '旅行', v_user),
    (v_space, '一起度过的生日', v_day + 60,      '为你点亮蜡烛的那一刻，许的愿望都与你有关。',       '生日', v_user),
    (v_space, '难忘的纪念日',   v_day + 100,     '第 100 天，感谢有你，把平凡日子过成诗。',          '纪念', v_user);

  return v_space;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 安全 RPC：创建邀请（仅 owner；明文邀请码只返回一次，库里只存哈希）
-- ---------------------------------------------------------------------------

create or replace function public.create_invitation(p_ttl_hours integer default 48)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_space uuid;
  v_code  text;
  v_open  integer;
begin
  if v_user is null then
    raise exception '请先登录';
  end if;

  select m.space_id into v_space
  from public.space_members m
  where m.user_id = v_user and m.role = 'owner';

  if v_space is null then
    raise exception '只有空间主人可以生成邀请';
  end if;

  select count(*) into v_open from public.invitations
  where space_id = v_space and used_at is null and revoked_at is null and expires_at > now();
  if v_open >= 3 then
    raise exception '已有未使用的有效邀请（最多 3 个），请先撤销或等待使用';
  end if;

  -- 密码学安全随机：16 字节 = 128 位熵
  v_code := encode(gen_random_bytes(16), 'hex');

  insert into public.invitations (space_id, code_hash, created_by, expires_at)
    values (
      v_space,
      encode(digest(v_code, 'sha256'), 'hex'),
      v_user,
      now() + make_interval(hours => greatest(coalesce(p_ttl_hours, 48), 1))
    );

  return v_code;  -- 明文邀请码仅此一次返回给调用者
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 安全 RPC：撤销邀请（仅 owner）
-- ---------------------------------------------------------------------------

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  update public.invitations
  set revoked_at = now()
  where id = p_invitation_id
    and revoked_at is null
    and used_at is null
    and space_id in (
      select m.space_id from public.space_members m
      where m.user_id = auth.uid() and m.role = 'owner'
    );

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception '邀请不存在、已使用、已撤销或你没有权限';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. 安全 RPC：兑换邀请（原子：SELECT ... FOR UPDATE 行锁，并发只成功一次）
-- ---------------------------------------------------------------------------

create or replace function public.redeem_invitation(p_code text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_hash    text;
  v_inv     public.invitations%rowtype;
  v_members integer;
begin
  if v_user is null then
    raise exception '请先登录';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception '邀请码不能为空';
  end if;

  v_hash := encode(digest(btrim(p_code), 'sha256'), 'hex');

  -- 行锁保证并发兑换的原子性
  select * into v_inv from public.invitations
  where code_hash = v_hash
  for update;

  if not found then
    raise exception '邀请码无效';
  end if;
  if v_inv.used_at is not null then
    raise exception '邀请码已被使用';
  end if;
  if v_inv.revoked_at is not null then
    raise exception '邀请码已被撤销';
  end if;
  if v_inv.expires_at < now() then
    raise exception '邀请码已过期，请联系 TA 重新生成';
  end if;
  if v_inv.created_by = v_user then
    raise exception '不能使用自己创建的邀请码';
  end if;
  if exists (select 1 from public.space_members where space_id = v_inv.space_id and user_id = v_user) then
    raise exception '你已经是该空间的成员';
  end if;
  if exists (select 1 from public.space_members where user_id = v_user) then
    raise exception '你已经加入了一个情侣空间';
  end if;

  select count(*) into v_members from public.space_members where space_id = v_inv.space_id;
  if v_members >= 2 then
    raise exception '该空间成员已满';
  end if;

  insert into public.space_members (space_id, user_id, role)
    values (v_inv.space_id, v_user, 'partner');

  update public.invitations
  set used_at = now(), used_by = v_user
  where id = v_inv.id;

  return v_inv.space_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. 安全 RPC：移除伴侣（仅 owner，需二次确认；成员关系删除后对方立即失去访问权）
-- ---------------------------------------------------------------------------

create or replace function public.remove_partner(p_space_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  delete from public.space_members m
  where m.space_id = p_space_id
    and m.role = 'partner'
    and exists (
      select 1 from public.space_members o
      where o.space_id = p_space_id and o.user_id = auth.uid() and o.role = 'owner'
    );

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception '没有可移除的伴侣，或你不是该空间的主人';
  end if;
end;
$$;

-- RPC 权限：仅已登录用户可调用
revoke execute on function public.create_couple_space(text, timestamptz, text, text) from public, anon;
revoke execute on function public.create_invitation(integer) from public, anon;
revoke execute on function public.revoke_invitation(uuid) from public, anon;
revoke execute on function public.redeem_invitation(text) from public, anon;
revoke execute on function public.remove_partner(uuid) from public, anon;
grant execute on function public.create_couple_space(text, timestamptz, text, text) to authenticated;
grant execute on function public.create_invitation(integer) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.redeem_invitation(text) to authenticated;
grant execute on function public.remove_partner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. RLS：启用 + 策略
-- ---------------------------------------------------------------------------

alter table public.couple_spaces   enable row level security;
alter table public.space_members   enable row level security;
alter table public.space_settings  enable row level security;
alter table public.timeline_events enable row level security;
alter table public.gallery_photos  enable row level security;
alter table public.invitations     enable row level security;

-- couple_spaces：成员可读；成员可改（名称/开始时间）；仅 owner 可删除（解散）；
-- 插入只允许走 create_couple_space RPC，因此不设 INSERT 策略
drop policy if exists "spaces_select_member" on public.couple_spaces;
create policy "spaces_select_member" on public.couple_spaces
  for select to authenticated
  using (public.is_space_member(id));

drop policy if exists "spaces_update_member" on public.couple_spaces;
create policy "spaces_update_member" on public.couple_spaces
  for update to authenticated
  using (public.is_space_member(id))
  with check (public.is_space_member(id));

drop policy if exists "spaces_delete_owner" on public.couple_spaces;
create policy "spaces_delete_owner" on public.couple_spaces
  for delete to authenticated
  using (public.is_space_owner(id));

-- space_members：成员可互相查看；增删改只允许走安全 RPC，不设直接写入策略
-- （因此任何人都无法通过 UPDATE 修改自己的 role）
drop policy if exists "members_select_member" on public.space_members;
create policy "members_select_member" on public.space_members
  for select to authenticated
  using (public.is_space_member(space_id));

-- space_settings：成员可读可改；插入随 create_couple_space 完成，不设 INSERT 策略
drop policy if exists "settings_select_member" on public.space_settings;
create policy "settings_select_member" on public.space_settings
  for select to authenticated
  using (public.is_space_member(space_id));

drop policy if exists "settings_update_member" on public.space_settings;
create policy "settings_update_member" on public.space_settings
  for update to authenticated
  using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));

-- timeline_events：成员可增删改查；插入时创建者必须是自己且必须是自己空间的成员
drop policy if exists "events_select_member" on public.timeline_events;
create policy "events_select_member" on public.timeline_events
  for select to authenticated
  using (public.is_space_member(space_id));

drop policy if exists "events_insert_member" on public.timeline_events;
create policy "events_insert_member" on public.timeline_events
  for insert to authenticated
  with check (public.is_space_member(space_id) and created_by = auth.uid());

drop policy if exists "events_update_member" on public.timeline_events;
create policy "events_update_member" on public.timeline_events
  for update to authenticated
  using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));

drop policy if exists "events_delete_member" on public.timeline_events;
create policy "events_delete_member" on public.timeline_events
  for delete to authenticated
  using (public.is_space_member(space_id));

-- gallery_photos：成员可增删改查；路径必须位于本空间目录之下，防止伪造路径越权
drop policy if exists "photos_select_member" on public.gallery_photos;
create policy "photos_select_member" on public.gallery_photos
  for select to authenticated
  using (public.is_space_member(space_id));

drop policy if exists "photos_insert_member" on public.gallery_photos;
create policy "photos_insert_member" on public.gallery_photos
  for insert to authenticated
  with check (
    public.is_space_member(space_id)
    and uploaded_by = auth.uid()
    and storage_path like space_id::text || '/%'
  );

drop policy if exists "photos_update_member" on public.gallery_photos;
create policy "photos_update_member" on public.gallery_photos
  for update to authenticated
  using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));

drop policy if exists "photos_delete_member" on public.gallery_photos;
create policy "photos_delete_member" on public.gallery_photos
  for delete to authenticated
  using (public.is_space_member(space_id));

-- invitations：仅 owner 可查看（状态/撤销入口）；写入只允许走 RPC
drop policy if exists "invitations_select_owner" on public.invitations;
create policy "invitations_select_owner" on public.invitations
  for select to authenticated
  using (public.is_space_owner(space_id));

-- ---------------------------------------------------------------------------
-- 10. Storage：私有 bucket + 按空间目录隔离的成员权限
--     路径约定：{space_id}/{event_id 或 wall}/{uuid}.{ext}
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'couple-photos',
  'couple-photos',
  false,  -- 私有 bucket，只能通过带权限的签名 URL 访问
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "storage_select_member" on storage.objects;
create policy "storage_select_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'couple-photos'
    and public.is_space_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "storage_insert_member" on storage.objects;
create policy "storage_insert_member" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'couple-photos'
    and public.is_space_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "storage_delete_member" on storage.objects;
create policy "storage_delete_member" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'couple-photos'
    and public.is_space_member(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------------
-- 11. Realtime：发布业务表，前端按 space_id 过滤订阅
--     （幂等写法：已在发布中的表自动跳过，重复运行不报错）
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['couple_spaces', 'space_members', 'space_settings', 'timeline_events', 'gallery_photos']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
