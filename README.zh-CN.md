# CodexControlPlugin 安装说明

这个插件用于替代目标电脑上的独立 `Codex Device Agent` 安装程序。Relay 和 Controller 仍然独立部署。

## 系统要求

- Windows 10/11 x64
- 已安装、登录并打开 Codex Desktop；仅安装 CLI 无法连接 Desktop 任务
- 已安装 Git，且 PowerShell 中可以运行 `git --version` 和 `codex --version`；安装命令已在 Codex CLI 0.153.4 验证
- 目标电脑能够访问 GitHub 和默认连接服务 `https://codex-relay.kuajingvs.com`
- iPhone App 或浏览器已经使用自己的 Codex Control 账号登录

安装仓库公开可读，无需 GitHub 账号。插件已经内置 Windows Node.js，目标电脑无需安装 Node.js 或编译源码。

## 安装

推荐通过独立的插件安装仓库直接安装。该仓库包含可运行的 Windows 插件发行内容，不是 Codex Control 主项目源码仓库：

```powershell
codex plugin marketplace add https://github.com/ElmMoneyTree/CodexControlPlugin.git
codex plugin add codex-control-plugin@codex-control
```

下面是本地 ZIP 安装方式。

1. 解压 `CodexControlPlugin-0.2.0-win-x64.zip` 到稳定目录。安装后不要移动或删除该目录，因为它是本地插件市场源。
2. 在解压目录运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1
   ```

3. 重启 Codex，或至少新建一个 Codex 任务。
4. 首次加载时在 Codex CLI 执行 `/hooks`，或在 Codex Desktop 打开 Hook 管理界面。检查 `CodexControlPlugin` 的 `SessionStart` Hook，然后选择信任。Codex 会把信任绑定到 Hook 内容哈希；插件升级后内容变化时需要重新检查。

## 认领设备

1. 如果旧的独立 `Codex Device Agent` 正在运行，先退出它，防止 App 同时出现两个相同设备。
2. 信任 Hook 后再新建一个 Codex 任务。插件会自动生成设备身份并打开五分钟有效的认领页面；如果没有打开，在任务中输入：

   ```text
   使用 CodexControlPlugin 在 Codex Control 中认领这台设备。
   ```

3. 用已登录的 iPhone App 扫描页面二维码，或直接在页面登录。核对设备指纹，选择个人或团队空间并批准。
4. 继续输入“查看 CodexControlPlugin 状态”。状态为 `connected`，并显示最近同步时间和任务数量时，认领完成。

每台电脑分别生成设备身份、分别认领。设备令牌和私钥使用 Windows DPAPI 按当前用户加密；不要把一台电脑的数据目录复制给另一台电脑。安装仓库不携带个人账号凭据，正常流程不需要输入 Relay 地址、Owner ID 或配对码。

认领页面在有效期内被关闭时，再运行同一个认领指令可恢复页面。已通过旧配对码连接的设备也可使用这个指令原位迁移；批准成功后才轮换凭据。旧配对码流程仅作为兼容备用方式保留。

## 更新

```powershell
codex plugin marketplace upgrade codex-control
codex plugin add codex-control-plugin@codex-control
```

更新后重启 Codex 并新建任务。Hook 内容变化时需要重新检查并信任；已有设备配置保存在插件目录之外。

## 自动启动和退出

- 第一次可信的 Codex 会话启动时，`SessionStart` Hook 会打开设备认领页面；认领完成后的会话启动或恢复会运行 Agent 启动器。
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

- `agent-config.json`：DPAPI 加密后的设备凭据和空间信息
- `pending-claim.json`：短期认领期间的 DPAPI 加密密钥和轮询凭据，批准或过期后删除
- `status.json`：连接状态和最近同步信息，不含明文令牌
- `agent.log`：后台 Agent 日志，不含明文令牌

## 断开或卸载

如果希望服务器凭据立即失效，先在 iPhone App 中撤销该设备。然后在 Codex 中输入“断开这台设备的 CodexControlPlugin”，并卸载插件：

```powershell
codex plugin remove codex-control-plugin@codex-control
```

使用 ZIP 安装的用户也可以在原解压目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1
```

卸载脚本会停止插件 Agent、删除本机配置、卸载插件并移除市场配置。仅删除本机配置不等于在服务器撤销凭据。

## 与独立 Agent 的关系

插件和独立安装包复用同一份 `packages/agent-core`。独立安装包保留用于不支持插件或禁用了 Hook 的环境；正常使用时同一台电脑只运行其中一种。
