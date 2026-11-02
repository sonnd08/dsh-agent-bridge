# dsh-agent-bridge

[English](README.md) | 中文

在 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（DSH）里直接使用你的 **Claude Code** 和 **Codex** 会话。它们会出现在 DSH 的工作区侧边栏里，和 DSH 自己的会话放在同一个项目文件夹下。你可以打开、继续聊，也可以置顶、改名、归档。

> 社区插件，非官方出品，与 DeepSeek、Anthropic、OpenAI 均无关联。

## 功能

- **一个侧边栏管理所有助手。** Claude Code 和 Codex 的会话按项目文件夹列在 DSH 原生的工作区侧边栏里，每一行带一个 Claude 或 Codex 的小标记。
- **原生的行菜单直接可用。** 置顶、重命名、归档用的都是 DSH 自己的菜单项、图钉标记和改名对话框。重启后置顶和归档都还在。
- **继续任何一个会话。** 打开会话能看到完整对话记录。可以发消息、中断当前这一轮、回答权限确认和提问、选择模型和思考强度、附加图片。Claude 通过 Claude Agent SDK 运行，Codex 通过 `codex app-server` 运行，会话和命令行工具保持互通。
- **操作和 DSH 一致。** 按 Enter 发送，Shift+Enter 换行。运行中的会话，在会话行里显示 DSH 自带的转圈。Claude 和 Codex 可以在附件按钮旁的权限菜单里选择默认（每次询问）、只读、工作区可写或完全权限；完全权限要先确认，每种助手分别记住选择，定时消息始终用默认权限。Claude 的思考摘要显示在回复上方，每段思考结束后才出现。
- **新建会话。** 可以在任意文件夹里开新会话，也可以先克隆一个仓库。
- **全文搜索。** 搜索所有会话的内容。
- **工作台标签页**，在每个会话旁边：
  - 终端。
  - 文件：浏览、编辑、上传。
  - Git：状态、差异、分支、worktree，以及起草提交说明。
  - 扩展：Claude 的 MCP 服务器、Skills、全局 Git 身份。
  - 任务：[TaskMaster](https://github.com/eyaltoledano/claude-task-master)。
- **定时发送。** 在指定时间给某个会话发一条消息。
- **可选工具：**
  - 通过 [Peekaboo](https://github.com/steipete/Peekaboo) 操控屏幕（macOS）。
  - 通过 [Playwright MCP](https://github.com/microsoft/playwright-mcp) 使用浏览器。
  - 通过任意兼容 OpenAI 接口的语音服务做语音输入和朗读。
  - 一轮对话结束时发桌面通知。
- **Pi 会话（默认关闭）。** 打开 `piEnabled` 后，也能列出并继续 Pi 会话。Pi 执行命令和改文件前不会询问，从 DSH 发出的消息会以你当前用户的权限直接执行。只有 Pi 扩展弹出的对话框才会显示成卡片；需要输入文字的对话框会被直接取消。
- **兜底不出错。** 如果以后的 DSH 版本改了侧边栏结构，插件接不进去，会话会自动改到一个单独的 "Claude / Codex" 页面里显示，不会弄坏侧边栏。

## 环境要求

- DeepSeek Harness 0.2.x，桌面端或 `dsh web` 都可以。已在 0.2.1 上测试。
- Node.js 22.19 或更新版本。DSH 自带 Node.js。
- 已安装并登录 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。
- [Codex CLI](https://github.com/openai/codex) 可选，没装就只显示 Claude 的会话。
- Pi 可选，已在 1.4.0 上测试。
- 在 macOS 上开发和测试。Linux 应该可用，Windows 未测试。

## 安装

先确定你用的是哪个 DSH 配置：桌面端是 `desktop`，`dsh web` 是 `web`。

```sh
dsh plugin --profile desktop add github:wiiwings1988/dsh-agent-bridge
```

然后重启 DSH。macOS 上桌面端自带的 `dsh` 命令在 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

卸载：运行 `dsh plugin --profile desktop remove dsh-agent-bridge`，然后重启 DSH。

## 配置

所有选项都有默认值，不配置也能用。要修改某一项，在所用配置的 `cordis.patch.yml` 里加一段，例如 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: agent-bridge
  config:
    claudeExecutable: /path/to/claude
    codexEnabled: false
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `claudeExecutable` | `claude` | Claude Code 的命令名或完整路径。只写命令名时，先在 `PATH` 里找，再找 `~/.local/bin`、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`。 |
| `codexEnabled` | `true` | 是否列出并运行 Codex 会话。 |
| `codexExecutable` | `codex` | Codex 的命令名或完整路径，查找方式同上。 |
| `codexApprovalPolicy` | `untrusted` | `untrusted` 或 `on-request`。 |
| `codexSandbox` | `workspace-write` | `read-only` 或 `workspace-write`。 |
| `codexHistoryTurns` | `20` | 打开 Codex 会话时加载最近几轮对话。 |
| `piEnabled` | `false` | 是否列出并运行 Pi 会话。Pi 执行前不会询问。 |
| `piExecutable` | `pi` | Pi 的命令名或完整路径，查找方式同上。 |
| `permissionMode` | `default` | Claude 的权限模式：`default`、`acceptEdits` 或 `plan`。 |
| `allowedTools` | `[]` | Claude 不经确认就能直接使用的工具。 |
| `sessionLimit` | `100` | Claude、Codex 各自最多列出多少个最近的会话。 |
| `defaultCwd` | 主目录 | 新建会话时没选文件夹，就用这个目录。 |
| `memoryFile` | 空 | 追加到新 Claude 会话系统提示词里的文件，例如某个 DSH 记忆插件的 `MEMORY.md`。 |
| `computerUse` | `true` | 装了 Peekaboo 时，让 Claude 能操控屏幕。 |
| `peekabooCommand` | `peekaboo` | Peekaboo 的命令名或完整路径。 |
| `browserUse` | `true` | 让 Claude 能使用 Playwright 浏览器。 |
| `browserHeaded` | `false` | 是否显示浏览器窗口。 |
| `voiceBaseUrl` | 空 | 兼容 OpenAI 接口的语音服务地址，留空则关闭语音。 |
| `voiceApiKeyEnv` | `VOICE_API_KEY` | 保存语音服务密钥的环境变量名。 |
| `voiceSttModel`、`voiceTtsModel`、`voiceTtsVoice` | `whisper-1`、`tts-1`、`alloy` | 语音识别模型、朗读模型和音色。 |
| `taskmasterCommand` | `npx` | 运行 TaskMaster 用的命令。 |
| `watchIntervalMs` | `500` | 打开的对话记录多久检查一次更新，单位毫秒。 |
| `heapWatchMb` | `0` | 用于排查内存问题：堆内存超过这个值（MB）时，在 `~/.dsh/agent-bridge/heap` 写一份快照和日志。快照可能包含对话内容。`0` 表示关闭。 |

## 数据与隐私

- 插件直接读取命令行工具自己存放会话的位置：`~/.claude`（或 `CLAUDE_CONFIG_DIR`）、`~/.codex`；打开 Pi 后还有 `~/.pi/agent/sessions`（或 `PI_CODING_AGENT_SESSION_DIR`、`PI_CODING_AGENT_DIR`）。不会上传任何会话内容。
- 改名、派生、删除修改的是命令行工具自己的会话文件，所以在命令行里看到的结果是一样的。
- 置顶、归档、草稿和定时消息存放在 `~/.dsh/agent-bridge/state.json`。
- 终端、文件、Git 这几个标签页以你当前用户的权限在本机操作。它们只提供给 DSH 界面使用，并受 DSH 自己的登录令牌保护。
- 语音功能只会把音频和文字发给你配置的语音服务。

## 已知限制

- 超长会话很占内存：打开 Claude 会话要把文件完整读 3 遍，Pi 会话读 2 遍。67MB 的会话，每个请求的峰值接近 500MB。
- Pi 会话里只要有一条格式错误的记录，就打不开。
- Pi：用 `!` 跑的命令和上下文压缩的摘要不会显示在对话记录里，不支持 Pi 设置里自定义的 `sessionDir`，改文件没有差异视图。

## 开发

构建时要用到 DSH 的客户端打包配置和类型定义，所以需要一份 DeepSeek Harness 源码。把本仓库克隆到源码根目录往下三层的位置：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
cd dsh && pnpm install && pnpm run build:artifacts
git clone https://github.com/wiiwings1988/dsh-agent-bridge.git local/plugins/dsh-agent-bridge
cd local/plugins/dsh-agent-bridge && pnpm install
pnpm run typecheck && pnpm run build
```

- **试用自己的构建：** `dsh plugin --profile web add link:$PWD` 会把当前目录装进指定配置。
- **单元测试：** 一次跑一个文件，例如 `node --import tsx/esm --test tests/graft.test.mjs`。
- **端到端测试：** `tests/e2e*.mjs` 用 Playwright 驱动一个正在运行的 `dsh web` 实例。通过 `DEV_BASE`（地址）和 `DEV_HOME`（该实例的 `DSH_HOME`）告诉测试用哪个实例。`tests/fixtures` 里有替代 Claude 和 Codex 的假程序。

`lib/` 已经提交进仓库，所以从 GitHub 安装不需要构建。改了源码后，提交前记得重新构建。

## 许可证

[MIT](LICENSE)
