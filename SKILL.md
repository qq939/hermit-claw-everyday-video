# SKILL.md — Agent 速查手册

本文件是 Agent 在容器内日常运维本项目的速查表。

## 一、目录速记

| 路径 | 用途 |
| --- | --- |
| `/home/agent/.claude/workspace/project` | 工作根目录 |
| `./user_start.sh` | 顶层启动脚本（容器启动时被自动执行） |
| `./18089-everydayVideo/` | Web App 实际代码 |
| `./logs/start.log` | `user_start.sh` 输出 |
| `./logs/run.log` | `server.js` / `run_claude.js` 运行日志 |
| `./logs/agent_tui.log` | Claude 会话日志（面板下载） |
| `./logs/server.pid` | 当前 server.js PID |
| `./18089-everydayVideo/lib/skill-manager.js` | 技能管理核心模块 |
| `./18089-everydayVideo/lib/skill-ui.html` | 交互式技能配置页面 |
| `./18089-everydayVideo/lib/comm-manager.js` | 通信管理核心模块 |
| `./18089-everydayVideo/lib/console.html` | Agent 控制台（对外交流页面） |
| `./18089-everydayVideo/config/skills.json` | 技能配置存储文件 |
| `./18089-everydayVideo/config/comm.json` | 通信配置（邮件/调度/Master 邮箱） |
| `./18089-everydayVideo/config/messages.json` | 消息板数据 |
| `./18089-everydayVideo/config/reports.json` | 工作报告数据 |
| `./systemreadme.md` | 平台惯例，**只读参考** |

## 二、常用命令

```bash
# 启动
./user_start.sh

# 停止
pkill -9 -f "node .*server\.js"
pkill -9 -f "node .*run_claude"

# 健康检查
curl -sS http://localhost:8082/health

# 调用 Claude（普通）
curl "http://localhost:8082/ask/claude?q=你好"

# 调用 Claude（base64，避免 URL 转义）
curl "http://localhost:8082/ask/claude?q=$(echo '复杂问题' | base64 -w0)"

# 图文模式（直接调用 run_claude.js）
CLAUDE_MSG=$(echo '描述这张图片' | base64 -w0) CLAUDE_IMG=1 node run_claude.js

# 看实时运行日志
tail -f logs/run.log
tail -f logs/agent_tui.log

# 看本次启动日志
tail -f logs/start.log

# Skill 配置
curl http://localhost:8082/skill/api/status                    # 列出所有技能
curl http://localhost:8082/skill/api/clawra                    # Clawra 专用状态
curl -X POST http://localhost:8082/skill/api/configure \       # 保存技能配置
  -H "Content-Type: application/json" \
  -d '{"name":"clawra-selfie","config":{"FAL_KEY":"xxx"}}'

# 控制台与消息板
curl http://localhost:8082/                                    # 主控制台（页面）
curl http://localhost:8082/api/comm/status                     # 综合状态
curl http://localhost:8082/api/comm/thread?name=general         # 线程消息
curl -X POST http://localhost:8082/api/comm/messages \         # 发送消息
  -H "Content-Type: application/json" \
  -d '{"role":"user","content":"你好","thread":"general"}'
curl -X POST http://localhost:8082/api/comm/email-config \     # 保存邮件配置（新 schema）
  -H "Content-Type: application/json" \
  -d '{"target":"master@example.com","mailEndpoint":"auto","fetchLimit":10,"fetchDays":7,"autoReply":true}'
curl -X POST http://localhost:8082/api/comm/mail-probe         # 探测 mail skill
curl -X POST http://localhost:8082/api/comm/mail-fetch         # 拉取最新收件
curl -X POST http://localhost:8082/api/comm/mail-test \        # 发测试邮件
  -H "Content-Type: application/json" -d '{"to":"master@example.com"}'
curl -X POST http://localhost:8082/api/comm/run-now            # 手动触发工作流
```

## 三、故障排查（Cheat-sheet）

| 现象 | 排查命令 | 常见原因 |
| --- | --- | --- |
| `EADDRINUSE 8082` | `pkill -9 -f server.js && sleep 1` | 旧进程未释放端口 |
| `/health` 502/超时 | `curl -v http://localhost:8082/health`、`tail logs/run.log` | server.js 未启动 / Node 异常 |
| `/ask/claude` 500 | `tail -50 logs/run.log logs/agent_tui.log` | `run_claude.js` 子进程非 0 退出 |
| `/ask/claude` 504 | `tail logs/run.log` | 超过 20 分钟硬超时 |
| 响应体空 | `ls -la logs/agent_tui.log`、`tail logs/run.log` | `claude` CLI 不可用 / 未注入 token |
| 启动时找不到 `run_claude.js` | `ls 18089-everydayVideo/run_claude.js` | 启动脚本 `cwd` 不对，应在 `18089-everydayVideo/` 下执行 |
| `MODULE_NOT_FOUND run_claude.js` | `node -e "require('./18089-everydayVideo/run_claude.js')"` | 路径错误或文件缺失 |
| 图文模式图片不显示 | `CLAUDE_IMG=1 node run_claude.js` 先测直接调用 | `tmp.png` 不存在 / 路径不对 |
| `/ask/claude` 504 超时 | `tail logs/run.log` | 超过 20 分钟硬超时 |
| `/skill/config` 404 | `curl -sS http://localhost:8082/health` | server.js 版本旧，未包含 skill 路由 |
| 技能注入未生效 | `cat IDENTITY.md \| grep "skill:"` | IDENTITY.md 不存在或注入失败 |
| Clawra 安装失败 | `curl -sS http://localhost:8082/skill/api/clawra` | Git 不可用 / 网络不通 / URL 错误 |
| 技能配置丢失 | `cat config/skills.json` | config/ 目录被清理或文件损坏 |
| `/console` 404 | `curl -sS http://localhost:8082/health` | server.js 版本旧，未包含 console 路由 |
| 控制台发消息失败 | `curl http://localhost:8082/api/comm/status` | 消息板文件损坏 / 权限问题 |
| 调度不触发 | `tail logs/run.log \| grep scheduler` | lastRun / intervalHours 配置错误 |
| 报告没生成 | `curl -X POST http://localhost:8082/api/comm/run-now` | `runWorkflow()` 异常，检查 run.log |
| mail skill 不可达 | `curl -X POST http://localhost:8082/api/comm/mail-probe` | host.docker.internal:18001 / localhost:18001 都连不通 → 工作流仍能跑，只是 mailResult=false |
| mail 端点 307 redirect | `curl -i http://host.docker.internal:18001/emails?limit=5` | 没带尾斜杠；正确写法 `/emails/?limit=5` |
| mailport 5030 用错 | `curl -sS http://host.docker.internal:18081/api/tools \| jq .items[1].port` | 应是 18001（18081 知识库登记），不是 5030 |
| `/api/comm/email-config` 报 missing to | `curl /api/comm/status \| jq .mail` | 配置没保存 `target` 字段 |
| 控制台邮件面板空白 | `curl http://localhost:8082/api/comm/status` | server.js 没包含新 mail-* 路由（v6 前代码） |

## 四、修改代码的注意点

1. **永远不要让 `server.js` 直接 `spawn('claude', ...)`**：
   必须经过 `run_claude.js`，否则对话不会进入 `logs/agent_tui.log`，
   面板的日志下载会断裂（违反 systemreadme.md §十四）。
2. **`run_claude.js` 是 `agent_tui.log` 的唯一写入者**：
   不要在 `server.js` 中 `appendFile` 到该文件，否则会污染 `readNewLogPortion()` 的偏移量。
3. **响应超时 5 秒**（systemreadme.md §十四隐含要求）：
   `RESPONSE_WAIT_MS` 必须保留，`POLL_MS=100` 不要拉太大。
4. **不要用 `sh -c`**：所有 spawn 直接传 argv，避免命令注入。
5. **systemreadme.md 不可改**：它是平台规范，改了也不会被采纳。
6. **`run_claude.js` 的两个副本要保持同步**：
   - 顶层 `run_claude.js`：直接使用 `claude` CLI 的场景
   - `18089-everydayVideo/run_claude.js`：`server.js` 实际引用的版本
   - 更新时两侧都改。当前已支持 `CLAUDE_IMG` 图文模式。
7. **`run_claude.js` 使用 `shell: false`**：不要改回默认 `shell: true`，
   否则 `SIGTERM`/`SIGKILL` 信号无法正确传递到 `claude` 子进程。
8. **`--permission-mode bypassPermissions`**：防止 Claude 进入 plan mode 交互弹窗。
9. **`logs/commit.txt` 取代 `commit.txt`**：提交记录写入 `logs/commit.txt`（平台规范）。
10. **logs 目录不可删**（systemreadme.md §九）：是 bind mount，删除会 `Device or resource busy`。
11. **Skill 路由位置**：`server.js` 中 `/skill/*` 路由位于 `/ask/claude` 之后、`404` 之前。
12. **`lib/skill-manager.js` 的 JSON body 解析**：`parseJSONBody` 函数只支持 JSON；POST 请求必须设 `Content-Type: application/json`。
13. **身份注入覆盖**：`injectSkillToIdentity()` 使用 `<!-- skill:<name> -->` marker 标记块，多次调用同一技能会**替换**而非追加。
14. **Clawra 的 `skill.json`**：如果要从 Git 安装 Clawra，确保仓库根目录下有 `skill.json`，否则 `configSchema` 不会自动填充。
15. **控制台路由优先级**：`server.js` 中 `/console`（页面）、`/api/comm/*` 位于 `/skill/*` 之后、`404` 之前。
16. **Mail-via-Skill**：本项目**不**直接做 SMTP/IMAP，而是 HTTP 调用 **Tools 知识库**（`http://host.docker.internal:18081/api/tools`）登记的 **email MCP**（端口 `18001`）。容器内首选 `http://host.docker.internal:18001`，兜底 `http://localhost:18001`。`pickMailEndpoint()` / `fetchInbox()` / `sendMailViaSkill()` 三件套见 `lib/comm-manager.js`。
17. **零凭据原则**：用户**永远不需要**把邮箱密码填进 8082。SMTP/IMAP 凭据归 email MCP；本项目只暴露 `target`（收件人）+ `mailEndpoint` 策略。
18. **mail skill 优雅降级**：`runWorkflow()` 在 skill 不可达时仍然跑完，生成报告 + 记录 actionable，只把 `mailResult.ok=false` 写日志 / 消息板。
19. **mail 端点尾斜杠**：实测 `host.docker.internal:18001` 的 `/emails/` / `/send-email/` 必须**带尾斜杠**（200），不带尾斜杠返回 307 重定向。代码内已统一为带尾斜杠形态，不要改回去。
20. **邮件 UUID 配对**：每封 Agent 报告邮件都被打上 `[HC-<hex16>]` UUID（subject + body 双重标记）。Master 回复时把这个 token 抄回主题或正文首行即可；`runWorkflow()` 通过 `extractMailUUID()` 识别哪些邮件是"对 Agent 报告的回复"，**自动**写到消息板 `meta.isMasterReply=true`、`meta.replyToUUID=HC-...`。Agent 后续工作只看 Master 标记的回复即可，避免重复读取。
21. **小时级调度**：默认 `intervalHours=1`（每小时一次），可通过 `POST /api/comm/schedule {"intervalHours":24}` 调成每天一次。调度器 60 秒一查（`setInterval(scheduleTick, 60s)`），满足 `now - lastRun >= intervalHours` 触发 `runWorkflow()`。
22. **节流日志**：`appendRunLog(line, { always })` 默认 5 秒内只写一次（防 OOM 旧问题）；`always: true` 强制写（用于 scheduler / uncaughtException / mail 失败）。
23. **崩溃兜底**：`server.js` 启动时注册 `process.on('uncaughtException')` 与 `'unhandledRejection')` 兜底并写日志，避免 transient fetch 失败把整个 server kill 掉（这是 OOM 的根因）。
24. **调度器时区**：`scheduleTick()` 用 `Date.now()` 与 `lastRun` 比较；`computeNextRun(sched)` = `lastRun + intervalHours * 3600 * 1000`。
25. **消息板与报告持久化**：`config/messages.json` / `config/reports.json` 单文件落盘，长时间使用建议定期归档，避免单文件过大。
26. **用户填配置原则**：所有控制台表单提交都走 JSON POST；前端 `fetch` 必须带 `Content-Type: application/json`。
27. **Legacy 兼容**：`getCommConfig()` 主动丢弃老 `email` / `secretsConfigured` 字段，缺 `mail` 时回填默认结构。即使服务器升级前留下的 `comm.json` 也不会让新代码崩溃。

## 五、启动脚本契约

`user_start.sh` 退出时必须满足：
- 进程已 `nohup` 启动；
- `logs/server.pid` 已写入；
- `logs/start.log` 已追加本轮日志；
- 至少要尝试过 `/health` 探测（成功/失败都要记录）。

任何修订都应保留这些保证，否则面板可能误判为"未启动"。

## 六、Git 提交规范

```bash
cd /home/agent/.claude/workspace/project
git add .
git commit -m "<动词> <对象>：<一句话说明>"
echo "$(git rev-parse --short HEAD) <commit_title>" >> logs/commit.txt
```

`.gitignore` 至少包含：
```
logs/
node_modules/
*.log
__MACOSX/
.DS_Store
```

## 七、对外端口

- 容器内：`8082`
- 宿主机映射：`18081-19999` 范围内（具体由平台分配）

## 八、上游 / 下游依赖

- `claude` CLI：必须可用，`which claude` 应有路径。
- Node.js v20+：项目 `server.js` 使用 `http`、`net`、`child_process`、`fs`、`crypto`、`path` 等内置模块。
- `ANTHROPIC_DISABLE_PREFLIGHT=1`：在 `server.js` 与 `run_claude.js` 中都设置了。
- Supabase（可选）：详见 systemreadme.md §十三，需要时按文档安装 `@supabase/supabase-js @supabase/ssr`。

## 九、会话变更记录

### 2026-07-10（第 1 轮）
- ❌ 首次启动尝试：`run_claude.js` 路径不对 → `MODULE_NOT_FOUND`，无 `user_start.sh`
- ❌ "启动起来啊"：Claude 不熟项目，反问用户"想要启动什么项目"，未解决问题

### 2026-07-12（第 2 轮）
- ✅ 新增 `user_start.sh`（顶层）：杀掉旧进程、探测 8082、`nohup` 启动 server.js、轮询 `/health`、追加 `logs/start.log`。
- ✅ Web App 成功启动在 `:8082`，`/health` 返回 200
- ✅ 新增 `README.md`：项目结构 / API / 设计要点 / 当前状态。
- ✅ 新增 `SKILL.md`：日常运维速查表。

### 2026-07-30（第 3 轮）
- ✅ `run_claude.js` 升级：新增图文模式（`CLAUDE_IMG` 环境变量）
- ✅ `run_claude.js` 升级：`shell: false` + `--permission-mode bypassPermissions`
- ✅ `18089-everydayVideo/run_claude.js` 同步至最新版
- ✅ Web App 重启，`/health` 200
- ✅ `README.md` 更新：图文模式说明、新设计要点、`logs/commit.txt` 路径修正
- ✅ `SKILL.md` 更新：图文命令、新故障排查项、新增代码注意点、会话历史

### 2026-07-30（第 4 轮）
- ✅ 汲取 [Clawra](https://github.com/SumeLabs/clawra) 设计，创建 Skill 配置中心
- ✅ 新建 `lib/skill-manager.js`：技能安装/配置/注入/启用/移除全生命周期
- ✅ 新建 `lib/skill-ui.html`：交互式 Web 配置页面（4 个标签页）
- ✅ `server.js` 扩展：新增 7 个 `/skill/*` 路由（1 个页面 + 6 个 JSON API）
- ✅ 检测到 30+ 个 Claude 原生技能，支持 Web UI 一键管理
- ✅ `config/skills.json` 作为配置持久化文件
- ✅ 身份注入系统：技能描述写入 IDENTITY.md / SOUL.md
- ✅ Web App 重启，所有 API 端点已验证通过
- ✅ `README.md` 更新：Skill 配置中心文档
- ✅ `SKILL.md` 更新：新增技能管理命令/故障项/代码注意点

### 2026-08-03（第 5 轮）
- ✅ 收到 Master 指令："8082就是你的对外交流页面，你想要什么东西就先把页面设计出来等我填"
- ✅ 后续追加："你不用自己收发邮件，有收发邮件的mcp服务器的" → IMAP/SMTP 改为占位，真实收发由外部 mail MCP 承担
- ✅ 新建 `lib/comm-manager.js`：消息板 / 邮件配置 / 报告 / 调度 全栈管理
- ✅ 新建 `lib/console.html`：主控制台（侧栏 6 标签页），含 总览 / 消息交流 / 邮件配置 / 工作报告 / 工作设置 / 技能配置
- ✅ `server.js` 扩展：新增 10 个 `/console` + `/api/comm/*` 路由（含 9 个 JSON API）
- ✅ `server.js` 末尾新增内嵌调度器：`setInterval(scheduleTick, 60s)`，满足 `now - lastRun >= intervalHours` 触发 `runWorkflow()`
- ✅ 持久化文件落地：`config/comm.json`、`config/messages.json`、`config/reports.json`
- ✅ `runWorkflow()` 完整流程：读消息板 → 查邮箱（占位） → 汇总 actionable → 生成报告 → 发邮件（占位） → 标记已处理 → 更新 lastRun / nextRun
- ✅ `README.md` 更新：Agent 控制台章节 + 关键设计 + 当前状态
- ✅ `SKILL.md` 更新：新增 comm-* 文件路径、控制台命令、4 项新故障排查、5 项新代码注意点、第 5 轮会话历史
- ✅ Web App 全端点验证：`/health` `/console` `/api/comm/status` 均 200

### 2026-08-03（第 6 轮）
- ✅ Master 反馈："还填写个毛线，有邮件收发mcp啊" → 不让用户填 SMTP/IMAP
- ✅ `lib/comm-manager.js` 重写：移除所有 SMTP/IMAP user-fillable 字段；新增 `pickMailEndpoint()` / `fetchInbox()` / `sendMailViaSkill()` 调用 `email-sender` skill（首选 `http://dimond.top:5030`，兜底 `http://localhost:5030`）
- ✅ `MAIL_API_PREFERRED` / `MAIL_API_LOCAL` 常量 + `httpJSON()` 通用 fetch 帮手
- ✅ `config/comm.json` schema 改为 `{ mail: { target, autoReply, fetchLimit, fetchDays }, mailEndpoint, mailEndpointResolved, schedule, workInstructions }`
- ✅ `getCommConfig()` 主动丢弃旧 `email` / `secretsConfigured` 字段，缺 `mail` 时回填默认（Legacy 兼容）
- ✅ `server.js` `/api/comm/email-config` 路由：接受新 schema `target/mailEndpoint/fetchLimit/fetchDays/autoReply`
- ✅ `server.js` 新增 3 个路由：`/api/comm/mail-probe`（探测）、`/api/comm/mail-fetch`（拉取收件）、`/api/comm/mail-test`（发测试邮件）
- ✅ `lib/console.html` 重构「邮件收发」标签页：移除 SMTP/IMAP 表单；新增 主人邮箱 + 接入点（auto/remote/local） + 拉取条数/天数 + 探测/拉取/测试按钮 + Mail Skill 状态面板 + 收件预览
- ✅ 旧 `comm.json`（含 `email`/`smtp`/`imap`/`masterEmail`/`secretsConfigured`）已清空，新 schema 重新生成
- ✅ 全端点验证：`/health` 200、`/api/comm/status` 含 `mail/mailSkill/mailEndpointResolved`、`/api/comm/email-config` POST 返回新 schema、`/api/comm/mail-probe`/`mail-fetch`/`mail-test` 均正确响应（skill 不可达时 graceful error）
- ✅ `README.md` 更新：API 表 + Mail-via-Skill 链路 + 关键设计（7 条）+ 当前状态（+2 行）
- ✅ `SKILL.md` 更新：3 个新 curl 命令 + 3 个新故障排查 + 6 个新代码注意点（Mail-via-Skill / 零凭据 / 优雅降级 / 调度时区 / 持久化 / 用户填配置 / Legacy 兼容）+ 第 6 轮会话历史

### 2026-08-03（第 7 轮）
- ✅ Master 提示："有邮件skill，有邮件mcp，不用你自己部署。你去问问18081"
- ✅ 探测 `:18081` → **Tools 知识库**，`GET /api/tools` 返回工具目录：
  - `obs`   → port 18000（OBS 图床）
  - `email` → **port 18001**（Email 邮件，SMTP 发信 + IMAP 收件，白名单过滤）
- ✅ 容器内 `dimond.top:18001` 不通；`host.docker.internal:18001` 直连可达
- ✅ `lib/comm-manager.js` 更新 `MAIL_API_PREFERRED = 'http://host.docker.internal:18001'`（替代旧 `dimond.top:5030`）
- ✅ `lib/comm-manager.js` 更新 `MAIL_API_LOCAL = 'http://localhost:18001'`（替代旧 `localhost:5030`）
- ✅ 端点尾斜杠修正：`/emails` → `/emails/`，`/send-email` → `/send-email/`（否则 307 重定向）
- ✅ 实测连通：
  - `GET /`        → `{"message":"Welcome to Email Service API","allowed_senders":[...]}`
  - `GET /allowed-senders/` → `{"allowed_senders":["939342547@qq.com","1119623207@qq.com","jiangjimjim@gmail.com"]}`
  - `GET /emails/`  → `[]`（空收件箱）
  - `POST /send-email/` to=`master@example.com` → `{"success":true,"message":"Email sent successfully to master@example.com"}`
- ✅ 工作流跑通：`/api/comm/run-now` → `mailResult.ok=true`，`endpoint=http://host.docker.internal:18001`
- ✅ `README.md` 更新：Mail-via-Skill 链路部分（端口来源 + 尾斜杠说明 + 知识库 JSON 示例）
- ✅ `SKILL.md` 更新：3 个新故障排查（307 redirect / port 5030 vs 18001 / host.docker.internal）、1 个新代码注意点（尾斜杠必带）+ 第 7 轮会话历史

### 2026-08-04（第 8 轮 — 当前）
- ✅ Master 反馈："为啥把对话 kill 了？日志造成 OOM？做一个定时调度的任务啊。crontab。写入日志不就行了？改成每个小时读一次邮件吧，省的错过我的指令,你看一下有没有针对你的邮件回复（你发的邮件都有 UUID 的）。真正的邮件服务器不是 18081,我是让你查询 18081 找到真正的服务器,真正的服务器是 18000"
- ✅ 解释 `Killed` 是 Linux OOM killer（不是 Master 主动 kill）；`run-now` 频繁触达 + 大量 fetch awaiting 时撞内存上限
- ✅ **18000 探测**：18081 /api/tools 现返回 `{"items":[]}`，18000 是 OBS 文件托管（无邮件接口），18001 才是真正邮件 MCP（保留上一轮 18001 端点）
- ✅ **小时级调度**：`getCommConfig()` 默认 `schedule.intervalHours=1`（替代 24），`mail.fetchDays=1` / `fetchLimit=20`（轻量轮询）
- ✅ **邮件 UUID 配对**：
  - 新增 `newMailUUID()` / `tagSubject()` / `tagBody()` / `extractMailUUID()` 帮手
  - 每封 Agent 报告邮件 subject + body 都打 `[HC-<hex16>]` token
  - `runWorkflow()` 通过 `extractMailUUID()` 识别 Master 回复，写入 `meta.isMasterReply=true` + `meta.replyToUUID=HC-...`
  - 报告里多出 `**Report UUID:** HC-...` 与 `要回复这条报告，请把 [HC-...] 放进邮件主题` 提示
- ✅ **防 OOM 修复**：
  - `appendRunLog(line, { always })` 5 秒内只写一次（默认节流），`always: true` 强制写
  - `server.js` 注册 `process.on('uncaughtException')` + `'unhandledRejection')` 兜底，避免 transient fetch 失败 kill 掉 server
  - `pickMailEndpoint()` timeout 3s → 1.5s
  - `appendRunLog` 多余的 `always` 传给 server.js 自己的 `appendRunLog`（旧的 1-arg 版本），但已通过 `{ always: true }` 透传仍合法
- ✅ **bug 修复**：`tagSubject` 模板错把 `HC-` 拼两遍（`[HC-${uuid}]` → `${uuid}` 已含 `HC-` 头），改为 `[${uuid}]`
- ✅ **重启验证**：
  - `/api/comm/run-now` 返回 `reportUUID=HC-5fe41ec5701e9bdd`，`mailResult.ok=true`
  - 报告里 `**Report UUID:** HC-5fe41ec5701e9bdd` + `要回复这条报告，请把 [HC-5fe41ec5701e9bdd] 放进邮件主题`
  - 邮件已发送给 939342547@qq.com（白名单内）
- ✅ `SKILL.md` 更新：4 个新代码注意点（邮件 UUID 配对 / 小时级调度 / 节流日志 / 崩溃兜底）+ 第 8 轮会话历史