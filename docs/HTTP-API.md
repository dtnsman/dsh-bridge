# DSH Bridge HTTP API

> 项目：`dtns.dsh-http`（DSH Bridge）
> 版本：2.0.0
> 适用代码：`src/routes.js`、`src/server.js`、`src/tasks.js`、`bin/dsh-bridge.js`
> 更新：2026-10-21

DSH Bridge 把本机 DSH（DeepSeek Harness）控制面桥接成普通 HTTP/SSE API，供远程页面、脚本或其他 Agent 调用。

---

## 目录

- [1. 架构与地址](#1-架构与地址)
- [2. 通用约定](#2-通用约定)
- [3. 自身端点](#3-自身端点)
- [4. 任务 Task](#4-任务-task)
- [5. 会话 Session](#5-会话-session)
- [6. 工作区 Workspace](#6-工作区-workspace)
- [7. 工作区文件 WorkspaceFiles](#7-工作区文件-workspacefiles)
- [8. 终端 Terminal](#8-终端-terminal)
- [9. Job](#9-job)
- [10. Skills / Commands / AgentPresets](#10-skills--commands--agentpresets)
- [11. 通用 RPC 透传](#11-通用-rpc-透传)
- [12. SSE 流式接口](#12-sse-流式接口)
- [13. 端点速查表](#13-端点速查表)
- [14. 典型流程](#14-典型流程)
- [15. 限制、安全与排错](#15-限制安全与排错)

---

## 1. 架构与地址

```text
浏览器 / 脚本 / Agent
        │  HTTP / SSE
        ▼
DSH Bridge  :10998
        │  DSH HTTP API + WebSocket mux
        ▼
DSH 控制面  127.0.0.1:9121
```

### 1.1 基址

本地：

```text
http://127.0.0.1:10998
```

通过 http-proxy 隧道时，基址是隧道域名，例如：

```text
http://dsh.b1dl.html.dtns.top
http://dsh.bld1.html.dtns.top
https://api.dsh.html.dtns.top
```

API 没有 `/v1` 之类的版本前缀，路径直接以 `/api/...` 开头。

### 1.2 启动参数

```bash
node bin/dsh-bridge.js [options]
```

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--port <n>` | `DSH_BRIDGE_PORT` | `10998` | Bridge 本地端口 |
| `--dsh-url <url>` | `DSH_BASE_URL` | `http://127.0.0.1:9121` | DSH 控制面地址 |
| `--dsh-home <path>` | `DSH_HOME` | `~/.dsh` | DSH 配置目录 |
| `--tunnel-url <url>` | `DSH_TUNNEL_URL` | `wss://res.dtns.top/tunnel` | 内置 Tunnel 服务 |
| `--client-id <id>` | `DSH_BRIDGE_CLIENT_ID` | 随机 `dsh-...` | 隧道客户端 ID |
| `--launch-token <tok>` | `DSH_LAUNCH_TOKEN` | 无 | 用 DSH 启动 token 换 cookie |
| `--no-tunnel` | — | — | 只开本地 HTTP，不接 Tunnel |
| `--check` | — | — | 自检 cookie、RPC、mux 后退出 |

`DSH_BASE_URL` 未指定时，启动阶段会扫描 DSH 端口。

---

## 2. 通用约定

### 2.1 请求格式

- 推荐 `Content-Type: application/json; charset=utf-8`。
- 也接受 `application/x-www-form-urlencoded`。
- 非 JSON 文本会先按 JSON 解析，失败后按 URL 编码解析。
- GET/HEAD 请求体忽略。

### 2.2 参数合并规则

普通 HTTP 路由按以下顺序合并参数（后者覆盖前者）：

```text
URL query 参数
  → 路由路径参数（如 :sessionId）
  → JSON body 字段
```

例如：

```text
POST /api/tasks/abc/cancel?reason=x
{"reason":"y"}
```

最终 `reason` 为 `"y"`。

POST body 是扁平对象，不需要再套一层 `params`。

### 2.3 成功响应

大多数便利接口：

```json
{
  "ok": true,
  "value": {}
}
```

`value` 是 DSH 原始返回值。

少数接口返回自定义结构，例如 `/health`、`/api/info`、`/api/tasks`、`/api/workspaces`。

### 2.4 错误响应

推荐统一按 `ok` 判断，而不是只看 HTTP 状态码：

```json
{
  "ok": false,
  "code": "gateway/...",
  "message": "...",
  "details": {}
}
```

`code` 可能来自 DSH，例如 `gateway/...`、`session/...`；也可能是 `gateway/internal`。

HTTP 状态码：

| 状态码 | 场景 |
|---|---|
| `200` | 成功，或 RPC 语义错误（必须检查 `ok`） |
| `400` | 缺少 `ns`/`method`，或网关类错误 |
| `404` | 路由不存在、任务不存在、DSH transport 404 |
| `405` | 路径存在但方法不对 |
| `500` | 路由处理异常、工作区流超时 |
| `501` | 通过内置 Tunnel 请求 SSE（应改用 HTTP 反代或 `ws_open`） |

> **重要版本差异**
> 本仓库源码中的 `/api/dsh/rpc` 对部分 RPC 错误可能返回 4xx；当前 Linux 部署已把 `/api/dsh/rpc` 的 RPC 错误统一为 HTTP 200 + `ok:false`。客户端应始终检查 `ok`，不要把 HTTP 200 当作业务成功。

### 2.5 CORS

Bridge 对每个请求动态生成 CORS：

```http
Access-Control-Allow-Origin: <请求的 Origin，缺省 *>
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: <回显 Access-Control-Request-Headers>
Access-Control-Allow-Private-Network: true
Access-Control-Expose-Headers: Content-Type, Content-Length, X-Request-ID
Access-Control-Max-Age: 86400
Cross-Origin-Resource-Policy: cross-origin
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

预检：

```http
OPTIONS /api/dsh/rpc
→ 200 OK
Content-Type: application/json; charset=utf-8

{}
```

支持 `file://` 页面产生的 `Origin: null`，也支持扩展/沙箱页面。

### 2.6 认证

Bridge HTTP 层没有入站认证：

- 不需要 Authorization 头。
- 不需要 Cookie。
- Bridge 内部用 `~/.dsh/.credentials.yaml` 或 `--launch-token` 铸造 DSH cookie。
- **任何能访问 Bridge 端口的人都能控制 DSH**。
- CORS 不是安全边界；公网部署必须额外加防火墙、反向代理认证或只允许隧道内访问。

---

## 3. 自身端点

### 3.1 `GET /health`

健康检查。

```json
{
  "status": "ok",
  "service": "dsh-bridge",
  "version": "2.0.0",
  "events": "connected",
  "mux": "connected",
  "tasks": 3
}
```

| 字段 | 说明 |
|---|---|
| `events` | `connected` / `pending` |
| `mux` | `connected` / `disconnected` |
| `tasks` | TaskRegistry 中任务数 |

### 3.2 `GET /api/info`

运行信息。

```json
{
  "dshBaseUrl": "http://127.0.0.1:9121",
  "eventsClientId": "c0a9b3ce-...",
  "muxReady": true,
  "taskCount": 3,
  "appAvailable": false,
  "note": "all endpoints open; use /api/dsh/rpc for passthrough"
}
```

### 3.3 `GET /api/endpoints`

返回静态 DSH 端点目录，用于自描述和发现：

```json
{
  "total": 130,
  "unmounted": ["schedule", "speech"],
  "namespaces": ["account", "agentPresets", "..."],
  "endpoints": [
    { "ns": "session", "method": "page", "mode": "unary", "args": ["request"] }
  ],
  "byNamespace": {},
  "generatedAt": "2026-10-21T...",
  "source": "DSH-HTTP-API.md §5"
}
```

注意：这是静态目录，可能与实际 profile 不一致。例如 Linux `web` profile 没有安装语音 Bundle，`speech` 会返回 404。

### 3.4 `GET /app`

如果项目根目录存在 `dsh-app.html`（或 `test-app-demo.html`、`public/dsh-app.html`），返回内置页面；否则 404：

```text
dsh-app.html not found
```

---

## 4. 任务 Task

Task 是 Bridge 自己维护的会话索引，主键是 `sessionId`。

### 4.1 Task 记录

```json
{
  "sessionId": "session-...",
  "title": "任务标题",
  "cwd": "/home/ibsvr",
  "status": "idle",
  "running": false,
  "lastSeq": 0,
  "lastActivityAt": null,
  "lastAssistantText": null,
  "pendingApprovals": [],
  "lastError": null,
  "model": "deepseek-flash",
  "sandbox": "workspace-write",
  "createdAt": 1792473677198,
  "updatedAt": 1792473677198,
  "closedAt": null
}
```

`status` 可能值：

```text
running | idle | waiting-approval | done | failed | cancelled | unknown
```

`pendingApprovals` 元素：

```json
{
  "eventId": "...",
  "toolName": "...",
  "reason": "...",
  "requestedAt": 1792473677198
}
```

### 4.2 `GET /api/tasks`

列出任务，按 `updatedAt` 倒序。

```json
{
  "ok": true,
  "tasks": []
}
```

### 4.3 `GET /api/tasks/:sessionId`

获取单个任务。会顺带刷新 DSH projections 的 `lastSeq`、`sandbox`、`model`。

```json
{
  "ok": true,
  "task": {}
}
```

不存在：

```json
HTTP 404
{ "ok": false, "error": "task not found", "sessionId": "..." }
```

### 4.4 `POST /api/tasks/:sessionId/cancel`

取消任务。

```bash
curl -X POST http://127.0.0.1:10998/api/tasks/session-xxx/cancel
```

成功：

```json
{ "ok": true }
```

### 4.5 `GET /api/tasks/:sessionId/stream`

SSE 订阅该会话，等价于 `session/follow` + 会话地址：

```text
GET /api/tasks/session-xxx/stream
```

不需要 query 参数。事件格式见 [SSE](#12-sse-流式接口)。

---

## 5. 会话 Session

### 5.1 `POST /api/session/create`

创建会话。body 直接作为 DSH `session/create` 的 `request`。

```bash
curl -X POST http://127.0.0.1:10998/api/session/create \
  -H 'content-type: application/json' \
  -d '{"cwd":"/home/ibsvr"}'
```

成功：

```json
{
  "ok": true,
  "value": {
    "sessionId": "session-...",
    "agentPreset": "standard"
  }
}
```

注意：

- Linux 上 `cwd` 必须是 Linux 路径，例如 `/home/ibsvr`、`/data`。
- Windows 路径 `C:\work` 在 Linux 上不是有效工作区，可能导致创建失败或生成异常目录。
- `cwd` 可省略，使用 DSH 默认工作区。

### 5.2 `POST /api/session/prompt`

发送提示词。body 直接作为 `request`。

```bash
curl -X POST http://127.0.0.1:10998/api/session/prompt \
  -H 'content-type: application/json' \
  -d '{
    "requestId": "req-1",
    "sessionId": "session-...",
    "mode": "queue",
    "content": [{"type":"text","text":"你好"}]
  }'
```

常见字段：

| 字段 | 说明 |
|---|---|
| `requestId` | 客户端生成，建议 UUID |
| `sessionId` | 目标会话 |
| `mode` | `queue` / `steer` |
| `content` | 内容块数组；文本为 `{type:"text",text}` |
| 图片 | 由 DSH 的 image part 结构决定，Bridge 原样透传 |

成功：

```json
{ "ok": true, "value": {} }
```

### 5.3 `POST /api/session/list`

列出会话。body 作为 DSH 的 `_request`（注意是下划线开头）：

```bash
curl -X POST http://127.0.0.1:10998/api/session/list \
  -H 'content-type: application/json' \
  -d '{}'
```

返回：

```json
{ "ok": true, "value": { "items": [] } }
```

### 5.4 `POST /api/session/page`

分页读取会话消息。body 直接作为 `request`。

```json
{
  "address": { "kind": "session", "sessionId": "session-..." },
  "throughSeq": 123,
  "beforeSeq": 80,
  "maxMessages": 10
}
```

| 字段 | 说明 |
|---|---|
| `address.sessionId` | 会话 ID |
| `throughSeq` | 当前快照上界，通常取 `session/projections` 的 `asOfSeq` |
| `beforeSeq` | 向前翻页游标；省略表示从 `throughSeq` 开始 |
| `maxMessages` | 单页最大消息数 |

返回 `value` 典型结构：

```json
{
  "records": [
    { "type": "event", "event": { "seq": 123 } }
  ],
  "hasMore": true
}
```

每条记录通常包含 `event.seq`。历史分页建议：

1. 先调用 `session/projections` 获取 `asOfSeq`。
2. 以 `throughSeq = asOfSeq` 读第一页。
3. 需要更旧消息时，用当前页最小 `seq` 作为 `beforeSeq`。
4. `hasMore=false` 或记录为空时停止。

### 5.5 `POST /api/session/projections`

读取会话投影。body 作为 `request`：

```json
{ "sessionId": "session-..." }
```

返回 `value` 包含 `asOfSeq`、`values` 等；常用：

```json
{
  "asOfSeq": 123,
  "values": {
    "title": "...",
    "tokenUsage": {},
    "sessionStats": {},
    "permissions": { "currentValue": "workspace-write" },
    "modelSelection": {}
  }
}
```

### 5.6 其他 Session 便利接口

以下接口 body 均作为 DSH `request`：

| 方法 | 路径 | DSH 方法 |
|---|---|---|
| POST | `/api/session/cancel` | `session/cancel` |
| POST | `/api/session/fork` | `session/fork` |
| POST | `/api/session/rename` | `session/rename` |
| POST | `/api/session/search` | `session/search` |
| POST | `/api/session/selectModel` | `session/selectModel` |
| POST | `/api/session/updateQueue` | `session/updateQueue` |

### 5.7 `POST /api/session/fork`

从某个事件前缀分叉新会话。body 作为 `request`：

```json
{
  "sessionId": "session-...",
  "atSeq": 123,
  "allowMigration": false
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 源会话 |
| `atSeq` | 否 | 分叉的包含式事件序号；省略时默认最后一个事件 |
| `allowMigration` | 否 | 是否允许迁移旧格式会话 |

成功：

```json
{
  "ok": true,
  "value": { "sessionId": "session-new..." }
}
```

分叉后应重新加载任务列表并切换到新 `sessionId`。

### 5.8 `GET /api/session/models`

获取模型目录：

```bash
curl http://127.0.0.1:10998/api/session/models
```

等价于 `session/modelCatalog`，返回：

```json
{ "ok": true, "value": { "groups": [] } }
```

---

## 6. 工作区 Workspace

### 6.1 `GET /api/workspaces`

Bridge 会打开 `workspace/follow` 流，取第一帧后立即取消，最多等待 5 秒。

返回：

```json
{
  "ok": true,
  "count": 2,
  "workspaces": [
    {
      "workspaceId": "...",
      "title": "...",
      "path": "/home/ibsvr",
      "sessionIds": [],
      "createdAt": null,
      "updatedAt": null
    }
  ],
  "raw": {}
}
```

`raw` 是原始帧，字段不固定，调试时使用。

失败（例如 5 秒超时）：

```json
HTTP 500
{ "ok": false, "error": "workspace/follow timeout (5s)" }
```

### 6.2 Workspace 写操作

以下接口 body 作为 `request`：

| 方法 | 路径 | DSH 方法 |
|---|---|---|
| POST | `/api/workspace/create` | `workspace/create` |
| POST | `/api/workspace/delete` | `workspace/delete` |
| POST | `/api/workspace/rename` | `workspace/rename` |
| POST | `/api/workspace/archiveSession` | `workspace/archiveSession` |
| POST | `/api/workspace/unarchiveSession` | `workspace/unarchiveSession` |

示例：

```bash
curl -X POST http://127.0.0.1:10998/api/workspace/create \
  -H 'content-type: application/json' \
  -d '{"title":"demo","path":"/home/ibsvr/demo"}'
```

实际字段以 DSH `workspace/create` 为准；Bridge 不重塑结构。

---

## 7. 工作区文件 WorkspaceFiles

这些接口的 body **直接作为 DSH args**，不再套 `request`。

| 方法 | 路径 | DSH 方法 | 常见 args |
|---|---|---|---|
| POST | `/api/workspaceFiles/read` | `workspaceFiles/read` | `path`, `range` |
| POST | `/api/workspaceFiles/list` | `workspaceFiles/list` | `path` |
| POST | `/api/workspaceFiles/stat` | `workspaceFiles/stat` | `path` |
| POST | `/api/workspaceFiles/readBytes` | `workspaceFiles/readBytes` | `path`, `options` |
| GET | `/api/workspaceFiles/changes` | `workspaceFiles/changes` | SSE，query `path` |

示例：

```bash
curl -X POST http://127.0.0.1:10998/api/workspaceFiles/list \
  -H 'content-type: application/json' \
  -d '{"path":"/home/ibsvr"}'
```

返回：

```json
{ "ok": true, "value": [] }
```

> 文件操作的 scope / workspaceFileScopeId 由 DSH 解析；Bridge 只透传。二进制结果可能是 Buffer 的 JSON 形式，建议优先用 DSH 原始接口约定处理。

---

## 8. 终端 Terminal

这些接口的 body **直接作为 DSH args**。

| 方法 | 路径 | DSH 方法 | 常见 args |
|---|---|---|---|
| POST | `/api/terminal/create` | `terminal/create` | `request` |
| POST | `/api/terminal/write` | `terminal/write` | `id`, `attachmentId`, `data` |
| POST | `/api/terminal/resize` | `terminal/resize` | `id`, `attachmentId`, `cols`, `rows` |
| POST | `/api/terminal/close` | `terminal/close` | `id` |
| POST | `/api/terminal/list` | `terminal/list` | `sessionId` |
| POST | `/api/terminal/environment` | `terminal/environment` | 无 |
| POST | `/api/terminal/shells` | `terminal/shells` | 无 |
| GET | `/api/terminal/follow` | `terminal/follow` | SSE：`id`, `attachmentId` |

示例：

```bash
curl -X POST http://127.0.0.1:10998/api/terminal/list \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-..."}'
```

创建终端时，body 通常需要：

```json
{ "request": { "sessionId": "session-...", "cols": 80, "rows": 24 } }
```

具体字段以 DSH `terminal/create` 为准。

---

## 9. Job

| 方法 | 路径 | DSH 方法 | body |
|---|---|---|---|
| POST | `/api/job/list` | `job/list` | 作为 `_request` |
| POST | `/api/job/kill` | `job/kill` | 作为 `request` |
| GET | `/api/job/follow` | `job/follow` | SSE，用 `args` 传参 |

示例：

```bash
curl -X POST http://127.0.0.1:10998/api/job/list \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-..."}'
```

---

## 10. Skills / Commands / AgentPresets

| 方法 | 路径 | DSH 方法 | body |
|---|---|---|---|
| POST | `/api/skills/list` | `skills/list` | 作为 `request` |
| GET | `/api/commands/list` | `commands/list` | 无 |
| POST | `/api/commands/execute` | `commands/execute` | 直接 args：`line`, `submittedAttachments` |
| GET | `/api/agentPresets/list` | `agentPresets/list` | 无 |
| POST | `/api/agentPresets/select` | `agentPresets/select` | 直接 args：`agentPreset` |

示例：

```bash
curl -X POST http://127.0.0.1:10998/api/agentPresets/select \
  -H 'content-type: application/json' \
  -d '{"agentPreset":"standard"}'
```

---

## 11. 通用 RPC 透传

### 11.1 `POST /api/dsh/rpc`

调用任意已挂载的 DSH 命名空间/方法。

```json
{
  "ns": "session",
  "method": "projections",
  "args": {
    "request": { "sessionId": "session-..." }
  }
}
```

```bash
curl -X POST http://127.0.0.1:10998/api/dsh/rpc \
  -H 'content-type: application/json' \
  -d '{
    "ns":"session",
    "method":"projections",
    "args":{"request":{"sessionId":"session-..."}}
  }'
```

成功：

```json
{ "ok": true, "value": {} }
```

错误：

```json
{
  "ok": false,
  "code": "gateway/internal",
  "message": "transport 404: not found",
  "details": null
}
```

### 11.2 使用 `/api/endpoints` 发现

`GET /api/endpoints` 返回静态的 `{ns, method, mode, args}` 列表。

调用约定：

```js
await fetch(BASE + '/api/dsh/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ns, method, args }),
});
```

### 11.3 常用透传调用

| 目的 | ns / method | args 示例 |
|---|---|---|
| 会话分页 | `session/page` | `{"request":{"address":{"kind":"session","sessionId":"..."},"throughSeq":123,"maxMessages":10}}` |
| 会话投影 | `session/projections` | `{"request":{"sessionId":"..."}}` |
| 附件元数据 | `session/attachment` | `{"request":{"sessionId":"...","attachmentId":"..."}}` |
| 上传文件 | `fileUploads/upload` | 以 DSH 接口为准 |
| 语音识别 | `speech/transcribe` | `{"request":{"audioBase64":"...","providerId":"sensevoice-local"}}` |
| 语音目录 | `speech/catalog` | `{}` |
| 模型目录 | `session/modelCatalog` | `{}` |
| 插件列表 | `pluginManager/listBundles` | `{}` |

> `speech`、`schedule` 等命名空间是否可用取决于 DSH profile；未挂载时返回 404（见 `/api/endpoints.unmounted`）。

---

## 12. SSE 流式接口

### 12.1 端点

| 路径 | 说明 |
|---|---|
| `GET /api/tasks/:sessionId/stream` | 某会话的 `session/follow` |
| `GET /api/workspaceFiles/changes` | 工作区文件变化，query `path` |
| `GET /api/terminal/follow` | 终端输出 |
| `GET /api/job/follow` | Job 输出 |
| `GET /api/stream/session.follow` | 通用会话流 |
| `GET /api/stream/session.control` | 会话控制流 |
| `GET /api/stream/workspace.follow` | 工作区流 |
| `GET /api/stream/job.follow` | Job 流 |
| `GET /api/stream/job.list` | Job 列表流 |
| `GET /api/stream/terminal.follow` | 终端流 |
| `GET /api/stream/terminal.retain` | 终端保留流 |
| `GET /api/stream/account.watch` | 账户流 |
| `GET /api/stream/account.watchExpiry` | 账户过期流 |
| `GET /api/stream/productAnalytics.watchPolicy` | 产品分析策略流 |
| `GET /api/stream/events` | DSH `$events` 全局事件流 |

### 12.2 传参

通用流使用 `args` query，值是 JSON：

```text
GET /api/stream/session.follow?args=%7B%22request%22%3A%7B%22address%22%3A%7B%22kind%22%3A%22session%22%2C%22sessionId%22%3A%22session-...%22%7D%7D%7D
```

解码后：

```json
{
  "request": {
    "address": {
      "kind": "session",
      "sessionId": "session-..."
    }
  }
}
```

规则：

- 如果路由定义了参数（例如 taskScoped），优先用路径参数。
- 没有 `args` 时，所有 query 参数直接作为 args。
- `args` 不是合法 JSON 时，服务端发送 `event: error` 并结束。

任务流不需要 `args`：

```text
GET /api/tasks/session-xxx/stream
```

### 12.3 帧格式

连接成功先收到：

```text
: connected
```

普通数据：

```text
id: 1
data: {"type":"event","event":{"seq":123}}

id: 2
data: {"type":"event","event":{"seq":124}}
```

结束：

```text
event: end
data: {}
```

错误：

```text
event: error
data: {"message":"..."}
```

心跳：

```text
: heartbeat
```

每 30 秒一次。

### 12.4 客户端注意事项

- 标准 `EventSource` 可直接使用，不需要 Cookie。
- 服务端不处理 `Last-Event-ID`；断线重连会重新打开流。需要补历史时用 `session/page`。
- SSE 响应带完整 CORS 头，`file://` 页面也可以连接。
- 通过本项目内置 Tunnel 的 WebSocket 通道访问时，SSE 返回 501；通过普通 HTTP 反代/直连时支持 SSE。

### 12.5 `$events` 全局事件流

`GET /api/stream/events` 对应 DSH 的 `$events`，会收到：

```json
{ "type": "ready", "clientId": "..." }
```

```json
{ "type": "waterfall", "event": "approval/...", "eventId": "..." }
```

```json
{ "event": "api-session/status", "args": [] }
```

Bridge 会自动处理 `waterfall`：

- 通过内部 RPC 回复 `outcome: { kind: "result", value: "allowed-once" }`
- 即审批请求会被自动允许一次

这意味着通过 Bridge 运行时，DSH 的审批瀑布可能被自动放行。生产环境必须了解并接受这个行为。

---

## 13. 端点速查表

### 自身

| 方法 | 路径 |
|---|---|
| GET | `/health` |
| GET | `/api/info` |
| GET | `/api/endpoints` |
| GET | `/app` |

### 任务

| 方法 | 路径 |
|---|---|
| GET | `/api/tasks` |
| GET | `/api/tasks/:sessionId` |
| POST | `/api/tasks/:sessionId/cancel` |
| GET | `/api/tasks/:sessionId/stream` |

### 会话

| 方法 | 路径 |
|---|---|
| POST | `/api/session/create` |
| POST | `/api/session/prompt` |
| POST | `/api/session/list` |
| POST | `/api/session/page` |
| POST | `/api/session/cancel` |
| POST | `/api/session/fork` |
| POST | `/api/session/rename` |
| POST | `/api/session/search` |
| POST | `/api/session/projections` |
| POST | `/api/session/selectModel` |
| POST | `/api/session/updateQueue` |
| GET | `/api/session/models` |

### 工作区

| 方法 | 路径 |
|---|---|
| GET | `/api/workspaces` |
| POST | `/api/workspace/create` |
| POST | `/api/workspace/delete` |
| POST | `/api/workspace/rename` |
| POST | `/api/workspace/archiveSession` |
| POST | `/api/workspace/unarchiveSession` |

### 工作区文件

| 方法 | 路径 |
|---|---|
| POST | `/api/workspaceFiles/read` |
| POST | `/api/workspaceFiles/list` |
| POST | `/api/workspaceFiles/stat` |
| POST | `/api/workspaceFiles/readBytes` |
| GET | `/api/workspaceFiles/changes` |

### 终端

| 方法 | 路径 |
|---|---|
| POST | `/api/terminal/create` |
| POST | `/api/terminal/write` |
| POST | `/api/terminal/resize` |
| POST | `/api/terminal/close` |
| POST | `/api/terminal/list` |
| POST | `/api/terminal/environment` |
| POST | `/api/terminal/shells` |
| GET | `/api/terminal/follow` |

### Job

| 方法 | 路径 |
|---|---|
| POST | `/api/job/list` |
| POST | `/api/job/kill` |
| GET | `/api/job/follow` |

### Skills / Commands / Presets

| 方法 | 路径 |
|---|---|
| POST | `/api/skills/list` |
| GET | `/api/commands/list` |
| POST | `/api/commands/execute` |
| GET | `/api/agentPresets/list` |
| POST | `/api/agentPresets/select` |

### 通用

| 方法 | 路径 |
|---|---|
| POST | `/api/dsh/rpc` |
| GET | `/api/stream/*`（见 SSE 表） |

---

## 14. 典型流程

### 14.1 新建任务并发送提示词

```bash
BASE=http://127.0.0.1:10998

# 1) 创建会话（Linux 路径）
curl -sS -X POST "$BASE/api/session/create" \
  -H 'content-type: application/json' \
  -d '{"cwd":"/home/ibsvr"}'

# 2) 发送提示词
curl -sS -X POST "$BASE/api/session/prompt" \
  -H 'content-type: application/json' \
  -d '{
    "requestId":"req-1",
    "sessionId":"session-...",
    "mode":"queue",
    "content":[{"type":"text","text":"查看当前目录"}]
  }'

# 3) 查看任务
curl -sS "$BASE/api/tasks"

# 4) 订阅该会话
curl -N "$BASE/api/tasks/session-.../stream"
```

### 14.2 历史分页

```js
const proj = await apiRpc('session', 'projections', {
  request: { sessionId },
});

const page = await apiRpc('session', 'page', {
  request: {
    address: { kind: 'session', sessionId },
    throughSeq: proj.asOfSeq,
    maxMessages: 10,
  },
});
```

更旧一页：

```js
const older = await apiRpc('session', 'page', {
  request: {
    address: { kind: 'session', sessionId },
    throughSeq: proj.asOfSeq,
    beforeSeq: minSeqOfCurrentPage,
    maxMessages: 10,
  },
});
```

### 14.3 浏览器 `file://` 页面

```js
const BASE = 'http://dsh.b1dl.html.dtns.top';

const res = await fetch(BASE + '/api/dsh/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ns: 'session',
    method: 'list',
    args: { _request: {} },
  }),
});

const json = await res.json();
if (!json.ok) throw new Error(json.message);
```

Bridge 会返回 `Access-Control-Allow-Origin: null`（对应 `file://` 的 `Origin: null`）。

---

## 15. 限制、安全与排错

### 15.1 无鉴权

Bridge 的 HTTP API 完全开放：

- 不要直接暴露到公网。
- 公网访问应加 nginx basic auth、IP 白名单、VPN 或只允许本机/Tunnel。
- CORS 只解决浏览器跨域，不是访问控制。

### 15.2 自动审批

`EventBridge` 对 `waterfall` 事件自动回复 `allowed-once`。远程调用者可能绕过审批，生产环境应评估。

### 15.3 路径与工作区

- `session/create.cwd` 必须是 DSH 主机上的有效路径。
- Linux 上不要填 `C:\work` 之类的 Windows 路径。
- 文件/终端接口的能力与 DSH 当前权限沙箱一致。

### 15.4 超时

- `/api/workspaces` 内部流等待 5 秒。
- 普通 http-proxy 请求默认 30 秒；长任务请用 SSE 或轮询。
- SSE 每 30 秒心跳。

### 15.5 常见错误

| 现象 | 原因 |
|---|---|
| `no route: POST /api/...` | 路径/方法不在路由表 |
| `ns and method required` | `/api/dsh/rpc` 缺 `ns` 或 `method` |
| `transport 404: not found` | DSH 未挂载该 namespace/method（如 `speech`） |
| `workspace/follow timeout (5s)` | `/api/workspaces` 取首帧超时 |
| 浏览器 CORS 错误 | 域名未注册到隧道、Bridge 未启动、或中间代理过滤了 CORS 头 |
| `ERR_EMPTY_RESPONSE` | http-proxy 二进制协议对 4xx 状态码截断；升级/修补代理，或让 RPC 错误返回 200 + `ok:false` |
| SSE 连不上 | 隧道/反代未关闭 buffering，或走内置 Tunnel 需用 `ws_open` |

---

## 附：相关文件

- `src/routes.js` — 路由定义
- `src/server.js` — HTTP 服务、CORS、SSE
- `src/tasks.js` — TaskRegistry
- `src/rpc.js` — DSH RPC 客户端
- `src/mux.js` — DSH WebSocket mux
- `src/events.js` — `$events` 与 waterfall 自动审批
- `bin/dsh-bridge.js` — CLI 入口
- `dsh-api/DSH-HTTP-API*.md` — DSH 原始 HTTP API 详细文档
