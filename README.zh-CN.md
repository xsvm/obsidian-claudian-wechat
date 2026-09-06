# Claudian WeChat Bridge

中文 | [English](README.md)

![version](https://img.shields.io/badge/version-v1.0.2-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-desktop-lightgrey)
![Obsidian](https://img.shields.io/badge/Obsidian-plugin-7c3aed)
![stack](https://img.shields.io/badge/built_with-TypeScript_%7C_Python-3178c6)

通过微信官方 ClawBot（iLink）接口，远程遥控驱动 Obsidian 里的 [Claudian](https://github.com/YishenTu/claudian) AI 编程 Agent。

微信消息会被实时转发进一个正在运行的 Claudian 会话，Claudian 的回复再原路发回同一个微信对话——让微信聊天窗口变成你随身携带的 Obsidian Agent 遥控器。

## 项目概览

Claudian 把 Claude Code（以及其他编程 agent）嵌入 Obsidian 的侧边栏聊天窗口。微信 ClawBot 是微信官方开放的能力，允许一个 bot 账号通过长轮询 HTTP 接口跟微信用户收发消息。这两边彼此完全不知道对方的存在，本项目就是连接二者的坚固桥梁。

由两部分组成，但打包成同一个 Obsidian 插件文件夹一起分发：

- `obsidian-plugin/` —— Obsidian 插件（`claudian-wechat`），跟 Claudian 一起跑在 Obsidian 里。它对外暴露一个本地 HTTP 接口，直接操作 Claudian 自己的聊天 Tab / 运行时对象，跟 Claudian 自己的 UI 走的是同一套逻辑。
- `obsidian-plugin/relay.py` —— 跟插件放在同一个文件夹里的 Python 脚本，负责对接微信 ClawBot 协议（扫码登录、长轮询 `getUpdates`、`sendMessage`），在微信和 Obsidian 插件本地 HTTP 接口之间双向转发文字与图片。

`relay.py` 整个生命周期都由插件自己管理：加载时，插件会查找系统 Python，在插件文件夹内建立专属虚拟环境（`venv/`，只在首次运行时创建）、装好所需 Python 依赖包，若尚未登录微信则在 Obsidian 内弹出二维码扫码登录窗口，随后启动 `relay.py serve` 作为子进程。插件被禁用或 Obsidian 关闭时，relay 进程自动退出。无需单独安装、配置或维持常驻后台服务——启用插件即完成全部设置。

两部分之间唯一的接口是本机 HTTP 调用，永远只在 `127.0.0.1` 环回接口通信。

## 架构

```
微信用户 (手机端)
    |
    v
微信 ClawBot（官方能力，腾讯服务器）
    |  iLink API：扫码登录、长轮询 getUpdates、sendMessage
    v
relay.py                                    （随插件打包，由插件拉起并管理）
    |  HTTP POST 127.0.0.1:39217/message     （仅本机回环）
    v
obsidian-plugin (claudian-wechat)            （TypeScript，运行在 Obsidian 内）
    |  在运行时调用已加载的 Claudian 插件实例
    v
Claudian (github.com/YishenTu/claudian)      （通过运行时对象驱动）
    |
    v
Claude Code / 你配置的 provider
```

## 功能特性

- **零配置一键连接**：插件自主搭建 Python 虚拟环境、通过 Obsidian 内嵌 Modal 弹窗完成微信扫码登录、自主管理 relay 子进程生命周期。
- **双向会话流转**：微信文本及图片无缝注入 Claudian 专属 Tab，AI 回复与执行状态原路回传微信。
- **多图连续发送**：支持连续发送多张图片累积缓存，可通过文字消息一并带入说明发送，或使用 `/skip` 直接单发。
- **对话切换防护**：发送前后与发送中自动校验目标会话 ID，防止因电脑端切换 Tab 导致消息发错或回复丢失，遇到切换自动核实真实结果。
- **微信端会话管理**：
  - `/list` 或 `/ls` —— 列出 Claudian 已有会话（按更新时间倒序排列）
  - `/switch N` 或 `/goto N` —— 快速切换绑定至列表第 `N` 个会话
  - `/new` —— 解绑当前会话，下一条消息自动开启全新会话
- **运行时设置切换**：从微信端自由调节 `/model`（不带参数查看可用模型列表）、`/effort`（思考强度）、`/permission`（权限模式）。
- **斜杠命令透传**：`/commands` 发现 Claude 内置命令、vault 命令及 skills；所有斜杠命令均可直接发送执行。
- **双向镜像监听 (`/listen`)**：开启后，你在电脑端直接敲入的 Claudian 交互也会实时同步镜像至微信。
- **降噪回复过滤**：智能过滤工具调用、中间思考及子代理细节，仅将最终 assistant 叙述推回微信，保持移动端体验清晰整洁。
- **完整双语支持**：插件所有交互提示、帮助指令均支持中英双语，根据 Claudian 的 `locale` 配置自动切换。
- **上下文用量提示**：每轮真实回复末尾附带上下文窗口 token 消耗统计。

## 依赖要求

- 桌面版 Obsidian（Claudian 与本项目均为 `isDesktopOnly`，支持 Windows / macOS / Linux）。
- 已安装并启用 [Claudian](https://github.com/YishenTu/claudian) 插件，并配置好可用的 provider（默认 `claude`）。
- 微信账号具备官方 ClawBot 功能权限。
- 系统 `PATH` 中具备 Python 3.11+（用于首次自动构建专用 `venv/`）。
- Node.js 与 npm（仅从源码编译时需要；直接下载 Release 解压则无需安装）。

## 安装

### 方式 A：从 Release 安装（推荐）

1. 从 [Releases 页面](https://github.com/xsvm/obsidian-claudian-wechat/releases) 下载最新发行包。
2. 解压到你的 Vault 插件目录：`<vault>/.obsidian/plugins/claudian-wechat/`。
3. 在 Obsidian 的「设置 -> 第三方插件」中启用 **Claudian WeChat Bridge**。
4. 打开一次 Claudian 侧边栏，插件即可自动挂载。

### 方式 B：从源码构建

```bash
git clone https://github.com/xsvm/obsidian-claudian-wechat.git
cd obsidian-claudian-wechat/obsidian-plugin
npm install
npm run build
```

将 `obsidian-plugin/` 目录中的文件（`manifest.json`、`main.js`、`relay.py`、`strings.json`）复制或软链接至 `<vault>/.obsidian/plugins/claudian-wechat/`，启用即可。

首次加载时插件会自动：
1. 查找系统 Python 并在插件目录创建 `venv/`。
2. 安装依赖包。
3. 弹出微信二维码扫码登录窗口（若未登录过）。
4. 启动后台 relay 并开始双向转发。

## 指令速查

在微信 ClawBot 对话窗口中输入以下指令：

| 指令 | 效果说明 |
| :--- | :--- |
| `/help` | 显示帮助菜单与所有支持的命令 |
| `/list` 或 `/ls` | 按时间倒序分页列出已知会话编号 |
| `/switch N` 或 `/goto N` | 切换到指定编号的会话 |
| `/new` | 解绑当前会话并开启全新会话 |
| `/model` | 查看当前 provider 可用模型（claude 为固定列表，其他 provider 为已探测到的模型） |
| `/model <名称>` | 切换模型（如 `/model opus`、`/model sonnet`） |
| `/effort <等级>` | 切换思考强度（如 `/effort low`、`/effort high`） |
| `/permission <模式>` | 切换权限模式（如 `/permission yolo`、`/permission default`） |
| `/status` | 查看当前模型、思考强度、权限模式及监听状态 |
| `/hist` | 按序号列出当前绑定会话的历史输入 |
| `/hist N` | 查看历史第 `N` 条对应的 AI 回复 |
| `/skip` | 立即单发已接收并缓存的所有图片（无需追加文字说明） |
| `/listen on` / `/listen off` | 开关桌面端操作实时镜像推送到微信 |
| `/commands` | 列出 Claude Code 自带的所有可用斜杠命令 |
| *其他任何文本* | 直接作为普通提示词发送给 Claudian 处理 |

## 设计说明

- **非侵入式调用**：通过 Claudian 原生公开方法 `claudian.mutateSettings(...)` 及 `InputController.sendMessage(...)` 交互，不模拟 DOM 也不暴力覆写配置文件，与桌面 UI 操作行为完全一致。
- **纯本地隔离**：插件 HTTP 服务严格绑定在 `127.0.0.1:39217`，无外部网络暴露风险。
- **生命周期精准联动**：`relay.py` 作为插件子进程由 `RelayManager` 严格管控，避免残留僵尸进程或端口占用冲突。

## 致谢

- [Claudian](https://github.com/YishenTu/claudian) (by Yishen Tu) —— 强大的 Obsidian Claude Code 嵌入插件。
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot) (by nightsailer / Pan Fan) —— 提供了优秀的微信 ClawBot iLink API Python 封装。
- 微信 ClawBot ↔ Claude Code 社区（包括 `claude-code-wechat-channel` 等项目）对降噪过滤设计的启发。

## 社区

欢迎加入微信交流群，提问、反馈或获取最新动态：

![微信群二维码](assets/wechat-group-qrcode.png)

## 许可

本项目基于 [MIT 许可证](LICENSE) 开源。
