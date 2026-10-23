# CodexControlPlugin

> [!IMPORTANT]
> **这个 marketplace 当前仅支持 Windows 10/11 x64。** 插件内置 Windows `node.exe`，启动脚本使用 PowerShell，并通过 Windows 命名管道连接 Codex Desktop。macOS、Linux 和 ARM64 暂不支持。

这是 **CodexControlPlugin 的 Windows 插件安装仓库**。仓库中保存的是 Codex 可以直接安装的 marketplace 和已构建运行文件，不是 Codex Control 主项目的源码仓库。

插件安装地址固定为：

```text
https://github.com/ElmMoneyTree/CodexControlPlugin.git
```

用户无需克隆源码、下载 ZIP 或运行构建命令，直接把这个 Git 仓库添加为 Codex marketplace 即可。

## 安装前准备

- 使用 Windows 10/11 x64，并安装、登录和打开 Codex Desktop；本插件通过 Desktop 的本机接口操作任务。
- 安装 Git，并确保 PowerShell 中可以运行 `git --version` 和 `codex --version`。安装命令已在 Codex CLI 0.153.4 验证；CLI 需要支持 `plugin marketplace` 和 `plugin add`。
- 确认电脑可以访问 GitHub 和连接服务 `https://codex-relay.kuajingvs.com`。
- 在 iPhone App中登录自己的 Codex Control 账号，准备认领设备。

这是公开安装仓库，下载安装无需 GitHub 账号或令牌。插件内置 Windows Node.js，无需另外安装 Node.js，也不需要在目标电脑构建源码。

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
3. 信任后再新建一个 Codex 任务。插件会自动打开五分钟有效的设备认领页面；如果没有打开，在任务中输入：

   ```text
   使用 CodexControlPlugin 在 Codex Control 中认领这台设备。
   ```

4. 用已登录的 iPhone App 扫描页面二维码，或直接在页面登录。核对设备指纹，选择个人或团队空间并批准。
5. 输入“查看 CodexControlPlugin 状态”。状态显示 `connected` 即完成。

每台新电脑都使用同一个 GitHub 地址安装，再由使用者独立认领。设备归属取决于批准认领的账号和所选空间；安装仓库中不包含你的个人设备凭据。正常流程不需要手动输入 Relay 地址、Owner ID 或配对码。

插件只替代目标电脑上的独立 Device Agent。Relay 和 Controller 仍需分别部署。更多认领、迁移、日志和卸载说明见 [插件配置说明](./PLUGIN-INSTALL.zh-CN.md)。GitHub marketplace 的分发方式见 [OpenAI 官方说明](https://developers.openai.com/plugins/build/plugins)。

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

仓库根目录中的 `.agents/plugins/marketplace.json` 供 Codex 识别 marketplace，`plugins/codex-control-plugin/` 是可直接运行的 Windows 插件发行内容。

## 许可证

CodexControlPlugin 使用 [MIT License](./LICENSE)。发布仓库还包含内置 Node.js 24.19.0 的完整第三方许可证文件：`plugins/codex-control-plugin/THIRD_PARTY_LICENSES_NODE.txt`。

## 更新到 0.2.2

```powershell
codex plugin marketplace upgrade codex-control
codex plugin add codex-control-plugin@codex-control
```

本版修复 Windows 认领后 Agent 的启动路径、桌面工具桥不可用时的同步，以及首次使用缺少任务索引时的同步。保留原设备身份，无需重新认领。若设备已认领但仍未 connected，在新版插件目录执行 `scripts/restart-agent.ps1`，保持 Codex Desktop 打开，再通过 `scripts/get-agent-status.ps1` 检查连接状态。认领页的成功提示和自动关闭还需要服务端 Relay 0.2.2。
