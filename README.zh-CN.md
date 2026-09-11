# CodexControlPlugin 安装说明

这个插件用于替代目标电脑上的独立 `Codex Device Agent` 安装程序。Relay 和 Controller 仍然独立部署。

## 系统要求

- Windows 10/11 x64
- Codex Desktop 或 Codex CLI 0.153.4 及以上；当前版本已在 0.153.4 验证
- 目标电脑能够访问 Relay
- Controller 已经连接同一个 Relay

## 安装

如果插件已经发布为 Git marketplace，可以直接使用 Git 地址安装，见 [Git 安装说明](./PLUGIN-GIT-INSTALL.zh-CN.md)。下面是本地 ZIP 安装方式。

1. 解压 `CodexControlPlugin-0.1.0-win-x64.zip` 到稳定目录。安装后不要移动或删除该目录，因为它是本地插件市场源。
2. 在解压目录运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1
   ```

3. 重启 Codex，或至少新建一个 Codex 任务。
4. 首次加载时在 Codex CLI 执行 `/hooks`，或在 Codex Desktop 打开 Hook 管理界面。检查 `CodexControlPlugin` 的 `SessionStart` Hook，然后选择信任。Codex 会把信任绑定到 Hook 内容哈希；插件升级后内容变化时需要重新检查。

## 配对

1. 退出旧的独立 `Codex Device Agent`，防止 Controller 同时出现两个相同设备。
2. 在 Controller 中点击“连接新设备”，取得新的十分钟一次性配对码。
3. 在目标电脑新建 Codex 任务并输入：

   ```text
   使用 CodexControlPlugin 连接这台设备。
   Relay 是 http://192.168.18.34:8787，配对码是 <当前配对码>，设备名是 <设备名>。
   ```

4. Codex 会调用插件自带配置脚本。设备令牌使用 Windows DPAPI 按当前用户加密，不会写入聊天。
5. 继续输入“查看 CodexControlPlugin 状态”。状态为 `connected`，并显示最近同步时间和任务数量时，配对完成。

## 自动启动和退出

- 每次 Codex 会话启动或恢复，`SessionStart` Hook 会运行一个短启动器。
- 启动器检测单实例锁；Agent 已运行时立即退出，不会重复启动。
- Agent 在后台轮询 Relay，并连接本机 Codex IPC。
- Codex Desktop 持续不可用 90 秒后，插件 Agent 自动退出。
- 仅打开 Codex 首页但没有启动或恢复任务时，`SessionStart` 可能尚未触发；打开任意任务即可。

## 状态和日志

为兼容已经配对的旧版本，默认数据目录继续使用：

```text
%LOCALAPPDATA%\Codex Control Agent Plugin
```

其中：

- `agent-config.json`：DPAPI 加密后的配对信息
- `status.json`：连接状态和最近同步信息，不含明文令牌
- `agent.log`：后台 Agent 日志，不含明文令牌

## 断开或卸载

可以在 Codex 中输入“断开这台设备的 CodexControlPlugin”，也可以在原解压目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1
```

卸载脚本会停止插件 Agent、删除本机配对配置、卸载插件并移除本地市场配置。Relay 中已有的设备记录目前仍会保留并显示离线。

## 与独立 Agent 的关系

插件和独立安装包复用同一份 `packages/agent-core`。独立安装包保留用于不支持插件或禁用了 Hook 的环境；正常使用时同一台电脑只运行其中一种。
