# CodexControlPlugin 安装说明

这个插件用于替代目标电脑上的独立 `Codex Device Agent` 安装程序。Relay 和 Controller 仍然独立部署。

0.3.4 支持手机新建 Codex / ChatGPT Work 聊天，可选择对应项目。需要同步更新 App 和 Relay；更新插件后重启桌面应用并打开一个已有聊天，加载新增的 MCP 连接组件。

## 系统要求

- Windows 10/11 x64，或 macOS Apple Silicon / Intel
- macOS 需 Node.js 24 及以上；启动器可复用 Codex 内置运行时，也支持本机 Node.js
- 安装、登录并打开 Codex Desktop；安装命令需要支持插件的 Codex CLI（已在 0.153.4 验证），仅有 CLI 不能连接 Desktop 任务
- 目标电脑能够访问统一连接服务
- iPhone App 已经使用 Codex Control 账号登录

这是公开安装仓库，下载安装无需 GitHub 账号或令牌。Windows 已内置 Node.js。

## 安装

推荐通过独立的插件安装仓库直接安装。该仓库包含可运行的 Windows / macOS 插件发行内容，不是 Codex Control 主项目源码仓库：

```powershell
codex plugin marketplace add https://github.com/ElmMoneyTree/CodexControlPlugin.git
codex plugin add codex-control-plugin@codex-control
```

下面是本地 ZIP 安装方式。

1. 解压 `codex-control-plugin-0.3.4.zip` 到稳定目录。安装后不要移动或删除该目录，因为它是本地插件市场源。
   如同时取得 `.sha256` 文件，先在 PowerShell 执行 `Get-FileHash .\codex-control-plugin-0.3.4.zip -Algorithm SHA256`，并与文件中的值核对。
2. 把解压目录添加为 marketplace，然后安装插件。Windows PowerShell 示例（macOS 终端使用对应的绝对路径）：

   ```powershell
   codex plugin marketplace add "C:\替换为解压后的目录"
   codex plugin add codex-control-plugin@codex-control
   ```

3. 重启 Codex，或至少新建一个 Codex 任务。
4. 首次加载时在 Codex CLI 执行 `/hooks`，或在 Codex Desktop 打开 Hook 管理界面。检查 `CodexControlPlugin` 的 `SessionStart` Hook，然后选择信任。Codex 会把信任绑定到 Hook 内容哈希；插件升级后内容变化时需要重新检查。

## 认领设备

1. 如果旧的独立 `Codex Device Agent` 正在运行，先退出它，防止 App 同时出现两个相同设备。
2. 信任 Hook 后再新建一个 Codex 任务。插件会自动在本机生成 Ed25519 设备身份并打开五分钟有效的认领页面，无需输入 Relay 地址、Owner ID 或配对码。电脑页面仅显示二维码，请用已登录的 iPhone App 扫码，并在手机上完成认领。
3. 核对页面与电脑返回的安全指纹，选择个人或团队空间并批准。设备私钥、poll token 和设备 token 在 Windows 上使用当前用户 DPAPI 加密，在 macOS 上保存在当前用户 Keychain 中，不会写入聊天。
4. 继续输入“查看 CodexControlPlugin 状态”。状态为 `connected`，并显示最近同步时间和任务数量时，认领完成。

如果在有效期内误关了认领页面，再输入“使用 CodexControlPlugin 认领这台设备”或重新运行 `scripts\start-device-claim.ps1` 即可恢复同一个认领，不会重复创建请求。用于恢复页面的认领密钥仅以 Windows 当前用户 DPAPI 密文保存在临时记录中，批准或过期后自动删除。

认领脚本默认只输出安全指纹和有效期，不输出含密钥的链接。`-RevealClaimLink` 仅供管理员直接在私有本机终端调试，不能通过 Codex 调用或复制进聊天记录。

已使用数字配对的旧设备不必先断开，也不会被 Hook 自动迁移。输入“使用 CodexControlPlugin 在 Codex Control 中认领这台设备”在 Windows 上会原位迁移：设备 ID、任务与待办保留，批准后才轮换凭据；认领过期时旧连接保持不变。数字配对脚本仅作为兼容备用方式保留。

## macOS 验证、认领和后台服务

在插件目录内执行：

```bash
bash scripts/macos-agent.sh verify
bash scripts/macos-agent.sh claim
bash scripts/macos-agent.sh status
```

`verify` 检查本机 Codex Desktop 的 Unix socket 和 Keychain helper。`claim` 打开二维码并注册用户级 LaunchAgent，手机批准后自动开始同步；未过期的认领可以重新打开。`status` 的 `state` 应为 `connected`，并显示最新的 `lastSyncAt`。

macOS 数据目录是 `~/Library/Application Support/Codex Control Agent Plugin`：配置文件仅保存设备标识和 Keychain 引用，私钥与令牌保存在 Keychain；`agent.log` 和 `launcher.log` 用于排查启动及同步问题。LaunchAgent 在当前用户登录时运行轻量应用监听器：Codex Desktop 启动时自动启动同步 Agent，无需先打开任务；退出 Codex 时立即停止同步 Agent，若进程卡住则在 5 秒后强制清理。Codex 未运行时仅保留启动监听器，不轮询 Relay；重新打开 Codex 后自动恢复同步。临时 IPC 断开不会被误判为退出。已认领设备可执行 `bash scripts/macos-agent.sh start` 立即应用此配置。

macOS 卸载前执行 `bash scripts/macos-agent.sh disconnect`，清理 LaunchAgent 与本机 Keychain 凭据，再执行 `codex plugin remove codex-control-plugin@codex-control`。如需同时撤销服务器凭据，请在手机设备页撤销设备。

以下数据目录、PowerShell 命令与 DPAPI 说明适用于 Windows。

## 更新

```powershell
codex plugin marketplace upgrade codex-control
codex plugin add codex-control-plugin@codex-control
```

更新后重启 Codex 并打开已有聊天。Hook 内容变化时需要重新检查并信任；设备配置保存在插件目录之外。

## 自动启动和退出

- 第一次可信的 Codex 会话启动时，`SessionStart` Hook 会创建短期认领并打开页面；后续会话启动或恢复时会运行 Agent 启动器。
- 启动器检测单实例锁；Agent 已运行时立即退出，不会重复启动。
- Agent 在后台轮询 Relay，并连接本机 Codex IPC。
- macOS 完成首次注册后，Agent 随 Codex 应用启动和退出；只打开 Codex 首页也会启动。Codex 关闭期间仅保留轻量启动监听器。
- Windows 仍由会话 Hook 启动；Codex Desktop 持续不可用 90 秒后 Agent 自动退出。

## 状态和日志

为兼容已经配对的旧版本，默认数据目录继续使用：

```text
%LOCALAPPDATA%\Codex Control Agent Plugin
```

其中：

- `agent-config.json`：DPAPI 加密后的设备 token、设备私钥和空间信息
- `pending-claim.json`：仅在短期认领期间存在的 DPAPI 加密认领密钥、poll token 和设备私钥
- `status.json`：连接状态和最近同步信息，不含明文令牌
- `agent.log`：后台 Agent 日志，不含明文令牌

## 断开或卸载

可以在 Codex 中输入“断开这台设备的 CodexControlPlugin”，也可以在插件目录运行 `scripts\disconnect-agent.ps1`，然后用 Codex CLI 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\plugins\codex-control-plugin\scripts\disconnect-agent.ps1
codex plugin remove codex-control-plugin@codex-control
```

断开脚本会停止插件 Agent 并删除本机认领配置；CLI 命令会卸载插件。如需让服务器凭据立即失效，请先在 iPhone App 中撤销设备。

## Windows 验收

保持 Codex Desktop 和至少一个任务打开，在插件目录运行：

```powershell
.\scripts\verify-device-claim.ps1
.\scripts\verify-device-claim.ps1 -BeginClaim
```

第一条只检查线上 `/v1` Relay、内置 Node.js 和当前用户 DPAPI；第二条会打开或恢复认领，等待批准，并验证设备凭据、Codex Desktop 命名管道和首次 Relay 同步。输出不包含任何设备凭据。

## 与独立 Agent 的关系

插件和独立安装包复用同一份 `packages/agent-core`。独立安装包保留用于不支持插件或禁用了 Hook 的环境；正常使用时同一台电脑只运行其中一种。
