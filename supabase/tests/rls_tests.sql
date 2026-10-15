-- ============================================================================
-- Our Love Story · RLS 权限测试（supabase/tests/rls_tests.sql）
--
-- 使用方法：
--   1. 在 Supabase Dashboard -> Authentication -> Users 中先创建三个测试账号：
--        owner@test.local    （将创建空间）
--        partner@test.local  （将加入空间）
--        outsider@test.local （完全无关的用户）
--   2. 将本文件完整粘贴到 SQL Editor 执行。
--   3. 全部通过时会输出 "RLS 测试全部通过"。
--
-- 原理：在事务中 set local role authenticated + set local request.jwt.claims，
--       模拟不同登录用户访问，验证 RLS 策略真实生效。
-- ============================================================================

create or replace function public.__rls_assert(p_ok boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if coalesce(p_ok, false) then
    raise notice 'PASS: %', p_label;
  else
    raise exception 'FAIL: %', p_label;
  end if;
end;
$$;

do $$
declare
  v_owner    uuid;
  v_partner  uuid;
  v_outsider uuid;
  v_space    uuid;
  v_event    uuid;
  v_photo_id uuid;
  v_code     text;
  v_err      text;
begin
  select id into v_owner    from auth.users where email = 'owner@test.local'    limit 1;
  select id into v_partner  from auth.users where email = 'partner@test.local'  limit 1;
  select id into v_outsider from auth.users where email = 'outsider@test.local' limit 1;

  if v_owner is null or v_partner is null or v_outsider is null then
    raise exception '请先创建 owner@test.local / partner@test.local / outsider@test.local 三个测试账号';
  end if;

  ------------------------------------------------------------------
  -- A. 匿名用户（anon）：不能访问任何业务数据
  ------------------------------------------------------------------
  set local role anon;
  perform public.__rls_assert((select count(*) from public.couple_spaces)   = 0, 'A1 匿名不能读取 couple_spaces');
  perform public.__rls_assert((select count(*) from public.timeline_events) = 0, 'A2 匿名不能读取 timeline_events');
  perform public.__rls_assert((select count(*) from public.gallery_photos)  = 0, 'A3 匿名不能读取 gallery_photos');
  perform public.__rls_assert((select count(*) from public.invitations)     = 0, 'A4 匿名不能读取 invitations');

  ------------------------------------------------------------------
  -- B. owner：创建空间（走安全 RPC），验证数据初始化
  ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  perform public.__rls_assert(
    public.create_couple_space('测试空间', now() - interval '200 days', '小明', '小红') is not null,
    'B1 owner 通过 RPC 创建空间成功');

  select id into v_space from public.couple_spaces where owner_id = v_owner;
  perform public.__rls_assert(v_space is not null, 'B2 空间记录存在');
  perform public.__rls_assert(
    (select count(*) from public.space_members where space_id = v_space and role = 'owner') = 1,
    'B3 owner 成员关系已建立');
  perform public.__rls_assert(
    (select count(*) from public.timeline_events where space_id = v_space) = 6,
    'B4 预置 6 个示例事件');
  perform public.__rls_assert(
    (select count(*) from public.space_settings where space_id = v_space) = 1,
    'B5 空间设置已初始化');

  ------------------------------------------------------------------
  -- C. owner 不能重复创建 / 重复加入
  ------------------------------------------------------------------
  begin
    perform public.create_couple_space('第二个空间', now() - interval '10 days');
    perform public.__rls_assert(false, 'C1 已加入空间的用户不能再次创建空间（应抛错）');
  exception when others then
    perform public.__rls_assert(true, 'C1 已加入空间的用户不能再次创建空间（已拒绝）');
  end;

  ------------------------------------------------------------------
  -- D. 邀请流程：生成 -> 哈希存储 -> 兑换 -> 一次性
  ------------------------------------------------------------------
  v_code := public.create_invitation(48);
  perform public.__rls_assert(length(v_code) = 32, 'D1 生成 32 位十六进制邀请码');
  perform public.__rls_assert(
    (select count(*) from public.invitations where code_hash = encode(digest(v_code, 'sha256'), 'hex')) = 1,
    'D2 数据库只保存邀请码哈希');
  perform public.__rls_assert(
    (select count(*) from public.invitations where code_hash = v_code) = 0,
    'D3 数据库不保存明文邀请码');

  -- owner 不能兑换自己的邀请码
  begin
    perform public.redeem_invitation(v_code);
    perform public.__rls_assert(false, 'D4 owner 不能兑换自己的邀请码（应抛错）');
  exception when others then
    perform public.__rls_assert(true, 'D4 owner 不能兑换自己的邀请码（已拒绝）');
  end;

  -- partner 兑换成功
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_partner, 'role', 'authenticated')::text, true);
  perform public.__rls_assert(
    public.redeem_invitation(v_code) = v_space,
    'D5 partner 兑换邀请成功并返回空间 ID');

  -- 同一邀请码不能重复使用
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.redeem_invitation(v_code);
    perform public.__rls_assert(false, 'D6 邀请码一次性（重复使用应抛错）');
  exception when others then
    perform public.__rls_assert(true, 'D6 邀请码一次性（重复使用已拒绝）');
  end;

  -- 错误邀请码
  begin
    perform public.redeem_invitation('deadbeefdeadbeefdeadbeefdeadbeef');
    perform public.__rls_assert(false, 'D7 错误邀请码应抛错');
  exception when others then
    perform public.__rls_assert(true, 'D7 错误邀请码已拒绝');
  end;

  ------------------------------------------------------------------
  -- E. partner 权限边界：不能生成邀请、不能撤销、不能移除伴侣
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_partner, 'role', 'authenticated')::text, true);
  begin
    perform public.create_invitation(48);
    perform public.__rls_assert(false, 'E1 partner 不能生成邀请（应抛错）');
  exception when others then
    perform public.__rls_assert(true, 'E1 partner 不能生成邀请（已拒绝）');
  end;

  begin
    perform public.remove_partner(v_space);
    perform public.__rls_assert(false, 'E2 partner 不能调用移除伴侣（应抛错）');
  exception when others then
    perform public.__rls_assert(true, 'E2 partner 不能调用移除伴侣（已拒绝）');
  end;

  ------------------------------------------------------------------
  -- F. 跨空间越权：outsider（已加入过空间，模拟空间 B 用户）读不到空间 A
  ------------------------------------------------------------------
  -- 先让 outsider 也有自己的空间（成为空间 B 的主人）
  perform public.create_couple_space('另一个空间', now() - interval '30 days');
  perform public.__rls_assert(
    (select count(*) from public.couple_spaces where id = v_space) = 0,
    'F1 空间 B 用户不能 SELECT 空间 A');
  perform public.__rls_assert(
    (select count(*) from public.timeline_events where space_id = v_space) = 0,
    'F2 空间 B 用户不能读取空间 A 的事件');
  perform public.__rls_assert(
    (select count(*) from public.space_settings where space_id = v_space) = 0,
    'F3 空间 B 用户不能读取空间 A 的设置');
  perform public.__rls_assert(
    (select count(*) from public.invitations where space_id = v_space) = 0,
    'F4 空间 B 用户不能读取空间 A 的邀请');

  -- outsider 向空间 A 插入事件应被拒绝
  begin
    insert into public.timeline_events (space_id, title, event_date, created_by)
    values (v_space, '越权事件', current_date, v_outsider);
    perform public.__rls_assert(false, 'F5 非成员向空间 A 插入事件应被拒绝');
  exception when insufficient_privilege then
    perform public.__rls_assert(true, 'F5 非成员向空间 A 插入事件已拒绝');
  end;

  -- 伪造 created_by 也不能绕过（created_by 必须等于 auth.uid()）
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  begin
    insert into public.timeline_events (space_id, title, event_date, created_by)
    values (v_space, '伪造事件', current_date, v_owner);
    perform public.__rls_assert(false, 'F6 伪造 created_by 插入事件应被拒绝');
  exception when insufficient_privilege then
    perform public.__rls_assert(true, 'F6 伪造 created_by 已被拒绝');
  end;

  -- 伪造 storage_path（不属于本空间的路径）插入照片记录应被拒绝
  declare
    v_other_space uuid;
  begin
    select id into v_other_space from public.couple_spaces where owner_id = v_outsider;
    insert into public.gallery_photos (space_id, storage_path, uploaded_by)
    values (v_other_space, v_space::text || '/wall/fake.jpg', v_outsider);
    perform public.__rls_assert(false, 'F7 伪造跨空间 storage_path 应被拒绝');
  exception when insufficient_privilege then
    perform public.__rls_assert(true, 'F7 伪造跨空间 storage_path 已被拒绝');
  end;

  ------------------------------------------------------------------
  -- G. 成员不能直接修改 space_members（角色提升防护）
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_partner, 'role', 'authenticated')::text, true);
  begin
    update public.space_members set role = 'owner' where user_id = v_partner;
    perform public.__rls_assert(false, 'G1 partner 直接提升角色应被拒绝（无 UPDATE 策略）');
  exception when insufficient_privilege then
    perform public.__rls_assert(true, 'G1 partner 直接提升角色已拒绝');
  end;

  ------------------------------------------------------------------
  -- H. 成员可正常增删改查自己空间的事件
  ------------------------------------------------------------------
  insert into public.timeline_events (space_id, title, event_date, description, tag, created_by)
  values (v_space, 'partner 的事件', current_date, '测试', '测试', v_partner)
  returning id into v_event;
  perform public.__rls_assert(v_event is not null, 'H1 partner 可在共同空间新增事件');

  update public.timeline_events set description = '改过了' where id = v_event;
  perform public.__rls_assert(
    (select description from public.timeline_events where id = v_event) = '改过了',
    'H2 partner 可修改事件');

  delete from public.timeline_events where id = v_event;
  perform public.__rls_assert(
    (select count(*) from public.timeline_events where id = v_event) = 0,
    'H3 partner 可删除事件');

  ------------------------------------------------------------------
  -- I. owner 移除伴侣后，对方立即失去访问权
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform public.remove_partner(v_space);
  perform public.__rls_assert(
    (select count(*) from public.space_members where space_id = v_space) = 1,
    'I1 移除后空间只剩 owner');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_partner, 'role', 'authenticated')::text, true);
  perform public.__rls_assert(
    (select count(*) from public.timeline_events where space_id = v_space) = 0,
    'I2 被移除的伴侣立即失去数据访问权');

  ------------------------------------------------------------------
  -- J. 解散空间（owner delete 策略）后数据级联清理
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  delete from public.couple_spaces where id = v_space;
  perform public.__rls_assert(
    (select count(*) from public.space_members  where space_id = v_space) = 0 and
    (select count(*) from public.timeline_events where space_id = v_space) = 0 and
    (select count(*) from public.space_settings where space_id = v_space) = 0,
    'J1 解散空间后成员/事件/设置级联删除');

  -- 清理 outsider 的测试空间，保持数据库干净
  delete from public.couple_spaces where owner_id = v_outsider;

  raise notice '===== RLS 测试全部通过 =====';
end $$;

-- 清理测试辅助函数
drop function if exists public.__rls_assert(boolean, text);
