# CodexControlPlugin 通过 Git 安装

> [!IMPORTANT]
> **这个 marketplace 当前仅支持 Windows 10/11 x64。** 插件内置 Windows `node.exe`，启动脚本使用 PowerShell，并通过 Windows 命名管道连接 Codex Desktop。macOS、Linux 和 ARM64 暂不支持。

Codex CLI 可以把 Git 仓库作为插件 marketplace。CodexControlPlugin 发布后，用户无需下载 ZIP 或运行本地安装脚本，只需添加仓库并安装插件。

## 安装前准备

- 安装 Codex Desktop 或 Codex CLI 0.153.4 及以上版本；
- 确认目标电脑可以访问已经部署的 Relay；
- 在连接同一个 Relay 的 Controller 中准备生成一次性配对码；
- 如果使用私有 Git 仓库，先让目标电脑的 Git/GitHub 凭据获得读取权限。

## 用户安装

如果 marketplace 位于独立仓库的默认分支：

```powershell
codex plugin marketplace add https://github.com/<owner>/<marketplace-repo>
codex plugin add codex-control-plugin@codex-control
```

也可以使用简写或 SSH 地址：

```powershell
codex plugin marketplace add <owner>/<marketplace-repo>
codex plugin marketplace add git@github.com:<owner>/<marketplace-repo>.git
```

如果 marketplace 发布在现有代码仓库的 `plugin-marketplace` 分支：

```powershell
codex plugin marketplace add https://github.com/<owner>/<repo> --ref plugin-marketplace
codex plugin add codex-control-plugin@codex-control
```

安装完成后：

1. 重启 Codex，或新建一个 Codex 任务。
2. 在 `/hooks` 或 Codex Desktop 的 Hook 管理界面中找到 `CodexControlPlugin`，检查并信任 `SessionStart` Hook。
3. 在 Controller 中点击“连接新设备”，生成新的十分钟一次性配对码。
4. 在目标电脑的 Codex 任务中输入：

   ```text
   使用 CodexControlPlugin 连接这台设备。
   Relay 是 https://relay.example.com，配对码是 <当前配对码>，设备名是 <设备名>。
   ```

5. 输入“查看 CodexControlPlugin 状态”。状态显示 `connected` 即完成。

插件只替代目标电脑上的独立 Device Agent。Relay 和 Controller 仍需分别部署。更多配对、日志和卸载说明见 [插件配置说明](./PLUGIN-INSTALL.zh-CN.md)。

## 用户更新

发布方推送新版本后运行：

```powershell
codex plugin marketplace upgrade codex-control
codex plugin add codex-control-plugin@codex-control
```

更新改变 Hook 内容时，Codex 可能要求重新确认 Hook 信任。更新后应新建任务，让 Codex 加载新版本。

## 发布 marketplace 仓库

在 Windows x64 构建机上，从本项目根目录运行：

```powershell
pnpm run plugin:build
```

可发布目录为：

```text
dist/CodexControlPlugin
├── .agents/plugins/marketplace.json
├── plugins/codex-control-plugin/
├── README.md
├── PLUGIN-INSTALL.zh-CN.md
├── LICENSE
├── .gitignore
└── .gitattributes
```

把这个目录的**内容**提交到独立 Git 仓库的根目录，或提交到现有仓库的专用 `plugin-marketplace` 分支。不要再套一层 `CodexControlPlugin` 目录，否则 Codex 无法在仓库根目录找到 `.agents/plugins/marketplace.json`。

发布内容必须包含生成后的 `plugins/codex-control-plugin/runtime/`。源码目录 `plugins/codex-control-plugin` 本身不包含 Node.js 和 Agent 运行时，不能直接作为远程 marketplace 的插件来源。

当前 Windows `node.exe` 接近 GitHub 单文件 100 MiB 上限。每次升级 Node.js 后都应检查文件大小；如果超过托管平台限制，应改用发布专用仓库或下载式启动器，并重新做安装安全审查。

## 仓库结构约束

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

Git 仓库可以是公开或私有仓库。私有仓库需要目标电脑上的 Git/GitHub 凭据能够读取该仓库。

## 许可证

CodexControlPlugin 使用 [MIT License](./LICENSE)。发布仓库还包含内置 Node.js 24.19.0 的完整第三方许可证文件：`plugins/codex-control-plugin/THIRD_PARTY_LICENSES_NODE.txt`。
