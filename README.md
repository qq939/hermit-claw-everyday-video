# 18089 EverydayVideo — Claude Ask Server

Hermit-Claw agent container 上运行的标准 Web App（Claude Ask Server）。

## 概述

本项目是平台规定的最小可用 Web 服务，对外提供 `GET /ask/claude` 接口，
将用户提问通过 `run_claude.js` 转发给上游 `claude` CLI，并把整段对话
统一写入 `logs/agent_tui.log`，便于宿主机面板下载与审计。

- 监听端口：`8082`
- 工作目录：`/home/agent/.claude/workspace/project`
- 应用代码：`18089-everydayVideo/`
- 启动脚本：`user_start.sh`（顶层）
- 日志目录：`logs/`

## 目录结构

```
/home/agent/.claude/workspace/project/
├── user_start.sh          # 顶层启动脚本（容器启动时被自动执行）
├── start.sh               # 内部入口：chmod + exec user_start.sh
├── README.md              # 本文件
├── SKILL.md               # Agent 速查手册
├── systemreadme.md        # 平台惯例（不可改）
├── run_claude.js          # 顶层：把消息转发给 claude CLI（agent_tui.log 写入点）
├── 18089-everydayVideo/   # 实际 Web App 代码
│   ├── server.js          # HTTP 服务器（端口 8082）
│   ├── run_claude.js      # 同顶层一致（应用内副本）
│   ├── lib/
│   │   ├── skill-manager.js   # 技能管理核心模块
│   │   ├── skill-ui.html      # 交互式 Skill 配置 HTML 页面
│   │   ├── comm-manager.js    # 通信管理核心模块
│   │   └── console.html       # 主控制台（对外交流页面）
│   ├── user_start.sh      # 旧版子目录启动脚本
│   ├── start.sh
│   ├── smoke.sh / smoke_verbose.sh
│   ├── lib/
│   │   ├── storyboard/    # 分镜本子系统（第 12-15 轮）
│   │   │   ├── lib.js            # 库数据模型（character/scene/prop + 版本历史）
│   │   │   ├── mount.js          # 路由（projects / items / versions / shots / pdf / obs）
│   │   │   ├── pdf.js            # 零依赖 PDF writer（CJK via Identity-H + CIDFontType0）
│   │   │   ├── font-loader.js    # NotoSansCJK TTC 解析（cmap + CFF + ToUnicode CMap）
│   │   │   ├── storyboard.html   # 三栏 UI（素材库条带 / 镜头表 / 浮动导出按钮）
│   │   │   └── console-tab.js    # 注入到 agent 控制台的 tab 入口
│   │   ├── studio/         # Studio 子系统（fal.ai 角色 + 本地海报/GIF/长文，第 9 轮）
│   │   ├── skill-manager.js   # 技能管理核心模块
│   │   ├── skill-ui.html      # 交互式 Skill 配置 HTML 页面
│   │   ├── comm-manager.js    # 通信管理核心模块
│   │   └── console.html       # 主控制台（对外交流页面）
│   ├── config/            # JSON 状态持久化
│   │   ├── comm.json / messages.json / reports.json / skills.json
│   │   ├── storyboard-projects.json / storyboard-library.json
│   │   ├── storyboard-library-versions.json / storyboard-shots.json
│   │   └── studio-characters.json / persona-directives.json / oom-watch.json
│   ├── studio-assets/     # 静态资源（生成的图片/PDF/长文等）
│   ├── AGENTS.md / BOOTSTRAP.md / HEARTBEAT.md / IDENTITY.md / SOUL.md / TOOLS.md / USER.md
│   └── systemreadme.md
├── logs/
│   ├── start.log          # user_start.sh 的输出
│   ├── run.log            # server.js / run_claude.js 的运行日志
│   └── agent_tui.log      # Claude 会话日志（面板下载用）
└── sessions/              # Claude 会话 JSONL（自动生成）
```

## 启动方式

```bash
cd /home/agent/.claude/workspace/project
./user_start.sh
```

`user_start.sh` 会：
1. 创建 `logs/` 目录；
2. `pkill -9` 杀掉旧 `server.js` / `run_claude` 进程，释放端口 8082；
3. 通过 `node` 探测端口空闲（最多重试 20 次）；
4. 在 `18089-everydayVideo/` 下 `nohup node server.js >> logs/run.log 2>&1 &`；
5. 轮询 `http://localhost:8082/health`，最多 3 秒；
6. 把启动过程的全部日志追加写入 `logs/start.log`。

## API

### `GET /health`

健康检查。返回 `200 OK`。

```bash
curl http://localhost:8082/health
```

### `GET /ask/claude?q=<文本或 base64>`

向 Claude 提问，返回纯文本回复。

- 参数 `q` 智能识别：
  - 包含空格 **或** 长度 < 50 → 当作普通字符串，`decodeURIComponent(q)`；
  - 否则 → 当作 base64 编码，`Buffer.from(q, 'base64').toString('utf8')`。
- 系统提示（拼接在用户问题前）：
  > "You are a helpful assistant. Answer the question concisely. Do not use markdown or formatting."
- 整段消息经过 `run_claude.js` → `claude --permission-mode bypassPermissions --dangerously-skip-permissions --continue --print -`。
- `run_claude.js` 使用 `shell: false` 启动 claude CLI，避免信号传递问题，并显式设置 `cwd`。
- 全部输出写入 `logs/agent_tui.log`，HTTP 响应体只回写新增片段。

示例：
```bash
curl "http://localhost:8082/ask/claude?q=你好，请介绍一下自己"
curl "http://localhost:8082/ask/claude?q=$(echo '复杂问题' | base64)"
```

错误码：
- `400` 缺少 `q` 或编码无效
- `404` 未知路由
- `500` `run_claude.js` 子进程异常退出
- `504` 超过 20 分钟硬超时

### 图文模式

`run_claude.js` 支持通过 `CLAUDE_IMG` 环境变量附加图片：

```bash
# 将图片写入项目根目录
cp /path/to/image.png /home/agent/.claude/workspace/project/tmp.png

# 通过 /ask/claude 附带图片（需 server.js 支持透传 CLAUDE_IMG）
# 或直接调用 run_claude.js：
CLAUDE_MSG=$(echo '描述这张图片' | base64 -w0) CLAUDE_IMG=1 node run_claude.js
```

`server.js` 如需支持图文模式，在 `spawn` 时设置 `CLAUDE_IMG: '1'` 环境变量即可。
图片路径默认使用项目根目录 `tmp.png`，也支持通过 `CLAUDE_IMG` 传递完整路径。

## Skill 配置中心

`GET /skill/config` 提供交互式 Web 页面，用于管理 Agent 技能。

从 [Clawra](https://github.com/SumeLabs/clawra) 项目汲取灵感，适配到 Claude Code 环境。

### 交互式 UI

打开浏览器访问 `http://localhost:8082/skill/config`，可在页面中：

| 标签页 | 功能 |
| --- | --- |
| 📦 技能列表 | 查看所有已检测技能（本地 + Claude 原生），启用/禁用/删除 |
| 🤳 Clawra Selfie | 配置 fal.ai Key，注入身份文件，测试连接 |
| ➕ 安装新技能 | 从 Git 仓库安装技能，自动注册到配置 |

### API 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/skill/config` | 交互式配置 HTML 页面 |
| `GET` | `/skill/api/status` | JSON：全部技能状态列表 |
| `GET` | `/skill/api/clawra` | JSON：Clawra 专用状态+配置模板 |
| `POST` | `/skill/api/configure` | JSON：保存技能配置（API Key 等） |
| `POST` | `/skill/api/inject` | JSON：注入技能描述到 IDENTITY.md / SOUL.md |
| `POST` | `/skill/api/install` | JSON：从 Git 仓库安装技能 |
| `POST` | `/skill/api/remove` | JSON：移除技能（清配置+删目录+移除身份注入） |

### 后端模块

`lib/skill-manager.js` 提供完整 API：

- `configureSkill(name, config, opts)` — 保存配置，自动写入 `skills/<name>/.env`
- `installSkillFromGit(repoUrl, opts)` — `git clone --depth 1` 到 `skills/` 目录
- `injectSkillToIdentity(name, desc)` — 注入到 `IDENTITY.md` / `SOUL.md`
- `getAllSkillsStatus()` — 扫描 `skills/` + `~/.claude/skills/` 所有技能

配置存储位置：`config/skills.json`

### 使用示例

```bash
# 查看所有技能状态
curl http://localhost:8082/skill/api/status

# 查看 Clawra 状态（含配置模板）
curl http://localhost:8082/skill/api/clawra

# 保存 Clawra 的 FAL_KEY
curl -X POST http://localhost:8082/skill/api/configure \
  -H "Content-Type: application/json" \
  -d '{"name":"clawra-selfie","config":{"FAL_KEY":"your_key_here"}}'

# 注入技能到身份文件
curl -X POST http://localhost:8082/skill/api/inject \
  -H "Content-Type: application/json" \
  -d '{"name":"clawra-selfie","description":"I can generate selfies via fal.ai"}'

# 从 Git 安装技能
curl -X POST http://localhost:8082/skill/api/install \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/SumeLabs/clawra"}'
```

### 关键设计

1. **交互式协作**：UI 页面上用户填入 API Key 等敏感信息，Agent 不直接操作凭据。
2. **Claude Skill 兼容**：自动扫描 `~/.claude/skills/`，与原生技能体系共存。
3. **身份注入**：技能描述写入 IDENTITY.md / SOUL.md，让 Agent 知道自己拥有哪些外部能力。
4. **完整 CRUD**：安装→配置→启用/禁用→注入→移除，全生命周期覆盖。

## Agent 控制台（对外交流页面）

`http://localhost:8082/` （或 `/console`）是对外交流页面，作为人机协作的主入口。

设计原则：先由 Agent 把页面和表单搭好，用户随后填写配置（Master 邮箱、接入点策略、工作指令等）。**邮件收发由 `email-sender` skill 提供，用户无需填 SMTP/IMAP。**

### 控制台页面

侧边栏 6 个标签页：

| 标签 | 内容 |
| --- | --- |
| 📋 总览 | 系统状态、调度信息、Mail skill 状态、最近消息、立即运行按钮 |
| 💬 消息交流 | 多线程消息板（user/agent/system），支持发送新消息 |
| 📧 邮件收发 | 主人邮箱 + Mail skill 接入点 + 探测/拉取/发测试 |
| 📊 工作报告 | 报告列表 + 详情面板 |
| ⚙️ 工作设置 | 调度间隔、首次运行时间、工作指令 |
| 🎯 技能配置 | 跳转 `/skill/config`（独立页面） |

### API 接口（控制台）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/console` 或 `/` | 控制台 HTML 页面 |
| `GET` | `/api/comm/status` | JSON：综合状态（mail / mailSkill / schedule / messages / reports） |
| `GET` | `/api/comm/messages` | JSON：所有消息 |
| `GET` | `/api/comm/thread?name=X` | JSON：线程 X 的消息 |
| `POST` | `/api/comm/messages` | JSON：发送消息 |
| `POST` | `/api/comm/email-config` | JSON：保存邮件配置（新 schema：`target` + `mailEndpoint` + `fetchLimit` + `fetchDays` + `autoReply`） |
| `POST` | `/api/comm/mail-probe` | JSON：探测 mail skill 接入点连通性 |
| `POST` | `/api/comm/mail-fetch` | JSON：拉取最新收件（直接调 `email-sender` skill） |
| `POST` | `/api/comm/mail-test` | JSON：发送测试邮件（直接调 `email-sender` skill） |
| `POST` | `/api/comm/schedule` | JSON：保存调度设置 |
| `POST` | `/api/comm/instructions` | JSON：保存工作指令 |
| `POST` | `/api/comm/run-now` | JSON：手动触发工作流 |
| `GET` | `/api/comm/reports` | JSON：报告列表 |

### 后端模块

`lib/comm-manager.js`：

- 通信配置（`config/comm.json`）：`mail.target`、`mailEndpoint`、`schedule`、`workInstructions`
- 消息板（`config/messages.json`）：按线程组织，支持 user/agent/system 角色
- 工作报告（`config/reports.json`）：工作流产出物
- `runWorkflow()`：每日工作流主循环

### Mail-via-Skill 邮件链路

邮件收发由 **Tools 知识库**（`http://host.docker.internal:18081/api/tools`）登记的 **email MCP 服务** 承担，端口 `18001`。本项目**不**直接做 SMTP/IMAP，而是 HTTP 调用该 MCP：

| MCP 端点 | 用途 | 调用方式 |
| --- | --- | --- |
| `GET /` | 服务信息 + 白名单 | `pickMailEndpoint()` 首选 `http://host.docker.internal:18001`，失败回退 `http://localhost:18001` |
| `GET /allowed-senders/` | 白名单发件人列表 | 在 `runWorkflow()` 中调用以记录 `mail.allowedSenders` |
| `GET /emails/?limit=X&days=Y` | 拉取白名单发件人邮件（**带尾斜杠**） | `fetchInbox()`，结果导入消息板 `thread=email-inbox` |
| `POST /send-email/` | 发送邮件（**带尾斜杠**） | `sendMailViaSkill()`，每日报告调用一次 |

#### 端口来源

第 7 轮发现：Master 提示 "有邮件 skill，有邮件 mcp" 后访问 `:18081`（Tools 知识库）查 `GET /api/tools`：

```json
{
  "items": [
    {"name": "obs",  "port": 18000, "display_name": "OBS 图床", ...},
    {"name": "email","port": 18001, "display_name": "Email 邮件",
     "description": "SMTP 发信 + IMAP 收件查询服务，支持白名单过滤、附件发送",
     "doc_md": "... GET /emails/?limit=5&days=3 | POST /send-email/ ..."}
  ]
}
```

容器内 `dimond.top` 域名解析不通，但 `host.docker.internal:18001` 直连可达（白名单 `939342547@qq.com / 1119623207@qq.com / jiangjimjim@gmail.com`）。

#### 端点尾斜杠

实测两点关键细节，否则会触发 307 重定向：

```bash
$ curl -sS -o /dev/null -w "%{http_code}\n" http://host.docker.internal:18001/emails/?limit=5
200
$ curl -sS -o /dev/null -w "%{http_code}\n" http://host.docker.internal:18001/emails?limit=5
307   # 不带尾斜杠 → 重定向
```

代码内已统一为 `/emails/?` / `/send-email/` 带尾斜杠形态。

### 每日工作流

1. **探测 mail skill** → `pickMailEndpoint()` 解析首选/兜底
2. **拉取收件** → 通过 skill `GET /emails` → 去重后导入消息板 `thread=email-inbox`
3. **汇总 actionable items** → 邮件 + 消息板未处理 user 消息
4. **生成报告** → 写入 `config/reports.json`
5. **发送报告** → 通过 skill `POST /send-email` 到 `cfg.mail.target`
6. **标记已处理** → 更新 `lastRun` / `nextRun`

调度器在 `server.js` 末尾，60 秒一检查；满足 `now - lastRun >= intervalHours` 触发 `runWorkflow()`。

### 关键设计

1. **人机协作优先**：用户只需填一个 `主人邮箱` + 选个接入点策略（`auto/remote/local`），其余由 `email-sender` skill 接管。
2. **零凭据原则**：旧的 SMTP/IMAP 表单已彻底移除。用户**永远不需要**把邮箱密码填进 8082 — 凭据归 skill。
3. **降级优雅**：mail skill 不可达时 `runWorkflow()` 仍然能跑（生成报告、记录 actionable），只把 `mailResult.ok=false` 写入日志与消息板。
4. **消息持久化**：所有消息、报告、配置均落盘到 `config/*.json`，容器重启不丢失。
5. **角色标记**：user / agent / system 三角色消息，便于后续多 Agent 协作时区分子代理。
6. **调度内嵌**：调度器直接挂载在 server 进程内，无需 systemd / crontab，避免容器内权限问题。
7. **Legacy 兼容**：`getCommConfig()` 检测到旧 `email` / `secretsConfigured` 字段会主动丢弃，确保新代码不会因历史配置崩溃。

## 分镜本子系统（Storyboard）

`http://localhost:8082/studio/storyboard` 是 Master 的"新媒体策划官"主入口（第 12-15 轮构建）。
本子系统同时在 Agent 控制台 `/console` 的「🎬 分镜本」tab 暴露入口。

### 三栏布局

| 区域 | 内容 |
| --- | --- |
| **素材库条带（顶部）** | 类型过滤 `全部 / 人物 / 场景 / 道具`；每张卡显示正视图 + 名字 + 类型 + 当前版本号。**单击**选中并加入当前选中镜头；**双击**进入三视图编辑器。 |
| **镜头表（中部）** | 每行：`时间 In→Out / 人物形象 chips / 场景 chips / 道具 chips / 文本描述 / 备注 / 版本号 v?`。点击行选中，再点上方素材卡自动绑定；chip 右上角 `×` 删除；上下箭头调顺序。 |
| **导出按钮（右下角浮动）** | `⬇ 导出 PDF → OBS` 主按钮 + 状态文字 + 最近 50 条导出（本地下载链接 + `obsKey`）+ `⚙ OBS 设置` 子按钮。FAB 锚到页面右下角，不挤占镜头表。 |

### 素材编辑器（双击素材卡弹出）

- **顶部版本条**：单击载入；**双击 = 设为当前**，丢弃其后续所有版本（drop-after-promote）
- **三视图（正/侧/背）**：每视图独立 `📁 上传 / ☁️ OBS 列表 / 🎲 自动生成(fal.ai) / × 清空` + 独立改进意见 textarea
- **`保存为新版本`** 从选中版本分支新版本号（v1 → v2 → v3）

### 多项目隔离（第 13 轮）

库不是单项目视角，而是 `config/storyboard-projects.json` 注册多个项目；item / version / shot 全部带 `projectId`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/storyboard/projects` | 列出所有项目 |
| `POST` | `/api/storyboard/projects` | 新建项目（自动生成 slug） |
| `PATCH` | `/api/storyboard/projects/:id` | 改名 / 改 slug |
| `DELETE` | `/api/storyboard/projects/:id` | 级联删除项目下所有素材/版本/镜头 |
| `GET` | `/api/storyboard/state?projectId=` | 按项目过滤返回 items / versions / shots |

`ensureDefaultProject()` 在 state 端点首次命中时把既有数据迁移到「噜噜的天空 / lulu_sky」。

### OBS 平面命名

OBS 上传默认用项目名（slug）做平面：

```
旧：storyboard/exports/storyboard-1785924884170.pdf
新：hermit-claw_lulu_sky_exports_storyboard-1785924884170.pdf
```

格式：`<bucket>_<projectSlug>_<filename>`，`/` 与危险字符全部替换为 `_`。

### PDF 导出（第 14-15 轮）

`POST /api/storyboard/export-pdf`：

1. 调用 `renderStoryboardPdf()` 生成 PDF Buffer
2. 上传到 OBS（默认 endpoint `http://obs.dimond.top`，endpoint 可在 `⚙ OBS 设置` 子按钮里覆盖）
3. 落 `cfg.exports[]`（最近 50 条），含 `at / obsKey / localPath / status`
4. 返回 `{ ok, obsKey, localPath, sizeBytes }`

PDF 格式：

- **封面页**：项目名 + 角色/场景/道具 roster（每行带版本号）
- **每镜头一页**：标题 / 时间码 / Cast / Scene / Props / Description / Notes / visual placeholder 框

PDF 内嵌字体走 **Identity-H + CIDFontType0 + CFF**，从 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` 解析 CFF + cmap + hmtx，构造 `ToUnicode CMap`，支持 CJK + ASCII 混排，pypdf 可正常提取中文文本。

零依赖：纯 Node.js 内置（`fs` / `zlib` / `path`），无 pdfkit / jspdf，符合 228MB cgroup 限制。

### 关键设计

1. **同构数据模型**：character / scene / prop 共用一张 `items` 表，通过 `kind` 字段区分；版本历史统一存 `library-versions.json`，引用 `itemId`
2. **drop-after-promote**：设某旧版本为"当前"时，自动删除其后所有版本（避免乱）
3. **chip 复用**：镜头表的 cast / scene / prop 槽都用同一套 `<Chip x>` 组件，操作统一
4. **多项目命名空间**：项目是顶层维度，所有 API 入参都接受 `projectId`，避免误串
5. **FAB 而非 inline 按钮**：导出区一开始占了整条 bottom bar，挤掉镜头表；改 FAB 后镜头表能占满剩余空间
6. **CJK PDF 复用系统字体**：不下载额外字体，直接读 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`，18MB 的 CFF 一次性 embed

## 关键设计

1. **不直接调用 `claude` CLI**：`server.js` 通过 `spawn('node', [run_claude.js], ...)` 转发，
   避免在 `/ask/claude` 内使用 `sh -c 'claude ...'` 等不安全形态。
2. **统一日志写入**：`run_claude.js` 是 `logs/agent_tui.log` 的唯一写入点，
   `server.js` 通过文件大小偏移量读取"自本次请求以来"的新增片段作为响应。
3. **5 秒响应窗口**：平台规则 §9 要求 `agent_tui.log` 在调用后 5 秒内出现新内容；
   `server.js` 以 100ms 间隔轮询 log，达到 `RESPONSE_WAIT_MS=5000ms` 后立即返回。
4. **超时兜底**：20 分钟硬超时 → `SIGTERM`，再 5 秒后 `SIGKILL`。
5. **端口探测**：用 `node net.createServer()` 主动 bind 8082 验证空闲，
   避免 `EADDRINUSE`。
6. **`run_claude.js` 图文模式**：通过 `CLAUDE_IMG` 环境变量注入图片路径，
   使用 `file://` 引用而非 base64，避免消息体积膨胀。
7. **`shell: false`**：`run_claude.js` 以 `shell: false` spawn claude CLI，
   避免 shell 包装导致的信号传递问题。
8. **`--permission-mode`**：使用 `bypassPermissions` 模式，阻止 plan mode 弹窗。

## 日志约定（来自 systemreadme.md §二）

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `logs/start.log` | `user_start.sh` | 启动过程日志 |
| `logs/run.log`   | `server.js` / `run_claude.js` | 服务端 stdout/stderr |
| `logs/agent_tui.log` | `run_claude.js` | Claude 会话日志（面板下载） |
| `logs/server.pid` | `user_start.sh` | 当前 server.js PID |

## Git 工作流

每个会话结束后：
```bash
git add .
git commit -m "<变更描述>"
echo "$(git rev-parse --short HEAD) <变更描述>" >> logs/commit.txt
```
`.gitignore` 必须忽略 `logs/`、`node_modules/`、`*.log`、`__MACOSX/` 等。

## 当前状态

- ✅ `user_start.sh` 已创建并具备可执行权限
- ✅ Web App 在 `:8082` 运行中（pid 见 `logs/server.pid`）
- ✅ `/health` 返回 200
- ✅ `logs/start.log` 包含本次启动全过程
- ✅ `run_claude.js` 支持图文模式（`CLAUDE_IMG` 环境变量）
- ✅ `run_claude.js` 使用 `shell: false` + `--permission-mode` 改进进程管理
- ✅ `18089-everydayVideo/run_claude.js` 已同步至最新版
- ✅ Skill 配置中心已在 `:8082/skill/config` 上线
- ✅ `lib/skill-manager.js` 支持技能安装/配置/注入/启用/移除全生命周期
- ✅ 从 [Clawra](https://github.com/SumeLabs/clawra) 汲取设计，提供 Clawra Selfie 一键配置
- ✅ 检测到 30+ 个 Claude 原生技能，支持 Web UI 管理
- ✅ Agent 控制台（对外交流页面）已在 `:8082/console` 上线
- ✅ `lib/comm-manager.js` 实现消息板、邮件配置、报告、调度
- ✅ 每日工作流 `runWorkflow()` + 内嵌调度器（60s tick）已就绪
- ✅ 邮件收发由 **Tools 知识库**（18081）登记的 **email MCP** 承担（端口 18001）
- ✅ `host.docker.internal:18001` 已连通：`/emails/` `/send-email/` `/allowed-senders/` 全部 200
- ✅ 实测发送邮件成功：`{"success":true,"message":"Email sent successfully to master@example.com"}`
- ✅ 控制台「邮件收发」标签页：主人邮箱 + 接入点 + 探测/拉取/发测试 按钮
- ✅ 旧的 SMTP/IMAP 表单已移除 — 用户无需填任何凭据
- ✅ 分镜本子系统 `http://localhost:8082/studio/storyboard` 上线（第 12 轮）
- ✅ 分镜本加 projects 隔离 + OBS 平面命名 `bucket_project_filename`（第 13 轮）
- ✅ 修 PDF 空白（Pages dict 自覆盖 / 字体引用 / chips 数据模型）+ 导出改右下角 FAB（第 14 轮）
- ✅ PDF 支持 CJK：Identity-H + CIDFontType0 + CFF + ToUnicode CMap；pypdf 可正常提取中文（第 15 轮）