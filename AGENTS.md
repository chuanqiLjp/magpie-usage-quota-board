# AGENTS.md

本文件是本仓库的**开发规范**，面向两类读者：使用 AI 编码工具（Claude Code、Codex、DSH、Cursor 等）的开发者，以及直接手写代码的人类协作者。AI 工具在改动本仓库前必须先读完本文。

> English speakers: this file is intentionally written in Chinese to keep a single source of truth. All rules are also reflected in commit messages and code comments where relevant.

---

## 1. 这是什么

`magpie-usage-quota-board` 是一个 **Magpie 本地页面插件**，在 Magpie 窗口侧边栏提供一个标签页，做两件事：

1. **用量查看**：按 模型 / 供应商 / 账号 / Harness 四个维度汇总调用次数、Token、缓存命中率、错误数、费用；时间范围支持今天 / 7 天 / 30 天 / **自定义（精确到时分）**。
2. **账号额度**：供应商 → 账号两级可折叠看板，显示总量、已使用、未使用、使用率、进度条、最近请求时间。

**它只读数据，不改 Magpie 的任何配置。** 所有数据来自本机 Magpie 网关（`127.0.0.1:3425`）和本地流水账文件。

---

## 2. 项目结构

```
.
├── package.json          # 插件清单（magpie 字段决定侧边栏页面、端口、图标）
├── index.mjs             # 宿主入口：在 Magpie 的 Bun 宿主里启动本地服务
├── lib/
│   ├── server.mjs        # 本地 HTTP 服务：路由、鉴权、CORS、访问日志
│   ├── gateway.mjs       # 网关访问层（只读 GET /v1/magpie/usage 与 /quotas）
│   ├── quota.mjs         # 额度口径（纯函数，可单测）：窗口挑选、文字解析、聚合
│   └── usage.mjs         # 用量口径（纯函数，可单测）：四维汇总、流水账区间、最近请求
├── page/
│   ├── index.html        # Magpie 沙盒加载的启动器
│   └── boot.js           # 读插件选项 → 跳转到本地服务
├── ui/                   # 真正的页面（由 lib/server.mjs 提供）
│   ├── index.html
│   ├── app.js            # 页面逻辑
│   ├── store.js          # 存储封装（沙盒里没有 localStorage）
│   └── style.css
├── test/                 # 单元测试（node:test，无第三方依赖）
└── docs/                 # 开发记录与踩坑经验
```

**职责边界（改代码前先确认自己改的是哪一层）：**

| 层 | 允许做 | 不允许做 |
|---|---|---|
| `lib/quota.mjs`、`lib/usage.mjs` | 纯函数、口径换算、聚合排序 | 发起网络请求、读写文件（`readUsageRows`/`readLastSeen` 是唯一例外，只读） |
| `lib/gateway.mjs` | 只读调 Magpie 网关 | 修改 Magpie 配置、写任何文件 |
| `lib/server.mjs` | 路由、鉴权、CORS、静态文件 | 业务口径计算（应放 `quota.mjs`/`usage.mjs`） |
| `ui/` | DOM 渲染、事件、请求自己的服务 | 直接调 Magpie 网关、发外网请求、用 `localStorage` |
| `page/` | 读插件选项、跳转 | 任何业务逻辑 |

---

## 3. 铁律：禁止事项

以下每一条都是真实踩过的坑（见 `docs/开发记录与经验.md`），违反会造成**页面打不开、空白、或数据错误**。

### 3.1 页面层（`ui/`、`page/`）硬性禁止

| 禁止 | 原因 |
|---|---|
| **禁止使用 `localStorage` / `sessionStorage` / `indexedDB` / `cookie`** | Magpie 页面跑在 `sandbox="allow-scripts"` 的 iframe 里（无 `allow-same-origin`），这些 API 一律抛 `SecurityError`。**必须**通过 `ui/store.js` 的 `store.get/set`，它已容错并退化为内存。 |
| **禁止用相对路径以外的方式跨源访问 Magpie 网关** | 页面要取数据只能请求**自己的本地服务**（`/api/board`、`/api/usage`）；禁止直接 `fetch('http://127.0.0.1:3425/...')`。 |
| **禁止发起任何外网请求**（CDN、字体、图标、统计、埋点） | 插件声明零外网依赖；且沙盒策略会拦截，导致整页异常。所有资源必须随包提供。 |
| **禁止内联 `<script>`**（`<script>代码</script>`） | 沙盒只允许外部脚本文件（`<script src>`）。内联样式和 `data:` 图片可以。 |
| **禁止在初始化阶段裸调浏览器 API** | 任何一行抛异常都会中断整个 `app.js`，表现为"页面骨架在、点不动、无数据"。新增 API 调用必须 try/catch。 |

### 3.2 服务层（`lib/`）硬性禁止

| 禁止 | 原因 |
|---|---|
| **禁止删掉任何响应上的 CORS 头**（`send()` 里统一注入） | 沙盒页面是 opaque origin（`Origin: null`），只给预检加头会导致页面 `Failed to fetch`。 |
| **禁止放宽监听地址到 `0.0.0.0`** | 只允许 `127.0.0.1`，避免局域网暴露账号额度数据。 |
| **禁止去掉 token 校验或 Host/Origin 校验** | 见 `lib/server.mjs` 的 `pageToken` / `hostAllowed` / `originAllowed`。 |
| **禁止把 token 打进日志**（完整值） | 只能打前 8 位，见现有实现。 |
| **禁止写 Magpie 的配置文件**（`providers.json`、`settings.json`、`plugins.json`） | 本插件只读。安装/卸载由用户执行 `magpie plugin add/remove`。 |

### 3.3 数据层

| 禁止 | 原因 |
|---|---|
| **禁止把"不知道"写成 `0`** | 缺失价格时 `cost` 必须是 `null`（前端显示 `—`），`0` 会被读成"花了 0 元"。见 `lib/usage.mjs` 的 `costRows` 逻辑。 |
| **禁止臆造口径** | 供应商取哪个额度窗口、Token 怎么算、命中率分母是什么，都以本文第 6 节和 `docs/` 为准，不得"看起来更合理"就改。 |
| **禁止把真实账号信息写进代码或文档** | 测试与示例一律用 `账号A`、`账号B`、`user-1`、`provider-x` 这类假数据。**这是公开仓库。** 详见 3.5。 |

### 3.4 协作禁止

| 禁止 | 说明 |
|---|---|
| **禁止 AI 未经确认执行 git 写操作** | 不 `commit`、不 `push`、不 `merge`、不 `rebase`、不 `tag`。只允许 `git status/diff/log` 等只读命令。提交由人类确认后执行。 |
| **禁止擅自升级依赖或引入运行时依赖** | 本项目**零运行时依赖**（只用 Node 内置模块）。新增依赖需在 PR 里说明理由并获得同意。 |
| **禁止在一次提交里混合"重构 + 功能 + 格式化"** | 一个提交只做一件事，便于回滚与 review。 |
| **禁止提交 `node_modules/`、日志、截图、临时验证脚本** | 见 `.gitignore`。 |

### 3.5 敏感信息（公开仓库，最高优先级铁律）

**本项目是公开仓库。任何本地账户名、账号别名、API Key、token、余额/额度数值，一律不得出现在代码、测试、文档、提交信息、Issue、截图、SVG 或任何随包资源里。**

| 禁止 | 具体范围 |
|---|---|
| **禁止写入真实账户标识** | 网关返回的 `user`、`providerAccount`、`alias`、`account`、`id`，以及邮箱、手机号、带平台前缀的 IAM 账号 ID、各供应商自己的账号编号等真实值。 |
| **禁止写入真实凭据** | `MAGPIE_API_KEY`、`MAGPIE_GATEWAY_KEY`、任何 `Bearer` 值、GitHub token、cookie。日志里 token 只能打前 8 位。 |
| **禁止写入真实额度/余额数值** | 真实的总量、已用、未使用、百分比，以及能反推出个人消费的费用数字。 |
| **禁止把真实数据粘进文档当样例** | 包括「实测证据」「自验输出」「截图」「踩坑复现」等一切场景。 |

**做法（不是可选建议）：**

1. 举例一律用假数据：`账号A`、`账号B`、`账号甲`、`user-1`、`user-2@example.com`、`provider-x` 这类明显是占位的值；形似真实 ID 的一律截断成 `前缀…`。
2. 引用真实输出做证据时**必须脱敏**：账号名换成 `账号A`/`账号B`，ID 只留前缀加 `…`，数值改成量级描述（「约 40 条」「千级 token」），而不是原值。
3. 提交前自查（命中就必须改掉再提交）：
   ```bash
   git diff --cached | grep -nE 'Bearer |sk-|iam::[0-9a-f]{8}|@phone\.local|MiniMax[0-9]'
   ```
4. 发现历史里已经泄了真实信息：**不要只删工作区文件**（历史仍可检出），必须报告人类，由人类决定改写历史或轮换凭据。
5. 拿不准某个值算不算敏感 → 按敏感处理，换成假数据；不要「先提交再说」。

---

## 4. 开发流程

任何改动都按这个顺序走，**不允许直接改代码就提交**。

```
① 确认现象/需求 → ② 只看不改地定位 → ③ 说明改哪几个文件、影响什么 → ④ 写/改单测
→ ⑤ 改实现 → ⑥ 跑单测 → ⑦ 机验 → ⑧ 问是否装 Magpie 人工核验
→ ⑨ 装本地 Magpie 并确认生效 → ⑩ 问人工核验结论
→ ⑪ 提交（需授权）→ ⑫ 推送（需授权）→ ⑬ 问是否发版（需授权）
```

### 每一步的具体要求

| 步骤 | 具体要求 |
|---|---|
| ① 确认 | 需求或缺陷必须能一句话说清"现在的行为 vs 期望的行为"。有歧义先问，不要猜。 |
| ② 定位 | 先 `git status` 确认工作区干净；用只读命令查证据（读文件、`curl` 接口、看 `magpie log`）。**不要在没定位到原因前改代码。** |
| ③ 说明 | 用表格列出：改哪个文件、改什么、影响范围、如何回滚。 |
| ④ 单测 | **口径类改动必须先加/改单测**（`test/quota.test.mjs`、`test/usage.test.mjs`）；页面行为改动至少手动验证。 |
| ⑤ 实现 | 最小改动。不动无关代码，不顺手格式化整文件。 |
| ⑥ 单测 | `node --test` 必须全绿。 |
| ⑦ 机验 | 见第 7.5 节「机验」。**必须机验通过才能进入 ⑧**；机验不通过 → 回到 ⑤，不询问安装。 |
| ⑧ 询问安装 | 机验通过后，**必须提问**「是否现在安装到本地 Magpie 做人工核验」。用户选「暂不」则流程停在此处，不提交、不推送。 |
| ⑨ 安装生效 | 用户选择「现在开始」才执行安装，并按第 7.6 节「安装生效判定」三项自动确认。**安装生效前不得提问核验结论。** |
| ⑩ 核验结论 | 安装生效后**再次提问**人工核验结论。不通过 → 回到 ⑤ 重新修改，重跑 ⑥⑦⑧⑨⑩，直到通过。 |
| ⑪ 提交 | **必须提问并获得明确授权**后才 `git commit`。提交粒度由人工在核验通过后裁决。信息格式见第 9 节。 |
| ⑫ 推送 | **必须提问并获得明确授权**后才 `git push`。 |
| ⑬ 发版 | **必须提问并获得明确授权**后才发版，范围见第 10 节。 |

### 安装方式（开发机）

本机开发阶段**始终用本地目录安装**，以便核验未提交的代码：

```bash
magpie plugin add .
```

> 这与 README 面向最终用户的安装方式（`magpie plugin add github:chuanqiLjp/magpie-usage-quota-board`，跟 `main`）不同。README 写的是**用户侧**安装，不要为开发方便去改它。开发机的本地目录安装收不到远端更新，属预期行为。

### 调试页面的正确方式

```bash
# 1) 在非生产端口起服务（会打印 token）
PORT=3501 node lib/server.mjs

# 2) 浏览器打开（先走 /enter 拿 token）
#    http://127.0.0.1:3501/enter

# 3) 装进 Magpie 后看日志（每个 /api/* 请求都有一行，含来源与状态码）
magpie log -n 200 | grep usage-quota-board
```

> 排查"页面没数据"的顺序：**先看访问日志**。
> 有 `/api/*` 请求 → 问题在前端渲染或数据口径；没有请求 → 页面脚本没跑起来（多半是 3.1 的禁止项被违反）；状态码 401 → token 失效；403 → Host/Origin 校验；500/502 → 服务或网关异常。

---

## 5. 如何添加一个新供应商

Magpie 的 `/v1/magpie/quotas` 已经会返回所有供应商的账号额度，**大多数情况下只需要让本插件知道"取哪个窗口"**。

### 第 1 步：看清这个供应商的真实返回

```bash
curl -s http://127.0.0.1:3425/v1/magpie/quotas | python -c "
import json,sys
d=json.load(sys.stdin)['data']
p='你的供应商id'
for a in [x for x in d if x['provider']==p][:2]:
    print(json.dumps(a,ensure_ascii=False,indent=1))
"
```

重点看两处：
- `windows[]` 里每个窗口的 `name`、`limit`、`amount`、`used`、`unit`
- 有没有 `balance`（纯文字余额，如 `"400 credits (monthly 100 · long-term 300)"`）

### 第 2 步：在 `lib/quota.mjs` 加分支

打开 `lib/quota.mjs`，找到 `pickAccountWindow`。按供应商返回形态选一种：

| 情形 | 改法 |
|---|---|
| 额度窗口名叫 `Credits` | 把供应商 id 加进顶部的 `CREDITS_PROVIDERS` 集合 |
| 窗口名是别的固定中文/英文（如 CodeArts 的 `总积分`） | 在同函数里照 `codearts` 的写法加一个 `provider === "你的id"` 分支 |
| 只有一段文字 `balance`，没有数字窗口 | 照 `qwenwork` 写法：写一个 `parse<供应商>Balance()` 纯函数，返回 `{remaining, limit}`，再在 `pickAccountWindow` 里调用 |
| 有多个窗口、只关心其中一个 | 明确用 `windows.find(w => w.name === "...")`，**不要用 `windows[0]`**（顺序不保证） |

**口径要求（来自需求裁决，不要改）：**

| 供应商 | 取哪个 |
|---|---|
| `trae-cn` / `raccoon` / `minimax-code` | `Credits` 窗口 |
| `raccoon` | **忽略 `Daily pool`** |
| `codearts` | `总积分` 窗口（已含基础+赠送，**不叠加**另外两个窗口） |
| `qwenwork` | 从 `balance` 文字解析：总量 = monthly + long-term，已用 = 总量 − 剩余 |

### 第 3 步：加单测

在 `test/quota.test.mjs` 里加两条：

1. `pickAccountWindow` 能选中正确的窗口（**用假数据，不要用真实账号**）
2. 解析不出时返回 `null`，且页面退化显示原文而不是崩溃

### 第 4 步：更新文档

- `docs/开发记录与经验.md` 的"供应商额度口径"表加一行
- 本文件第 6 节的表格同步加一行

### 第 5 步：验收

```bash
node --test test/quota.test.mjs
PORT=3501 node lib/server.mjs   # 起服务
# 打开 http://127.0.0.1:3501/enter → 账号额度页 → 确认新供应商出现、数字对得上 curl 的原始值
```

---

## 6. 口径定义的唯一来源

改任何数字前，先确认自己没违反下表。

| 口径 | 定义 | 代码位置 |
|---|---|---|
| Token 用量 | 输入 + 输出 + 缓存读 + 缓存写，展示为 M（百万） | `usage.mjs` `finish()` |
| 缓存命中率 | 缓存读 ÷（输入 + 缓存读）；**仅"按模型"维度显示**；无缓存读的行不显示 | `usage.mjs` `finish()` + `ui/app.js` |
| 未使用 | 总量 − 已使用 | `quota.mjs` |
| 供应商行聚合 | 各账号相加 | `quota.mjs` `buildQuotaBoard()` |
| 进度条配色 | ≤60% 绿、60–90% 橙、>90% 红 | `quota.mjs` `progressColor()` |
| 按账号维度的名称 | `供应商 · 账号`；**账号名优先取别名**，无别名才回退原始账号；排序先供应商、再账号名 | `usage.mjs` `summarizeGateway()` / `summarizeRows()`（`aliases` 参数） |
| 模型的合并 | 网关 `models` 数组按「模型×账号」拆分，**必须按模型名二次合并** | `usage.mjs` `summarizeGateway()` |
| 最近请求时间 | 额度接口没有该字段，用 `usage.jsonl` 的 `providerAccount` 匹配额度接口的 `user` | `usage.mjs` `readLastSeen()` |
| 自定义区间的费用 | `usage.jsonl` 不记单价 → `cost` 为 `null`，显示 `—` | `usage.mjs` `finish()` |
| 时间范围 | `today` / `7d` / `30d` / `all` 走网关；`custom` 读 `usage.jsonl` | `lib/server.mjs` `/api/usage` |

---

## 7. 自测与验收

### 7.1 单元测试（每次改动必跑）

```bash
node --test
```

（`node --test` 会自动发现 `test/` 下所有 `*.test.mjs`，新增用例文件无需改配置。）

期望：**全部通过（当前 26 条）**。新增功能必须带来新用例；修 bug 必须先写一条能复现的用例。

CI（`.github/workflows/test.yml`）在每次 push / PR 时自动跑同一命令，红了不允许合并。

### 7.2 口径自验（改了取数逻辑时必做）

```bash
# 起服务（不要用生产端口 3499）
PORT=3501 node lib/server.mjs &

# 拿 token
TOKEN=$(curl -s -o /dev/null -w '%{redirect_url}' http://127.0.0.1:3501/enter | sed 's/.*token=//')

# 额度面板：确认供应商数、账号数、总量/已用/未使用/pct 合理
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3501/api/board

# 用量四维：rows 数与 total 一致，分项之和 == 合计
for dim in model provider account harness; do
  curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"dim\":\"$dim\",\"period\":\"today\"}" http://127.0.0.1:3501/api/usage
done

# 自定义区间（走 usage.jsonl）
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"dim":"model","period":"custom","from":"2026-11-25T00:00","to":"2026-11-26T12:00"}' \
  http://127.0.0.1:3501/api/usage
```

**交叉校验要求**：三个维度的 `total.calls` 必须相等；`cost` 分项相加必须等于合计；改动后与改动前的数字要么一致，要么能解释差异。

### 7.3 安全自验（改了 `lib/server.mjs` 时必做）

```bash
curl -s -o /dev/null -w "无 token: %{http_code}\n"        http://127.0.0.1:3501/api/board   # 期望 401
curl -s -o /dev/null -w "恶意 Origin: %{http_code}\n" -H "Origin: http://evil.com" http://127.0.0.1:3501/api/board  # 期望 403
curl -s -o /dev/null -w "路径穿越: %{http_code}\n"        http://127.0.0.1:3501/../../etc/passwd  # 期望 404
```

### 7.4 真机验收（任何影响页面的改动都要做）

```bash
magpie plugin add .          # 就地加载当前目录
# 到 Magpie 窗口 → 侧边栏「用量与额度看板」
```

验收清单：
1. 两个标签都能切换，切过去有数据
2. 四个维度、四档时间都能点，数字会变
3. 「自定义」会带出默认时间，费用显示 `—` 且脚注有说明
4. 额度页：列头齐全、供应商名与数字同行、全部展开/折叠生效
5. 页面顶部**没有**红色报错条
6. 右上角若显示「折叠状态仅本次有效」属正常（沙盒无 localStorage）

改完记得看日志确认无异常：
```bash
magpie log -n 100 | grep usage-quota-board
```

### 7.5 机验（⑦ 的判定标准）

机验 = 每次改动完成后、询问安装之前**必跑**的自动检查，三件套全绿才算通过：

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 单元测试 | `node --test` | 全部通过，0 fail |
| 机验脚本 | `PORT=3501 node lib/server.mjs` 起服务后 `node preflight.mjs` | 输出末行「结论：全部通过，可发布」，退出码 0 |
| 四维交叉校验 | 见第 7.2 节的 `for dim in ...` 循环 | 四个维度 `total.calls` 相等，且各维分项之和 == 合计 |

> `preflight.mjs` **不入库**（`.gitignore` 已忽略）。它内部含用于扫描的真实账号模式串，属本机专用脚本；因此机验**只能在开发机上跑**，CI 里跑不了。这是已知限制，不是遗漏。

### 7.6 安装生效判定（⑨ 的判定标准）

`magpie plugin add .` 的退出码为 0 **不足以证明生效**（服务起不来时它也可能返回 0）。必须三项同时满足：

1. `magpie plugin list` 里出现本插件条目且状态为 `on`
2. 该条目登记的本地服务端口上 `/healthz` 返回 `{"ok":true,"service":"magpie-usage-quota-board"}`
3. `magpie log -n 200 | grep usage-quota-board` 里该次启动**没有**报错行（无 `error` / `EADDRINUSE` / 异常堆栈）

三项满足后，告知用户「已生效，请到 Magpie 窗口 → 侧边栏『用量与额度看板』核验」，然后再提问核验结论。

---

## 8. 沙盒环境的硬约束（必须理解，否则一定踩坑）

| 能力 | 沙盒下的表现 | 本项目做法 |
|---|---|---|
| `localStorage` 等存储 | 抛 `SecurityError` | `ui/store.js` 容错 + 内存退化 |
| 页面 `fetch` 相对路径 | 实际是**跨源**（opaque origin，`Origin: null`） | 服务端所有响应带 CORS 头 + PNA 头 |
| 页面的 `Origin` 头 | 固定 `null` | `originAllowed()` 放行 `null` |
| 服务 token | **每次 Magpie 启动都变** | 页面遇 401 自动跳 `/enter` 换新 token（只重试一次） |
| iframe `sandbox` | `allow-scripts`，无 `allow-same-origin` | 只用 `_magpie/bridge.js` 与自己的服务通信 |
| 跨窗口访问 Magpie | 不允许 | 不使用 |

完整清单与踩坑过程见 `docs/开发记录与经验.md` 第七、八节。

---

## 9. 提交规范

```
<类型>: <一句话说明>

可选正文：为什么要改、影响什么
```

类型：`feat`（功能）、`fix`（修复）、`docs`（文档）、`test`（测试）、`refactor`（重构，不改行为）、`chore`（杂务）。

示例：
```
fix: 自定义区间不再回落成今天

server.mjs 的 period 白名单漏了 "custom"，导致 /api/usage 永远走网关分支。
补白名单并加参数校验，缺 from/to 返回 400。
```

要求：
- 一个提交只做一件事
- 提交前 `node --test` 必须全绿
- 涉及口径或坑的改动，同一个提交里更新 `docs/`
- **AI 不得代为执行 `git commit` / `git push`**

---

## 10. 分支与发布

### 分支模型（重要）

| 分支 | 用途 | 谁能推 |
|---|---|---|
| `dev` | 日常开发。**可以随时提交和推送**，未验证的代码放这里没有风险 | 任何协作者 |
| `main` | 只放**已验证并发布**的版本。推送 `main` 等于对所有用户发布 | 仅维护者，验证通过后 |

**原因**：magpie 安装 git 仓库时跟踪**默认分支**（`main`）。`main` 一旦有新提交，已安装的用户就会看到「有更新」并可一键升级。所以 `main` 的每一次变化都必须是可发布的。

### 发布步骤

```bash
# 1) 在 dev 上开发、提交、推送（随时）
git checkout dev
git add -A && git commit -m "fix: ..."
git push

# 2) 验证：node --test 全绿 + 真机验收通过

# 3) 发布：dev 合入 main
git checkout main
git merge --ff-only dev        # 保持线性历史；有分叉时先 rebase

# 4) 打 tag（tag 只用于归档与追踪，安装本身跟踪 main）
git tag -a v0.1.1 -m "v0.1.1 <一句话说明>"

# 5) 推送 main 与 tag
git push origin main --tags

# 6) 在 GitHub 上基于该 tag 建 Release，写清楚变更内容
```

### 版本号规则

- 版本号在 `package.json`，当前 `0.1.x`（`0.1.0` 首发）。
- 修 bug → `0.1.x+1`；加功能 → `0.2.0`；改口径或破坏兼容 → 升次版本并在 `docs/` 说明。
- **发布时 `package.json` 的版本号必须与 tag 一致。**

### 分发方式

- 本插件通过 GitHub 分发，出现在 Magpie「插件 → 发现 → 非官方插件 · GitHub」，依据仓库的 `magpie-plugin` 标签和 `package.json` 里的 `magpie.name` / `magpie.summary`。
- 安装：`magpie plugin add github:chuanqiLjp/magpie-usage-quota-board`（跟 `main`）
- **不要**提交到 npm，也不要改包名去迎合官方社区列表，除非明确决定改走官方渠道。
- **不要**把安装命令写成固定 tag（`...#v0.1.0`）：那样用户永远收不到更新，只能手动重装（magpie 不会替 git 仓库解除固定）。

---

## 11. 新增一个汇总维度的做法（常见需求）

1. `lib/usage.mjs`：在 `summarizeGateway()` 的 `key` 映射里加数组名，在 `summarizeRows()` 的 `bucketOf()` 里加分组键
2. `ui/index.html`：加一个维度按钮
3. `ui/app.js`：`DIM_LABEL` 加列名；需要专属列（如命中率）时用 `state.dim` 控制显示
4. `test/usage.test.mjs`：加一条"分项之和 == 合计"的用例
5. 本文件第 6 节表格加一行
