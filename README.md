# Our Love Story · 我们的恋爱时光轴

一个手机端优先的情侣恋爱时光轴网站。情侣双方各自注册登录、加入同一个情侣空间，共同上传照片、编辑文字、添加纪念日、管理回忆。所有数据（认证、业务数据、照片文件）保存在 **Supabase** 云端，前端部署在 **Vercel**，支持跨设备访问与实时同步。

**技术栈**：HTML5 · Tailwind CSS · 原生 JavaScript（ES Module）· Vite · Supabase（Auth + PostgreSQL + Storage + Realtime）· Vercel

> 安全模型：所有业务表启用 RLS，每次读写都通过数据库校验空间成员关系；邀请码只保存 SHA-256 哈希、一次性、可撤销；照片存放在私有 Storage Bucket，只有空间成员能取到带权限的签名 URL。前端只使用公开的 URL 与 Publishable Key（anon key），**不包含任何高权限密钥**。

---

## 目录

- [功能总览](#功能总览)
- [项目结构](#项目结构)
- [数据库设计说明](#数据库设计说明)
- [本地运行](#本地运行)
- [Supabase 配置步骤](#supabase-配置步骤)
- [Vercel 部署（从零开始 13 步）](#vercel-部署从零开始-13-步)
- [测试清单与验证结果](#测试清单与验证结果)
- [常见问题](#常见问题)

---

## 功能总览

| 模块 | 说明 |
| --- | --- |
| 账号认证 | 注册 / 登录 / 退出 / 会话刷新恢复 / 邮箱验证提示与重发 / 密码重置 |
| 情侣空间 | 第一个用户创建空间（自动预置 6 个示例事件），owner 邀请另一半加入 |
| 安全邀请 | 服务端生成 128 位随机邀请码，只存哈希；48 小时有效、一次性、可撤销；原子兑换（行锁） |
| 时光轴 | 事件增删改查，日期升序排列；手机端左线右卡单列，桌面端左右交替；`date` 类型存储避免时区偏移 |
| 照片 | 上传前校验类型/大小/可解码性，Canvas 压缩（最长边 2000px），进度提示；私有 Bucket + 签名 URL |
| 照片墙 | 手机双列 / 桌面四列网格；大图预览（遮罩 / Esc / 左右键）；说明、替换、删除 |
| 未来寄语 | 双方可编辑标题、正文、落款、纪念日期、背景照片 |
| 实时同步 | Supabase Realtime 订阅当前空间五张表，另一方修改后自动刷新；断网提示；`updated_at` 乐观锁检测编辑冲突 |
| 界面 | 奶油粉法式杂志排版；深色模式（本地记忆）；恋爱计时器（真实时间戳计算）；飘落爱心、滚动入场动画，支持 `prefers-reduced-motion` |
| 背景音乐 | 原生 Audio API，用户点击播放，可暂停/循环，未配置时给出提示 |

---

## 项目结构

```
love-timeline/
├── index.html                    # 单页应用（三个视图：认证 / 建空间 / 主应用）
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example                  # 公开配置模板
├── .gitignore
├── README.md
├── src/
│   ├── css/style.css             # Tailwind + 自定义样式（时光轴/照片墙/弹窗/动效）
│   └── js/
│       ├── config.js             # 公开配置与常量
│       ├── supabase.js           # Supabase 客户端
│       ├── auth.js               # 注册/登录/验证/重置
│       ├── space.js              # 空间状态、设置、邀请、成员管理、寄语
│       ├── timeline.js           # 时光轴 CRUD、渲染、纪念日
│       ├── photos.js             # 校验/压缩/上传/签名URL/照片墙/大图/存储清理
│       ├── editor.js             # 弹窗框架、表单、照片选择器、Toast
│       ├── sync.js               # Realtime 订阅 + 网络状态
│       └── main.js               # 入口：路由/计时器/主题/音乐/动效
└── supabase/
    ├── config.toml               # 本地 CLI 配置（可选）
    ├── migrations/
    │   └── 001_initial_schema.sql  # 全部表 + 安全 RPC + RLS + Storage 策略
    └── tests/
        └── rls_tests.sql         # RLS 越权测试（含跨空间/伪造身份用例）
```

> 邀请流程通过**安全 RPC（SECURITY DEFINER + 行锁）**实现，未使用 Edge Function —— 二者是需求中允许的等价方案，RPC 方案的好处是兑换天然原子且不需要额外部署与密钥管理。若希望改为 Edge Function，可将 `redeem_invitation` 的逻辑迁移到 Deno 函数中，通过 service role key 调用。

---

## 数据库设计说明

| 表 | 用途 | 关键字段与规则 |
| --- | --- | --- |
| `couple_spaces` | 情侣空间 | `owner_id → auth.users`；`relationship_start timestamptz`；更新时触发器维护 `updated_at` |
| `space_members` | 空间成员 | 联合主键 `(space_id, user_id)` **天然防止重复加入**；`role ∈ {owner, partner}`；**无 INSERT/UPDATE/DELETE 策略**，成员变更只能走安全 RPC（无法自行改角色） |
| `space_settings` | 空间设置 | 1:1 对应空间；标题/副标题/双方昵称与头像/封面/寄语全部字段/音乐链接 |
| `timeline_events` | 时光轴事件 | `event_date date` + `event_time time`（字面存储，**不会因 UTC 换算偏移一天**）；创建/更新时间 |
| `gallery_photos` | 照片元数据 | 只存 `storage_path`；`event_id` 为空表示照片墙照片；外键 `ON DELETE CASCADE` 跟随事件删除 |
| `invitations` | 邀请 | 只存 `code_hash`（SHA-256）；`expires_at` / `used_at` / `revoked_at` 三态 |

**删除规则**：删除 `couple_spaces` → 级联删除成员/设置/事件/照片记录/邀请；删除 `timeline_events` → 级联删除其照片记录；Storage 文件由前端在数据库删除成功后清理，失败进入 localStorage 待清理队列，下次启动自动重试（补偿机制）。

**安全函数**（均 `SECURITY DEFINER`、`search_path = public, pg_temp`、仅 `authenticated` 可执行）：

- `create_couple_space(...)`：原子创建空间 + owner 成员 + 设置 + 6 个预置事件；拒绝已加入空间的用户
- `create_invitation(ttl)`：仅 owner；`gen_random_bytes(16)` 生成邀请码，返回明文一次，库里只存哈希
- `revoke_invitation(id)`：仅 owner
- `redeem_invitation(code)`：`SELECT ... FOR UPDATE` 行锁保证并发兑换只成功一次；校验过期/已用/已撤销/自邀/重复加入/人数上限
- `remove_partner(space_id)`：仅 owner
- `is_space_member / is_space_owner`：RLS 策略使用的成员校验函数

**RLS 要点**：所有表 `using/with check` 均校验 `is_space_member(space_id)`；事件插入要求 `created_by = auth.uid()`（防伪造创建者）；照片插入要求 `storage_path LIKE space_id || '/%'`（防伪造路径）；`space_members` 与 `invitations` 无直接写入策略（只能走 RPC）。

**Storage**：私有 bucket `couple-photos`（10MB 限制，仅 JPEG/PNG/WebP），路径约定 `{space_id}/{event_id|wall|settings}/{uuid}.{ext}`，对象策略用 `(storage.foldername(name))[1]::uuid` 解析出 space_id 再校验成员关系 —— **跨空间读取/删除会被数据库拒绝**。

---

## 本地运行

```bash
# 1. 安装依赖（Node.js ≥ 18）
npm install

# 2. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，填入 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY

# 3. 启动开发服务器
npm run dev
# 打开 http://localhost:5173

# 4. 生产构建验证
npm run build && npm run preview
```

---

## Supabase 配置步骤

1. **创建项目**：[supabase.com](https://supabase.com) → New project，选择区域（建议离你们最近的地域），设置数据库密码。
2. **执行迁移**：SQL Editor → 粘贴 `supabase/migrations/001_initial_schema.sql` 全文 → Run。这一步会创建所有表、RPC、RLS 策略、Storage bucket 与 Realtime 发布。
3. **获取密钥**：Project Settings → API：
   - `Project URL` → 填入 `VITE_SUPABASE_URL`
   - `Publishable Key`（即旧版 anon key）→ 填入 `VITE_SUPABASE_PUBLISHABLE_KEY`
   - ⚠️ **`service_role` key 绝不能出现在前端代码或 Vercel 环境变量中**，本项目前端不需要它。
4. **认证配置**：Authentication → URL Configuration：
   - Site URL：填你的生产域名（如 `https://your-app.vercel.app`）
   - Redirect URLs：添加生产域名和 `http://localhost:5173`
   - 邮箱验证：Authentication → Providers → Email，确认设置。**默认每分钟只能发少量验证邮件，且免费套餐邮件由内置服务发出（发件人 noreply@mail.app.supabase.com），若未配置自定义 SMTP，送达率有限** —— 测试收不到邮件时请检查垃圾箱，或在 Authentication → Users 中手动 `Confirm` 用户。
   - 密码重置：Authentication → Email Templates → `Reset Password` 模板中的 `{{ .SiteURL }}` 会自动使用上面配置的 Site URL，无需修改。
5. **运行 RLS 测试**（强烈建议）：先在 Authentication → Users 创建三个测试账号 `owner@test.local`、`partner@test.local`、`outsider@test.local`（可勾选 Auto Confirm 快速创建），然后在 SQL Editor 运行 `supabase/tests/rls_tests.sql`。全部通过时会输出 `RLS 测试全部通过`。测试完可删除这三个测试账号。

---

## Vercel 部署（从零开始 13 步）

**第一步：创建 Supabase 项目。** 按上一节完成项目创建与 SQL 迁移。

**第二步：获取 Project URL 和 Publishable Key。** Settings → API 页复制两个值。

**第三步：执行数据库 SQL Migration。** SQL Editor 运行 `001_initial_schema.sql`（若第二步前已完成可跳过）。

**第四步：确认照片 Storage Bucket 与策略。** Storage 页应能看到私有 bucket `couple-photos`（由迁移 SQL 自动创建，含成员权限策略）。无需手动创建公开 bucket —— **本项目照片全部私有**。

**第五步：（本项目无需 Edge Function）** 邀请逻辑通过数据库安全 RPC 实现，无服务端函数需要部署，也没有服务端 Secret 需要配置。这是设计选择，见上文说明。

**第六步：配置 Supabase Auth 回调。** Authentication → URL Configuration：Site URL 填 `https://<你的域名>`；Redirect URLs 添加 `https://<你的域名>`、`https://<你的域名>/`、`http://localhost:5173`。

**第七步：本地创建 `.env.local`。** 内容：

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOi...
```

**第八步：安装依赖并运行开发服务器。** `npm install && npm run dev`，用两个浏览器隐身窗口分别注册两个账号完成全流程冒烟测试。

**第九步：推送项目到 GitHub。**

```bash
git init
git add .
git commit -m "feat: our love story"
git remote add origin https://github.com/<you>/love-timeline.git
git push -u origin main
```

`.env.local` 已被 `.gitignore` 排除，不会提交。

**第十步：将 GitHub 项目导入 Vercel。** [vercel.com](https://vercel.com) → Add New Project → Import Git Repository。Framework Preset 会自动识别为 **Vite**（Build Command `npm run build`，Output Directory `dist`），无需修改。

**第十一步：在 Vercel 配置环境变量。** 项目 → Settings → Environment Variables，添加 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`（Production + Preview 都勾选）。

**第十二步：重新部署并测试线上网站。** Deployments → 最新一次 → Redeploy。打开分配的域名，确认注册、登录、上传照片正常。

**第十三步：双账号双设备共同编辑测试。** 用两部手机（或一台手机 + 一台电脑）分别登录两个账号，一方添加事件/上传照片/改寄语，另一方应自动看到更新（Realtime），或下拉刷新后看到。

> 注意：Supabase 负责数据与认证，数据库**不**放在 Vercel；前端的公开配置不能替代 RLS（RLS 才是真正的安全边界）；邮箱验证与密码重置的回调域名必须与第六步配置一致，**不要把 localhost 当生产回调**；部署前请在 Supabase 设置中确认套餐的存储配额与带宽限制。

---

## 测试清单与验证结果

> 诚实说明：本项目已完成 **生产构建验证**（`vite build` 通过）与 **代码级自查**；以下标注「✅ 已本地验证」的是构建/静态检查确认的部分。由于本环境无法访问真实的 Supabase 项目与两台真机，**数据库行为、跨设备同步与线上部署未实际执行**，需要你按上文步骤配置后用 `supabase/tests/rls_tests.sql` 和本清单验证。SQL 测试覆盖了下表中全部安全性用例。

### 账号与邀请

- [ ] 用户可以注册、登录和退出（✅ 代码已实现；需线上配置后实测）
- [ ] 刷新后会话能够恢复（persistSession）
- [ ] 创建者能够创建情侣空间（RPC `create_couple_space`）
- [ ] 创建者能够邀请另一半（仅 owner，`rls_tests.sql` 用例 E1）
- [ ] 另一半可以通过链接或邀请码加入（用例 D5）
- [ ] 过期、错误、重复使用的邀请均被拒绝（用例 D6 / D7）
- [ ] 不允许未经邀请的第三人加入（无直接 INSERT 策略 + 用例 F5）
- [ ] 非空间成员不能访问私有内容（用例 F1–F3）

### 数据与照片

- [ ] 双方都能新增、编辑和删除纪念事件（用例 H1–H3）
- [ ] 双方都能上传多张照片（上传顺序：先写事件再传照片，失败自动补偿删除已传文件）
- [ ] 图片存储在云端 Storage（数据库只存路径）
- [ ] 刷新和更换设备后可以重新读取照片（签名 URL 按需生成）
- [ ] 私有照片不会被无权限用户读取（私有 bucket + Storage RLS）
- [ ] 事件日期正确排序（`date` 字面存储 + SQL 排序）
- [ ] 删除事件后关联数据正确处理（DB 级联 + Storage 清理队列补偿）
- [ ] 同时编辑可检测覆盖冲突（`updated_at` 乐观锁，命中 0 行提示刷新）

### 安全性（全部由 `rls_tests.sql` 覆盖）

- [x] 所有业务表启用 RLS（迁移 SQL 第 9 节）
- [x] 未登录用户不能访问私有数据（用例 A1–A4）
- [x] 空间 A 的用户不能访问空间 B 的数据（用例 F1–F5）
- [x] 不能伪造 owner 身份 / 伪造 created_by（用例 F6、G1）
- [x] 普通成员不能修改角色或绕过邀请流程（`space_members` 无写策略；用例 E1、G1）
- [x] 前端没有高权限密钥（只使用 URL + publishable key；`.gitignore` 排除 `.env.local`）
- [x] Storage 策略阻止跨空间读取与删除（路径内嵌 space_id + 成员校验；用例 F7 防伪造路径）
- [x] 安全函数仅 `authenticated` 可执行、`search_path` 固定（迁移 SQL 第 3 节）

### 手机端与部署（需真机 / 线上实测）

- [ ] 320 / 375 / 390 / 430px 无横向滚动（单列时光轴、响应式网格）
- [ ] 相册上传、照片预览、编辑表单可用（触控目标 ≥ 44px、输入字号 16px）
- [ ] 深色模式切换与本地记忆
- [ ] 计时器每秒实时更新（真实时间戳差值计算）
- [ ] 时间轴滚动入场动画 / `prefers-reduced-motion` 降级
- [ ] 两台设备互见新增回忆（Realtime）
- [ ] Vercel 生产环境认证回调与静态资源正常
- [ ] README 与实际项目配置一致

---

## 常见问题

**Q：注册后收不到验证邮件？**
Supabase 免费套餐使用内置邮件服务，每小时发送量有限且可能进垃圾箱。开发期可在 Authentication → Users 手动点 Confirm；生产建议接入自定义 SMTP（Resend / SendGrid 等）。

**Q：上传照片失败提示「new row violates row-level security」？**
说明当前用户不是该空间成员（或照片路径不属于该空间）。确认已通过邀请加入同一空间，并且执行过完整迁移 SQL。

**Q：另一方修改后我没看到变化？**
Realtime 依赖 WebSocket，部分公司网络会拦截。可下拉刷新页面手动同步（每次打开页面都会全量拉取云端数据）。

**Q：如何更换背景音乐？**
「编辑我们的故事」→ 背景音乐链接，填一个 mp3 直链（需支持跨域访问）；不填则点击音乐按钮时给出提示，不会自动播放。

**Q：照片误删能恢复吗？**
不能。删除事件/照片会同步清理云端文件（如清理失败会进入待清理队列，下次启动重试，避免残留）。

**Q：邀请码安全吗？**
服务端用 `gen_random_bytes(16)`（128 位密码学随机）生成，数据库只存 SHA-256 哈希；48 小时过期、只能使用一次（行锁保证原子）、owner 可随时撤销。
