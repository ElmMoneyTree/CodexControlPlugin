# CodexControlPlugin

> [!IMPORTANT]
> **0.3.4 支持 Windows 10/11 x64，以及 macOS Apple Silicon / Intel。** Windows 内置 `node.exe`；macOS 使用 Node.js 24 及以上（优先复用 Codex 桌面签名运行时），通过 Unix socket 连接 Codex Desktop。Linux 与 Windows ARM64 尚未支持。

这是 **CodexControlPlugin 的 Windows / macOS 插件安装仓库**。仓库中保存的是 Codex 可以直接安装的 marketplace 和已构建运行文件，不是 Codex Control 主项目的源码仓库。

支持从手机新建聊天：选择 Codex / ChatGPT Work、对应项目或不指定项目，并发送首条消息。请同步更新手机 App 和 Relay；插件更新后重启桌面应用并打开一个已有聊天，以加载新增的 MCP 连接组件。后台服务通过设备凭据认证此组件，手机可继续查看创建结果、阅读消息和回复。

0.3.4 修复手机待办中的异步问题同步与回答，并让 macOS 同步 Agent 随 Codex 应用启动和退出；无需先打开聊天，退出后不再等待 90 秒。

插件安装地址固定为：

```text
https://github.com/ElmMoneyTree/CodexControlPlugin.git
```

用户无需克隆源码、下载 ZIP 或运行构建命令，直接把这个 Git 仓库添加为 Codex marketplace 即可。

## 安装前准备

- 安装、登录并打开 Codex Desktop；安装命令需要支持插件的 Codex CLI（已在 0.153.4 验证），仅有 CLI 不能连接 Desktop 任务；
- 确认目标电脑可以访问已经部署的统一连接服务；
- iPhone App 已经使用 Codex Control 账号登录；
- 如果使用私有 Git 仓库，先让目标电脑的 Git/GitHub 凭据获得读取权限。

这是公开安装仓库，下载安装无需 GitHub 账号或令牌。Windows 已内置 Node.js，macOS 可复用桌面应用签名运行时。

## 用户安装

```powershell
codex plugin marketplace add https://github.com/ElmMoneyTree/CodexControlPlugin.git
codex plugin add codex-control-plugin@codex-control
```

也可以使用 GitHub 简写：

```powershell
codex plugin marketplace add ElmMoneyTree/CodexControlPlugin
codex plugin add codex-control-plugin@codex-control
```

安装完成后：

1. 重启 Codex，或新建一个 Codex 任务。
2. 在 `/hooks` 或 Codex Desktop 的 Hook 管理界面中找到 `CodexControlPlugin`，检查并信任 `SessionStart` Hook。
3. 信任后新建一个 Codex 任务。插件会自动生成密钥设备身份并打开五分钟有效的认领页面，无需输入 Relay 地址、Owner ID 或配对码。
4. 电脑认领页仅显示二维码。用已登录的 iPhone App 扫码，在手机上核对指纹、选择个人或团队空间并批准。
5. 输入“查看 CodexControlPlugin 状态”。状态显示 `connected` 即完成。

If the claim page is closed before expiry, run the same claim command again. The plugin reopens the existing claim instead of creating a duplicate; its short-lived secret remains protected by Windows DPAPI or macOS Keychain and is removed after approval or expiry.

Claim commands print only a safe fingerprint and expiry by default. The explicit `-RevealClaimLink` diagnostic option is for a private local operator terminal only and must not be invoked through Codex or copied into chat logs.

已使用数字配对的旧设备不会被自动迁移。输入“使用 CodexControlPlugin 在 Codex Control 中认领这台设备”即可原位迁移：设备 ID 与任务状态保留，批准后轮换凭据，认领过期时旧连接不受影响。

插件只替代目标电脑上的独立 Device Agent。Relay 和 Controller 仍需分别部署。更多认领、迁移、日志和卸载说明见 [插件配置说明](./PLUGIN-INSTALL.zh-CN.md)。

For a credential-safe Windows verification with Codex Desktop open, run `scripts\verify-device-claim.ps1` for preflight and then add `-BeginClaim` to verify claim completion and the first live Agent sync.

## macOS 使用

macOS 的安装和手机扫码认领步骤与上文相同。凭据保存在当前用户的 Keychain 中，后台同步由用户级 LaunchAgent 管理。无需安装 Windows PowerShell。

在插件目录内可以手动验证和启动：

```bash
bash scripts/macos-agent.sh verify
bash scripts/macos-agent.sh claim
bash scripts/macos-agent.sh status
```

`verify` 检查本机 Desktop IPC，`claim` 打开认领二维码；手机批准后 `status` 应显示 `connected` 和最近同步时间。详细启动、日志与卸载说明见 [插件配置说明](./PLUGIN-INSTALL.zh-CN.md)。

## 用户更新

发布方推送新版本后运行：

```powershell
codex plugin marketplace upgrade codex-control
codex plugin add codex-control-plugin@codex-control
```

更新改变 Hook 内容时，Codex 可能要求重新确认 Hook 信任。更新后应新建任务，让 Codex 加载新版本。

## 插件标识

marketplace 文件中的名称固定为：

```text
codex-control
```

插件名称固定为：

```text
codex-control-plugin
```

因此安装选择器固定为：

```text
codex-control-plugin@codex-control
```

仓库根目录中的 `.agents/plugins/marketplace.json` 供 Codex 识别 marketplace，`plugins/codex-control-plugin/` 是可直接运行的 Windows / macOS 插件发行内容。

## 许可证

CodexControlPlugin 使用 [MIT License](./LICENSE)。发布仓库还包含内置 Node.js 24.19.0 的完整第三方许可证文件：`plugins/codex-control-plugin/THIRD_PARTY_LICENSES_NODE.txt`。
