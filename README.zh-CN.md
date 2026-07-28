# wechat-relay

中文 | [English](README.md)

![version](https://img.shields.io/badge/version-v0.1.0-blue)
![platform](https://img.shields.io/badge/platform-desktop-lightgrey)
![Obsidian](https://img.shields.io/badge/Obsidian-plugin-7c3aed)
![stack](https://img.shields.io/badge/built_with-TypeScript_%7C_Python-3178c6)

通过微信官方 ClawBot（iLink）接口，驱动 Obsidian 里的 [Claudian](https://github.com/YishenTu/claudian) 插件。

微信消息会被实时转发进一个正在运行的 Claudian 会话，Claudian 的回复再原路发回同一个微信对话——让任意一个微信聊天窗口都能变成你 Obsidian agent 的遥控器。

## 项目概览

Claudian 把 Claude Code（以及其他编程 agent）嵌入 Obsidian 的侧边栏聊天窗口。微信 ClawBot 是微信官方开放的能力，允许一个 bot 账号通过长轮询 HTTP 接口跟微信用户收发消息。这两边彼此完全不知道对方的存在，这个项目就是中间那一层。

由两个相互独立的部分组成：

- `obsidian-plugin/` —— 一个很薄的 Obsidian 插件（`wechat-bridge`），跟 Claudian 一起跑在 Obsidian 里。它对外暴露一个本地 HTTP 接口，直接操作 Claudian 自己的聊天 Tab / 运行时对象，跟 Claudian 自己的 UI 走的是同一套逻辑。
- `relay/relay.py` —— 一个独立运行的 Python 进程，负责说微信 ClawBot 的协议（扫码登录、长轮询 `getUpdates`、`sendMessage`），把纯文本在微信和这个 Obsidian 插件的 HTTP 接口之间来回转发。

这两部分不会同时跟"微信服务器"和"Obsidian 内部对象"打交道——它们之间唯一的接口就是那次 HTTP 调用，而且永远不会离开 `127.0.0.1`。

## 架构

```
微信用户
    |
    v
微信 ClawBot（官方功能，腾讯服务器）
    |  iLink API：扫码登录、长轮询 getUpdates、sendMessage
    v
relay/relay.py                              （本仓库，Python，常驻运行）
    |  HTTP POST 127.0.0.1:39217/message     （仅本机回环）
    v
obsidian-plugin (wechat-bridge)              （本仓库，TypeScript，运行在 Obsidian 内）
    |  在运行时调用已加载的 Claudian 插件实例
    v
Claudian (github.com/YishenTu/claudian)      （未做任何修改——通过它自己的对象驱动）
    |
    v
Claude Code / 你配置的 provider
```

## 功能

- 双向对话：微信消息会被当作手动输入注入到 Claudian 专属的一个 Tab 里，Claudian 的回复会发回同一个微信对话。
- 从微信管理会话：
  - `/list` —— 列出 Claudian 已有的会话（按更新时间倒序）
  - `/switch N` —— 把桥接切换到上一次 `/list` 里的第 `N` 个会话
  - `/new` —— 与当前会话解绑；下一条消息会开始一个全新的会话
- 从微信控制设置：`/model`、`/effort`、`/permission` 可以改变 Claudian 当前的模型、思考强度、权限模式。
- `/commands` —— 列出 Claude 自带的斜杠命令（内置命令、`.claude/commands` 下的 vault 命令、skills），因为微信里没有输入"/"时弹出的自动补全下拉框，这个命令就是让它们在微信里也能被发现。使用这些命令的方式就是直接把它们当普通消息发送——本插件本来就会把所有不认识的内容原样转发，所以 `/compact` 之类的命令不需要任何特殊处理就能用。
- `/status` —— 查看当前模型、思考强度、权限模式，以及 `/listen` 是否开启。
- `/hist` 和 `/hist N` —— 按序号列出你在当前绑定会话里发过的消息，并且能查看其中某一条对应的回复，遵循和正常回复一样的过滤规则。
- `/listen on` / `/listen off` —— 把电脑上的 Claudian 客户端镜像到微信：开启后，你直接在 Claudian 里打的字（不经过微信）也会推送到同一个微信对话，格式是对话标题、你打的 `prompt：`，然后是回复内容。
- 回复过滤：只把 assistant 最终的文字叙述发给微信，工具调用、思考过程、子代理这些执行细节不会被转发。
- 双语回复：这个插件发出的所有文字（帮助、列表、确认提示、报错）都同时准备了中文和英文版本，语言会根据 Claudian 自己的 `locale` 设置自动选择——不需要额外维护一份语言设置。
- 带重试的转发：跟 Obsidian 插件的连接出现暂时性失败时，会先按短间隔重试几次，重试全部失败才会报错，而不是每次小抖动都直接报给你看。
- 对开机自启友好：relay 设计成可以无控制台窗口静默运行，并且能容忍在 Obsidian 还没加载完时就被拉起。

## 依赖要求

- 桌面版 Obsidian（Claudian 是 `isDesktopOnly`，本项目也是）。目前在 Windows 上开发和测试；插件和 relay 脚本本身都没有 Windows 专属的代码，唯一例外是那个可选的开机自启辅助脚本，所以其他桌面平台理论上验证后也能用。
- 已安装并启用 [Claudian](https://github.com/YishenTu/claudian)，并配置好一个可用的 provider（本项目目前只管 provider id 为 `claude` 的这个）。
- 微信（iOS 或安卓）能使用官方 ClawBot 功能。
- Node.js 和 npm，用来从源码构建 Obsidian 插件。
- Python 3.11+ 以及 [`wechat-clawbot`](https://github.com/nightsailer/wechat-clawbot)（`pip install wechat-clawbot`），`relay.py` 就是built在它提供的微信 ClawBot iLink 协议客户端（扫码登录、长轮询、媒体/CDN 处理）之上的。

## 安装

### 1. Obsidian 插件

```
cd obsidian-plugin
npm install
npm run build
```

把编译出来的文件——`manifest.json`、`main.js`，如果有的话还有 `data.json`——复制（或软链接）到 `<vault>/.obsidian/plugins/wechat-bridge/`，然后在 设置 -> 第三方插件 里启用 "WeChat Bridge"。记得至少打开一次 Claudian 侧边栏，这样插件才能找到一个视图挂上去。

这个插件只监听 `127.0.0.1:39217`，不会暴露在任何网络接口上。

### 2. 微信 relay

```
pip install wechat-clawbot
cd relay
python relay.py login   # 一次性扫码登录，同时会生成 qrcode.png
python relay.py serve   # 常驻运行：双向转发消息
```

`login` 只需要跑一次（凭据会被 `wechat-clawbot` 缓存到 `~/.claude/channels/wechat/`）。`serve` 是需要一直跑着的常驻进程（见下面的开机自启部分）。

### 3. 开机自启（可选）

目标机器上用两个 Windows 启动文件夹快捷方式来实现：

- Obsidian 本体，正常启动（它会自动重新打开上次的 vault）。
- `relay.py serve`，通过一个很小的 `.vbs` 包装脚本静默启动，避免 `pythonw` 没有控制台导致基于 `print()` 的日志出问题，输出被重定向到日志文件。

`relay.py serve` 会在第一次请求前等待十秒，给 Obsidian 和插件留出加载时间；不管启动顺序如何，它之后都能自愈重试。

## 用法

在 ClawBot 对话里发送以下任意一种：

| 命令 | 效果 |
| --- | --- |
| `/help` | 显示命令用法 |
| `/list` 或 `/ls` | 列出已知会话，编号、按最新更新排序 |
| `/switch N` 或 `/goto N` | 切换到上一次 `/list` 里的第 `N` 个会话 |
| `/new` | 开始一个全新的会话 |
| `/model <名称>` | 切换模型，如 `/model opus`、`/model sonnet` |
| `/effort <等级>` | 切换思考强度，如 `/effort low`、`/effort high` |
| `/permission <模式>` | 切换权限模式，如 `/permission yolo`、`/permission default` |
| `/status` | 查看当前模型、思考强度、权限模式、监听状态 |
| `/hist` | 按序号列出当前绑定会话里你发过的消息 |
| `/hist N` | 查看第 `N` 条消息对应的回复 |
| `/listen on` / `/listen off` | 开关"电脑客户端消息也推送到微信"这个镜像功能 |
| `/commands` | 列出 Claude 自带的斜杠命令（跟上面这些插件命令是两回事） |
| 其他任何内容 | 作为普通聊天消息发给 Claudian —— Claude 自带的斜杠命令也是这样直接发送使用的 |

以上全部支持双语；回复是中文还是英文取决于 Claudian 的 `locale` 设置。

## 设计说明

**设置的修改走的是 Claudian 自己的 API，不是直接改它的配置文件。** `/model`、`/effort`、`/permission` 调用的是 `claudian.mutateSettings(...)`——这是 Claudian 插件类本来就公开的方法，Claudian 自己工具栏里的下拉框内部调用的也是它（源码 `Tab.ts` 里的 `updateTabProviderSettings` 用的是同一个调用）。本插件只是复刻了 Claudian 的 `ProviderSettingsCoordinator` 所做的那一点点 `model` <-> `savedProviderModel.claude` 式镜像逻辑，然后让打开的视图刷新一下（`view.refreshModelSelector()`），这样 UI 和硬盘上的 `.claudian/claudian-settings.json` 会保持跟手动点击时一样的一致性。本插件从来不会自己打开 `claudian-settings.json` 去写。

**消息注入复用的是 Claudian 自己的发送路径。** `InputController.sendMessage({ content })` 跟输入框发送按钮调用的是同一个方法；它本来就支持不经过 DOM 的 `content` 覆盖参数，所以这里也完全不涉及模拟 UI 操作或者改配置。

**会话列表直接读取 Claudian 落盘的会话元数据（`.claudian/sessions/*.meta.json`）**，因为这是稳定的纯只读数据，没必要非得走一遍运行时 API。

**`/commands` 读的是 Claudian 自己"/"下拉框用的同一份命令目录。** 它调用的是 `TabManager.getSdkCommands(tabId)`，这正是 Claudian 输入框自动补全用来获取命令列表的方法，所以这里列出来的内容永远和你在 Claudian UI 里输入"/"看到的一致。

**`/listen` 是"推"而不是"拉"，所以需要单独一条通道。** 微信的协议只允许 relay 回复用户发来的消息，没法自己主动发起一条新消息。插件用一个定时器轮询已绑定 Tab 的消息列表，`/listen` 开启时，检测有没有不经过自己的 `sendChatMessage()`（也就是直接在 Claudian 桌面端敲出来的）新增内容，格式化后放进一个队列。relay 那边则每隔几秒轮询插件的 `GET /pending` 接口，如果队列里有东西，就用最近一次见到的那个微信用户的 `context_token` 发给他——这跟 `wechat-clawbot` 自己那套"复用最近一次 context_token"的缓存机制是同一个思路。

以上都不是 Claudian 正式声明、有版本保证的公开 API，而是通过 `app.plugins.plugins["realclaudian"]` 拿到的内部对象。TypeScript 的 `private` 只在编译期起作用，所以这样能行得通，但这也意味着它跟 Claudian 当前的内部结构是耦合的，Claudian 版本更新时可能需要跟着做小幅调整。

## 已知限制

- 设计上只针对单个微信 ClawBot 绑定、单个 Claudian provider（`claude`），不是为多账号或多 provider 路由设计的。
- 微信 ClawBot 同一时间只允许绑定一个端点。
- 机器人不能主动发起对话；微信协议要求必须用户先发消息，才能被动回复。
- 如果 Claudian 在很早期就回滚了一轮对话（比如 provider 服务还没初始化好，此时还没有任何 assistant 文字生成），这个失败只会以 Obsidian 的 `Notice` 弹层形式出现，本插件看不到这个弹层。这种情况下微信只会收到一条通用的"没有回复"提示，而不是具体的报错内容。
- 同时从 Claudian 自己的 UI 和从微信操作并不是完全无竞争的；发给插件 HTTP 接口的请求会被串行处理，但两边同时往同一个 Tab 里打字并不是这个项目设计要支持的场景。

## 致谢

- [Claudian](https://github.com/YishenTu/claudian)（作者 Yishen Tu）—— 本项目驱动的 Obsidian 插件。
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot)（作者 nightsailer / Pan Fan）—— 本项目 relay 部分构建于其提供的微信 ClawBot iLink API Python 客户端之上；它的 `claude_channel` 模块（一个 Claude Code MCP channel 桥接实现）也是本项目长轮询和回复发送流程的参考对象。
- 更广泛的微信 ClawBot ↔ Claude Code channel 桥接社区（例如 `Johnixr/claude-code-wechat-channel` 及其 Windows 移植版 `HaFred/cc-wechat-channel-windows`），启发了本项目"只转发最终文字、过滤工具/思考噪音"的回复过滤思路。

## 许可

目前仅用于单台机器、单个 vault 的个人使用；未包含 license 文件，暂不用于分发。
