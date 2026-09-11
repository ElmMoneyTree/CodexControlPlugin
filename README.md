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

- 安装 Codex Desktop 或 Codex CLI 0.153.4 及以上版本；
- 确认目标电脑可以访问已经部署的 Relay；
- 在连接同一个 Relay 的 Controller 中准备生成一次性配对码；
- 如果使用私有 Git 仓库，先让目标电脑的 Git/GitHub 凭据获得读取权限。

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
