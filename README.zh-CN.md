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

由两部分组成，但打包成同一个 Obsidian 插件文件夹一起分发：

- `obsidian-plugin/` —— 一个很薄的 Obsidian 插件（`wechat-bridge`），跟 Claudian 一起跑在 Obsidian 里。它对外暴露一个本地 HTTP 接口，直接操作 Claudian 自己的聊天 Tab / 运行时对象，跟 Claudian 自己的 UI 走的是同一套逻辑。
- `obsidian-plugin/relay.py` —— 跟插件放在同一个文件夹里的 Python 脚本，负责说微信 ClawBot 的协议（扫码登录、长轮询 `getUpdates`、`sendMessage`），把纯文本在微信和这个 Obsidian 插件的 HTTP 接口之间来回转发。

`relay.py` 整个生命周期都由插件自己管理：加载时，插件会找一个系统 Python，在自己的插件文件夹里建一个专用虚拟环境（`venv/`，只在第一次运行时建）、装好需要的 Python 包，如果还没登录过微信就在 Obsidian 里弹一个二维码登录窗口，然后把 `relay.py serve` 当自己的子进程拉起来。插件被禁用或者 Obsidian 关闭，relay 进程也会跟着一起没。不需要单独安装、配置，或者手动保持它常驻——启用插件本身就是全部的安装步骤。

这两部分不会同时跟"微信服务器"和"Obsidian 内部对象"打交道——它们之间唯一的接口就是那次 HTTP 调用，而且永远不会离开 `127.0.0.1`。

## 架构

```
微信用户
    |
    v
微信 ClawBot（官方功能，腾讯服务器）
    |  iLink API：扫码登录、长轮询 getUpdates、sendMessage
    v
relay.py                                    （随插件一起打包，由插件拉起并管理）
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

- 零配置连接：插件自己搭建 Python 环境、通过 Obsidian 内嵌的窗口完成微信首次扫码登录、自己管理 relay 进程——启用插件就是全部的安装步骤。
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
- 上下文窗口用量：每一次真实回复（微信触发的，或 `/listen` 镜像推送的）末尾都会带上一行"上下文窗口：已用/总量"，双语，读取自 Claudian 自己的会话元数据。

## 依赖要求

- 桌面版 Obsidian（Claudian 是 `isDesktopOnly`，本项目也是）。目前在 Windows 上开发和测试；插件和 `relay.py` 本身都没有 Windows 专属的代码，macOS/Linux 理论上验证后也能用。
- 已安装并启用 [Claudian](https://github.com/YishenTu/claudian)，并配置好一个可用的 provider（本项目目前只管 provider id 为 `claude` 的这个）。
- 微信（iOS 或安卓）能使用官方 ClawBot 功能。
- 电脑上 `PATH` 里能找到 Python 3.11+（`python`、`python3`、或 Windows 的 `py` 启动器）。插件只需要能找到它一次，用来建自己的专用虚拟环境——不会用你的系统 Python 做别的事，也不需要你提前装好 `wechat-clawbot` 或任何其他包。
- Node.js 和 npm，仅在你要从源码构建插件时才需要，装现成打包好的发布版就不需要。

## 安装

```
cd obsidian-plugin
npm install
npm run build
```

把 `obsidian-plugin/` 整个文件夹里的内容——`manifest.json`、`main.js`、`relay.py`，如果有的话还有 `data.json`——复制（或软链接）到 `<vault>/.obsidian/plugins/wechat-bridge/`，然后在 设置 -> 第三方插件 里启用 "WeChat Bridge"。记得至少打开一次 Claudian 侧边栏，这样插件才能找到一个视图挂上去。

到这就完了。插件第一次加载时会依次：

1. 找系统 Python，在自己的插件文件夹里建 `venv/`（几秒钟，会有 Notice 提示）。
2. 往这个 venv 里装它需要的 Python 依赖（第一次需要联网）。
3. 如果还没有保存过微信登录状态，在 Obsidian 里弹一个带二维码的窗口——用微信扫码连接 ClawBot。
4. 把 `relay.py serve` 当自己的子进程拉起来，开始转发。

从此以后，启用插件就够了：不需要单独开终端、不需要手动 `pip install`、不需要自己配置开机自启项。禁用/卸载插件，relay 进程也会跟着停掉。

插件的 HTTP 接口永远只监听 `127.0.0.1:39217`，不会暴露在任何网络接口上。如果你想自己手动管理 Python 那一侧，`relay.py` 仍然可以手动运行（`python relay.py login` / `python relay.py serve`）——但**不要在插件启用的同时手动跑一个 `serve`**：插件每次加载都会拉起自己的 `relay.py serve`，并不会检测是否已经有一个实例在跑，两边同时跑会变成两个进程抢同一个微信账号。

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

**relay 的整个生命周期由 `RelayManager` 管理，跟插件自己绑定在一起。** 它会依次尝试 `python`/`python3`/`py` 这几个命令，找到能用的就用它在插件自己的文件夹里建一个专用 `venv/`（完全不碰系统全局的 Python 包），往里面装好那几个依赖，然后才把 `relay.py serve` 当一个直接的子进程（不是 detached）拉起来——这样 relay 的生命周期就精确地等于插件的生命周期，不需要额外配置任何操作系统层面的开机自启项。首次登录复用的是 `relay.py` 原有的扫码登录流程，只是多加了个 `--json` 参数，让它往 stdout 输出一行一个的 JSON 事件（`qrcode`/`success`/`failed`）而不是人类阅读的日志文字，插件这边用 Node 的 `readline` 读取，再用一个很小的、纯 JS、没有原生依赖的二维码渲染库（`qrcode-generator`）把二维码直接渲染进一个 Obsidian 的 `Modal` 里——也就是说二维码是本地生成的，不是从任何地方拉取的图片。

## 已知限制

- 设计上只针对单个微信 ClawBot 绑定、单个 Claudian provider（`claude`），不是为多账号或多 provider 路由设计的。
- 微信 ClawBot 同一时间只允许绑定一个端点。
- 机器人不能主动发起对话；微信协议要求必须用户先发消息，才能被动回复。
- 如果 Claudian 在很早期就回滚了一轮对话（比如 provider 服务还没初始化好，此时还没有任何 assistant 文字生成），这个失败只会以 Obsidian 的 `Notice` 弹层形式出现，本插件看不到这个弹层。这种情况下微信只会收到一条通用的"没有回复"提示，而不是具体的报错内容。
- 同时从 Claudian 自己的 UI 和从微信操作并不是完全无竞争的；发给插件 HTTP 接口的请求会被串行处理，但两边同时往同一个 Tab 里打字并不是这个项目设计要支持的场景。
- 插件不会检测是否已经有一个 `relay.py serve` 在跑就直接拉起自己的——如果你在插件启用的同时又手动跑了一个，会变成两个进程同时轮询同一个微信账号。

## 致谢

- [Claudian](https://github.com/YishenTu/claudian)（作者 Yishen Tu）—— 本项目驱动的 Obsidian 插件。
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot)（作者 nightsailer / Pan Fan）—— 本项目 relay 部分构建于其提供的微信 ClawBot iLink API Python 客户端之上；它的 `claude_channel` 模块（一个 Claude Code MCP channel 桥接实现）也是本项目长轮询和回复发送流程的参考对象。
- 更广泛的微信 ClawBot ↔ Claude Code channel 桥接社区（例如 `Johnixr/claude-code-wechat-channel` 及其 Windows 移植版 `HaFred/cc-wechat-channel-windows`），启发了本项目"只转发最终文字、过滤工具/思考噪音"的回复过滤思路。

## 许可

目前仅用于单台机器、单个 vault 的个人使用；未包含 license 文件，暂不用于分发。
