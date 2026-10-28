# dsh-tldraw-canvas

[English](README.md) | **中文**

[![test](https://github.com/amumulam/dsh-tldraw-canvas/actions/workflows/test.yml/badge.svg)](https://github.com/amumulam/dsh-tldraw-canvas/actions/workflows/test.yml)

一个 **DeepSeek Harness Desktop** 插件：为每个 Session 在右侧栏提供独立的 tldraw 画板。本版本使用**原始 MIT 开源版 tldraw v1**（2021–2022），而不是商业授权的 tldraw 5 SDK，因此不需要 License Key，没有水印，也没有生产环境限制。

画板会自动保存到该 Session 的**项目目录**（Workspace 所归属的目录），因此它跟随工作区，而不是保存在浏览器存储里。

## 安装

```bash
git clone https://github.com/amumulam/dsh-tldraw-canvas.git
```

把检出的目录作为 DSH bundle 安装（插件管理器 → 从文件夹安装，或使用绝对路径调用 `install_bundle`）。`client.js` 已预构建，安装后的版本不需要 `node_modules`。

## 使用

1. 打开某个 Session 的右侧栏。
2. 从工具列表中添加一个标签页，选择 **Tldraw 画板**。
3. 开始画图。修改会在短暂停顿后自动保存，关闭标签页时也会再保存一次。

状态栏会显示保存状态和工作区相对路径。

## 读取画板（Agent 工具）

Host 半部负责统一的读取路径，不再需要临时文件系统脚本。它注册 `tldrawCanvas` 服务，并以如下工具暴露给 Agent：

```text
tldraw_read_canvas
```

参数：

- `session_id` — 可选；默认读取调用方当前 Session
- `include_preview` — 默认 `true`；生成 PNG 预览

工具返回结构化摘要（格式、shape/stroke/text 数量、点数、bounds、每个图形详情）以及预览图，因此 Agent 无需手工解析 JSON 就能回答“画板上有什么”。它同时支持新的 v1 文档和旧版 v5 快照。

其他 Host 插件可以注入 `tldrawCanvas` 并调用：

```js
const analysis = await ctx.tldrawCanvas.inspect(sessionId);
const { analysis, png } = await ctx.tldrawCanvas.render(sessionId);
```

`inspect` 和 `render` 都是只读的；写入仍然由画板标签页及其自动保存负责。

## Workspace 与 Session cwd

DSH 的 **Workspace** 是一条登记记录：一个命名目录，加上创建于该目录下的 Session 列表。它不是产物仓库；删除 Workspace 不会删除目录、文件或 Session 历史。

一个 Session 有两个目录概念：

- **项目原点** — 不可变的 `SessionHeader.cwd`。Workspace 归属和归档 Session 的读取都以这个路径为准。
- **当前工作目录** — 之后可能通过 `working_directory` 工具改变。Agent 工具写入这里，而已经启动的 shell 保留自己的进程目录。

画板固定在**项目原点**，而不是临时的当前工作目录。这样在同一个 Session 里 `cd` 不会把画作拆到多个目录，活跃 Session 和归档回放也会读取同一个文件。要在另一个目录画画，请新建一个该目录下的 Session。

## 保存位置

```text
<session 项目目录>/.dsh/tldraw/<session-id>.json
```

Host 自己解析 Session 的项目目录，浏览器不能指定任意路径。每个画板都以原子方式写入，并且能在应用重启和 Session 切换后继续使用。

### 旧版 v5 画板

本插件最初使用 tldraw 5。第一次把旧文件保存为 v1 时，Host 会在旁边复制原文件：

```text
.dsh/tldraw/<session-id>.v5.json
```

客户端会识别 v5 快照，把 freehand `draw` 图形转换为 v1 点集，并显示 **已迁移旧画板 / Legacy canvas migrated** 标记。其他 v5 图形类型不会转换；标记的 tooltip 会说明跳过了多少个。插件永远不会删除 `.v5.json` 备份。

## 实现

- `index.js` — Host 半部：注册 `GET`/`PUT /api/tldraw`，解析 Session 的项目目录，原子读写，并备份旧版 v5 文件。
- `src/client-entry.js` — Client 半部：注册 tldraw 标签页类型、工具列表卡片、跟随主题的编辑器和防抖自动保存。
- `src/migrate.js` — v5 笔画解码与 v5 → v1 文档转换。
- `src/canvas-model.js` — 格式无关的分析，以及零依赖的 PNG 预览渲染器。
- `client.js` — 生成的 bundle。

## 相似的 DSH 插件

社区里已经有一些画板/画布插件；最接近的几个在编辑器、存储和 Agent 能力上有所不同：

| 项目 | 编辑器 | 所在位置 | 持久化 | Agent 工具 |
|---|---|---|---|---|
| [johappel/dsh-tldraw](https://github.com/johappel/dsh-tldraw)（包名 `dsh-whiteboard`） | tldraw 5 | 右侧栏标签页 | workspace 级 snapshot | 9 个白板工具 |
| [zhang-guo-wen/dsh-whiteboard](https://github.com/zhang-guo-wen/dsh-whiteboard) | draw.io | 主面板画廊 + 右侧编辑器 | 插件 `files/` 目录 | 编辑器型 |
| [Jegozhou/dsh-excalidraw](https://github.com/Jegozhou/dsh-excalidraw) | Excalidraw 0.18 | 主面板 | `DSH_HOME/excalidraw/drawings` | 5 个带类型的场景工具 |
| [CSlawyer1985/dsh-excalidraw-board](https://github.com/CSlawyer1985/dsh-excalidraw-board) | excalidraw.com iframe | 浮层 | 上游站点 | 无本地工具 |
| [lb-aigc/dsh-canvas](https://github.com/lb-aigc/dsh-canvas) | React Flow 节点画布 | 右侧栏 + 会话 | session projection | 5 个节点工具 |

`dsh-tldraw-canvas` 的定位不同：它使用 **MIT tldraw v1** 编辑器，**每个 Session 在项目目录内保存一个文件**，并提供**只读摘要 + PNG 预览**工具，而不是协作编辑工具集。

## 命名

公开的 DSH 插件大致遵循几种命名方式：

- `dsh-<capability>` — 最常见，例如 `dsh-context`、`dsh-better-sidebar`
- `dsh-plugin-<capability>` — 例如 `dsh-plugin-subscriptions`
- `@author/dsh-<capability>` — 当包按作者 scope 命名时

本项目采用第一种：仓库 `dsh-tldraw-canvas`，包名 `dsh-tldraw-canvas`，标签页实现 id `dsh-tldraw-canvas/canvas`。关键词使用 `dsh`、`dsh-plugin` 和 `deepseek-harness`，方便插件目录检索。

## 为什么使用 tldraw v1

当前 tldraw 5 SDK 源码可见，但在生产环境需要商业/试用/Hobby License Key。原始 tldraw v1 是 MIT，但已停止维护（最后一个版本 1.29.2，2022 年）。本插件有意用现代功能和维护支持换取一个真正开源的编辑器。

## 开发

```bash
npm install
npm run build
```

`npm run build` 会从 `src/client-entry.js` 重新生成 `client.js`。

## 测试

```bash
node --test test/*.test.mjs
```

测试覆盖 Host API 的读写约定、非法与并发请求、损坏文件、临时文件清理、旧版 v5 备份、v5 笔画点解码、v5 → v1 转换、可复用读取服务，以及 Agent 工具的摘要/图片信封。

## 声明

这是一个独立的社区插件。tldraw 是 tldraw Inc. 的商标；本项目与 tldraw Inc. 没有关联，也未获得其背书。打包的 tldraw v1 代码仍遵循其 MIT 许可证（见 `THIRD_PARTY_NOTICES.md`）。
