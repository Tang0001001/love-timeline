-- ============================================================================
-- 002_fix_pgcrypto_visibility.sql
--
-- 修复问题：生成/兑换邀请时报错
--   "function gen_random_bytes(integer) does not exist"
--
-- 原因：新版 Supabase 将 pgcrypto 扩展预装在 extensions 模式下，
-- 而安全 RPC 函数固定了 search_path = public，导致扩展函数
-- gen_random_bytes() 和 digest() 在函数体内不可见。
--
-- 本补丁（幂等，可重复执行）：
--   1. 确保 pgcrypto 扩展存在（安装到 extensions 模式，Supabase 官方约定）
--   2. 重建两个涉及加密函数的 RPC，search_path 扩展为
--      public, extensions, pg_temp
--      （extensions 模式由平台管理、普通用户不可写，无搜索路径劫持风险）
--
-- 使用方法：在 Supabase Dashboard → SQL Editor 新建查询，粘贴本文件
--           全部内容并运行。成功后回到网站重新点击「生成邀请链接」。
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. 重建：生成邀请（仅 owner）
-- ---------------------------------------------------------------------------

create or replace function public.create_invitation(p_ttl_hours integer default 48)
returns text
language plpgsql security definer
set search_path = public, extensions, pg_temp
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
-- 2. 重建：兑换邀请（行锁保证原子性，一次性使用）
-- ---------------------------------------------------------------------------

create or replace function public.redeem_invitation(p_code text)
returns uuid
language plpgsql security definer
set search_path = public, extensions, pg_temp
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
-- 验证：运行后执行以下语句应返回一行（版本号），表示 pgcrypto 已就位
--   select extensions.gen_random_bytes(4) is not null as pgcrypto_ok;
-- ---------------------------------------------------------------------------
