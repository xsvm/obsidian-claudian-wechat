# wechat-relay

[中文](README.zh-CN.md) | English

![version](https://img.shields.io/badge/version-v0.1.0-blue)
![platform](https://img.shields.io/badge/platform-desktop-lightgrey)
![Obsidian](https://img.shields.io/badge/Obsidian-plugin-7c3aed)
![stack](https://img.shields.io/badge/built_with-TypeScript_%7C_Python-3178c6)

Drive the [Claudian](https://github.com/YishenTu/claudian) Obsidian plugin from WeChat, through the official WeChat ClawBot (iLink) interface.

WeChat messages are relayed into a live Claudian session, and Claudian's reply is relayed straight back to the same WeChat conversation — turning any WeChat chat into a remote control for your Obsidian agent.

## Overview

Claudian embeds Claude Code (and other coding agents) as a chat sidebar inside Obsidian. WeChat ClawBot is an official WeChat feature that lets a bot account exchange messages with a WeChat user over a long-poll HTTP API. Neither side knows about the other. This project is the piece in between.

It is made of two independent parts:

- `obsidian-plugin/` — a small Obsidian plugin (`wechat-bridge`) that runs inside Obsidian alongside Claudian. It exposes a local HTTP endpoint and drives Claudian's own chat tab/runtime objects directly, the same way Claudian's own UI does.
- `relay/relay.py` — a standalone Python process that speaks the WeChat ClawBot protocol (QR login, long-poll `getUpdates`, `sendMessage`) and forwards plain text to and from the Obsidian plugin's HTTP endpoint.

Neither part talks to WeChat's servers and Obsidian's internals at the same time. The HTTP call between them is the only seam, and it never leaves `127.0.0.1`.

## Architecture

```
WeChat user
    |
    v
WeChat ClawBot (official, Tencent-hosted)
    |  iLink API: QR login, long-poll getUpdates, sendMessage
    v
relay/relay.py                              (this repo, Python, always running)
    |  HTTP POST 127.0.0.1:39217/message     (loopback only)
    v
obsidian-plugin (wechat-bridge)              (this repo, TypeScript, runs inside Obsidian)
    |  calls into the already-loaded Claudian plugin instance at runtime
    v
Claudian (github.com/YishenTu/claudian)      (not modified — driven through its own objects)
    |
    v
Claude Code / the configured provider
```

## Features

- Two-way chat: a WeChat message is injected into a dedicated Claudian tab as if typed by hand, and Claudian's reply is sent back to the same WeChat conversation.
- Conversation management from WeChat:
  - `/list` — list existing Claudian conversations (most recently updated first)
  - `/switch N` — attach the bridge to conversation number `N` from the last `/list`
  - `/new` — detach from the current conversation; the next message starts a fresh one
- Settings control from WeChat: `/model`, `/effort`, `/permission` change Claudian's active model, effort level, and permission mode.
- `/commands` — list Claude's own slash commands (built-in commands, vault commands under `.claude/commands`, skills) so they are discoverable from WeChat, which has no "/" autocomplete dropdown to browse. Using them is just sending them as a normal message; the bridge already passes anything unrecognized straight through, so `/compact` and friends work without needing to be special-cased.
- `/status` — show the current model, effort level, permission mode, and whether `/listen` is on.
- `/hist` and `/hist N` — list your messages in the bound conversation, numbered, and view the reply to any one of them, filtered through the same rules as a live reply.
- `/listen on` / `/listen off` — mirror the desktop Claudian client into WeChat: while on, turns you type directly into Claudian (not through WeChat) are pushed to the same WeChat conversation too, formatted as the conversation title, the `prompt:` you typed, and the reply.
- Reply filtering: only the assistant's final narrative text is sent to WeChat. Tool calls, thinking blocks, and subagent chatter are not forwarded.
- Bilingual replies: every string this bridge sends (help, lists, confirmations, errors) is available in Chinese and English, and the language is picked automatically from Claudian's own `locale` setting — no separate setting to keep in sync.
- Retried delivery: a transient failure to reach the Obsidian plugin is retried a few times with short backoff before it is reported as an error, instead of surfacing every brief hiccup.
- Autostart-friendly: the relay is designed to run headless (no console window) and tolerates being launched before Obsidian has finished loading.

## Requirements

- Desktop Obsidian (Claudian is `isDesktopOnly`, and this bridge is as well). Developed and tested on Windows; nothing in either the plugin or the relay script is Windows-specific except the optional autostart helper, so other desktop platforms should work once verified there.
- [Claudian](https://github.com/YishenTu/claudian) installed and enabled, with an active provider (this bridge currently targets provider id `claude`).
- WeChat (iOS or Android) with access to the official ClawBot feature.
- Node.js and npm, to build the Obsidian plugin from source.
- Python 3.11+ and [`wechat-clawbot`](https://github.com/nightsailer/wechat-clawbot) (`pip install wechat-clawbot`), which supplies the WeChat ClawBot iLink protocol client (QR login, long-poll, media/CDN handling) that `relay.py` builds on.

## Installation

### 1. Obsidian plugin

```
cd obsidian-plugin
npm install
npm run build
```

Copy (or symlink) the resulting folder — `manifest.json`, `main.js`, `data.json` if present — into `<vault>/.obsidian/plugins/wechat-bridge/`, then enable "WeChat Bridge" under Settings -> Community plugins. Keep the Claudian sidebar open at least once so the plugin can find a view to attach to.

The plugin listens on `127.0.0.1:39217` only. It is never exposed on any network interface.

### 2. WeChat relay

```
pip install wechat-clawbot
cd relay
python relay.py login   # one-time QR login; also writes qrcode.png
python relay.py serve   # long-running: forwards messages both ways
```

`login` only needs to run once (credentials are cached by `wechat-clawbot` under `~/.claude/channels/wechat/`). `serve` is the long-running process and should be kept running (see Autostart below).

### 3. Autostart (optional)

Two Windows Startup-folder shortcuts cover this on the target machine:

- Obsidian itself, launched normally (it reopens the last vault).
- `relay.py serve`, launched hidden through a small `.vbs` wrapper so `pythonw`'s lack of a console does not break `print()`-based logging, with output redirected to a log file.

`relay.py serve` waits ten seconds before its first request to give Obsidian and the plugin time to finish loading; it self-heals afterward regardless of ordering.

## Usage

Send any of these to the ClawBot conversation:

| Command | Effect |
| --- | --- |
| `/help` | Show command usage |
| `/list` or `/ls` | List known conversations, numbered, newest first |
| `/switch N` or `/goto N` | Attach to conversation `N` from the last `/list` |
| `/new` | Start a brand-new conversation |
| `/model <name>` | Switch model, e.g. `/model opus`, `/model sonnet` |
| `/effort <level>` | Switch effort level, e.g. `/effort low`, `/effort high` |
| `/permission <mode>` | Switch permission mode, e.g. `/permission yolo`, `/permission default` |
| `/status` | Show current model, effort level, permission mode, and listening state |
| `/hist` | List your messages in the bound conversation, numbered |
| `/hist N` | Show the reply to message number `N` |
| `/listen on` / `/listen off` | Toggle mirroring the desktop Claudian client's turns into WeChat |
| `/commands` | List Claude's own slash commands (separate from the bridge commands above) |
| anything else | Sent to Claudian as a normal chat message — this is also how you invoke Claude's own slash commands |

All of the above are bilingual; replies come back in Chinese or English depending on Claudian's `locale` setting.

## Design notes

**Settings changes go through Claudian's own API, not through editing its config file.** `/model`, `/effort`, and `/permission` call `claudian.mutateSettings(...)` — a method Claudian's plugin class already exposes and that Claudian's own toolbar dropdowns call internally (`Tab.ts`'s `updateTabProviderSettings` uses the same call). The bridge only replicates the small `model` <-> `savedProviderModel.claude` style mirroring that Claudian's `ProviderSettingsCoordinator` performs, then asks the open view to refresh (`view.refreshModelSelector()`), so the UI and the on-disk `.claudian/claudian-settings.json` stay consistent the same way they would from a manual click. The bridge never opens `claudian-settings.json` for writing.

**Message injection reuses Claudian's own send path.** `InputController.sendMessage({ content })` is the same method the composer's send button calls; it already supports a non-DOM `content` override, so no UI simulation or config mutation is involved there either.

**Conversation listing reads Claudian's on-disk session metadata (`.claudian/sessions/*.meta.json`) directly**, since that is plain, stable, read-only data — not something that benefits from going through a runtime API.

**`/commands` reads the same catalog Claudian's own "/" dropdown uses.** It calls `TabManager.getSdkCommands(tabId)`, the method Claudian's composer already calls to populate command autocomplete, so the list always matches what typing "/" in the Claudian UI would show.

**`/listen` is push, not pull, so it needs its own channel.** WeChat's protocol only lets the relay reply to something a user sent; it cannot originate a message on its own. The plugin polls the bound tab's message list on a timer and, when `/listen` is on, detects turns that grew without going through its own `sendChatMessage()` (i.e. typed straight into the Claudian desktop UI), formats them, and queues them. The relay separately polls a `GET /pending` endpoint on the plugin every few seconds and, if there is anything queued, sends it to the last WeChat sender using their most recently seen `context_token` — the same reuse-the-last-token approach `wechat-clawbot`'s own context-token cache is built for.

None of the above are declared, versioned public APIs of Claudian; they are internal objects reached through `app.plugins.plugins["realclaudian"]`. TypeScript's `private` only exists at compile time, so this works, but it is coupled to Claudian's current internal structure and may need small updates across Claudian releases.

## Limitations

- Targets a single WeChat ClawBot binding and a single Claudian provider (`claude`) by design; not built for multi-account or multi-provider routing.
- WeChat ClawBot only allows one bound endpoint at a time.
- The bot cannot open a conversation first; WeChat's protocol is reply-only until the user sends a message.
- If Claudian rolls back a turn very early (before any assistant text exists — for example, if the provider service failed to initialize) the failure surfaces only as an Obsidian `Notice` toast, which this bridge cannot see. WeChat gets a generic "no reply" message in that case, not the specific error text.
- Concurrent use from Claudian's own UI and from WeChat at the same time is not race-proof; requests to the plugin's HTTP endpoint are serialized, but two people typing into the exact same tab simultaneously is not a designed scenario.

## Acknowledgments

- [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu — the Obsidian plugin this bridge drives.
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot) by nightsailer (Pan Fan) — the Python WeChat ClawBot iLink API client this relay is built on; its `claude_channel` module (a Claude Code MCP channel bridge) was also the reference for the long-poll and reply-sending flow used here.
- The broader community of WeChat ClawBot <-> Claude Code channel bridges (for example `Johnixr/claude-code-wechat-channel` and its Windows fork `HaFred/cc-wechat-channel-windows`), which informed the reply-filtering approach (forward only final assistant text, drop tool/thinking noise).

## License

For personal use on one machine and one vault; no license file is included and this is not intended for redistribution.
