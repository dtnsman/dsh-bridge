# dsh-bridge

把本机 **DeepSeek Harness（DSH）** 控制面桥接成普通 HTTP/SSE API 的轻量桥接服务，供远程页面、脚本或其他 Agent 调用。

- 纯 Node.js 实现，运行时依赖只有一个 `ws`
- 同时提供 HTTP REST 端点与 SSE 流式事件
- 附带一个开箱即用的调试页面 `dsh-proxy-hosts.html`
- 附带配套 **Android 应用 `DSH-Hosts`**，用于多主机管理（见下文）

## 特性

| 能力 | 说明 |
|---|---|
| 任务 Task | 创建、查询、取消任务 |
| 会话 Session | 会话列表、历史消息、发送消息 |
| 工作区 Workspace | 列出工作区、工作区文件读写 |
| 终端 Terminal | 执行命令、读取输出 |
| Job | 后台任务轮询与结果获取 |
| Skills / Commands / AgentPresets | 元数据枚举 |
| 通用 RPC 透传 | 任意 DSH RPC 方法直接转发 |
| SSE | 实时订阅事件流 |
| 多主机管理 | Android 应用集中管理多个 dsh-bridge 主机 |

## 环境要求

- Node.js >= 18
- 本机已安装并可运行 DeepSeek Harness

## 快速开始

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:10998`。

其他脚本：

```bash
npm run check   # 配置自检
npm run dev     # 开发模式（无隧道 + 详细日志）
```

## 配置

配置通过环境变量覆盖，主要项：

| 变量 | 说明 |
|---|---|
| `DSH_BRIDGE_PORT` | 监听端口，默认 `10998` |
| `DSH_BRIDGE_HOST` | 监听地址，默认 `127.0.0.1` |
| `DSH_BRIDGE_VERBOSE` | 设为 `1` 输出详细日志 |

## 目录结构

```text
bin/      命令行入口
src/      核心实现（路由、RPC、隧道、任务、事件等）
docs/     HTTP API 文档
release/  Android 应用安装包（DSH-Hosts.apk）
```

## Android 应用：DSH-Hosts（多主机管理）

`release/DSH-Hosts.apk` 是给 DSH 配套的 **Android 客户端**，用于在一台手机上集中管理多台运行 `dsh-bridge` 的主机。

安装方式：把 APK 传到 Android 设备后点击安装（需允许「安装未知来源应用」）。

主要用途：

- 保存并切换多个 dsh-bridge 主机（不同机器 / 不同端口）
- 通过 HTTP API 连接各主机，查看任务、会话与事件流
- 配合 `dsh-proxy-hosts.html` 一起使用，移动端与桌面端共享同一套主机配置思路

> 注意：APK 为配套客户端，使用前请先在本机启动 `dsh-bridge` 服务。若需从手机访问，需让服务监听非回环地址（`DSH_BRIDGE_HOST=0.0.0.0`）并做好鉴权与网络隔离。

## 文档

完整的端点说明、参数与典型流程见 [docs/HTTP-API.md](docs/HTTP-API.md)。

## 调试页面

`dsh-proxy-hosts.html` 是随项目分发的单文件调试页，直接用浏览器打开即可（静态文件仅此一个随仓库发布）。

## 安全说明

- 服务默认只绑定本机回环地址，请勿在无鉴权的情况下直接暴露到公网。
- 若需要对外访问，请自行置于反向代理与访问控制之后。

## 许可证

[GPL-3.0](LICENSE)
