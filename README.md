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

It is made of two parts that ship together as one Obsidian plugin folder:

- `obsidian-plugin/` — a small Obsidian plugin (`wechat-bridge`) that runs inside Obsidian alongside Claudian. It exposes a local HTTP endpoint and drives Claudian's own chat tab/runtime objects directly, the same way Claudian's own UI does.
- `obsidian-plugin/relay.py` — a Python script, bundled in the same folder, that speaks the WeChat ClawBot protocol (QR login, long-poll `getUpdates`, `sendMessage`) and forwards plain text to and from the Obsidian plugin's HTTP endpoint.

The plugin manages `relay.py`'s entire lifecycle itself: on load, it locates a system Python, creates a private virtual environment inside its own plugin folder (`venv/`, first run only), installs the couple of Python packages it needs, drives QR login through an in-Obsidian modal if there's no saved session yet, and then spawns `relay.py serve` as its own child process. If the plugin is disabled or Obsidian closes, the relay process goes with it. There is nothing to install, configure, or keep running separately - enabling the plugin is the whole setup.

Neither part talks to WeChat's servers and Obsidian's internals at the same time. The HTTP call between them is the only seam, and it never leaves `127.0.0.1`.

## Architecture

```
WeChat user
    |
    v
WeChat ClawBot (official, Tencent-hosted)
    |  iLink API: QR login, long-poll getUpdates, sendMessage
    v
relay.py                                    (bundled with the plugin, spawned and owned by it)
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

- Zero-config connection: the plugin bootstraps its own Python environment, handles first-time WeChat QR login through an in-Obsidian modal, and manages the relay process itself. Enabling the plugin is the entire setup.
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
- Context window usage: every real reply (WeChat-triggered or `/listen`-mirrored) ends with a `context window: used/total` line, bilingual, read from Claudian's own session metadata.

## Requirements

- Desktop Obsidian (Claudian is `isDesktopOnly`, and this bridge is as well). Developed and tested on Windows; nothing in either the plugin or `relay.py` is Windows-specific, so macOS/Linux should work once verified there.
- [Claudian](https://github.com/YishenTu/claudian) installed and enabled, with an active provider (this bridge currently targets provider id `claude`).
- WeChat (iOS or Android) with access to the official ClawBot feature.
- A Python 3.11+ installation somewhere on `PATH` (`python`, `python3`, or the Windows `py` launcher). The plugin only needs to be able to find it once, to create its own private virtual environment - it does not use your system Python for anything else, and does not require `wechat-clawbot` or any other package to be pre-installed.
- Node.js and npm, only if you're building the plugin from source rather than installing a packaged release.

## Installation

```
cd obsidian-plugin
npm install
npm run build
```

Copy (or symlink) the whole `obsidian-plugin/` folder's contents — `manifest.json`, `main.js`, `relay.py`, `data.json` if present — into `<vault>/.obsidian/plugins/wechat-bridge/`, then enable "WeChat Bridge" under Settings -> Community plugins. Keep the Claudian sidebar open at least once so the plugin can find a view to attach to.

That's it. On first load the plugin will, in order:

1. Look for a system Python and create `venv/` inside its own plugin folder (a few seconds, shows a Notice).
2. Install its Python dependencies into that venv (needs an internet connection the first time only).
3. If there's no saved WeChat session yet, open a modal in Obsidian with a QR code - scan it with WeChat to connect ClawBot.
4. Spawn `relay.py serve` as its own child process and start relaying.

From then on, enabling the plugin is enough: no separate terminal, no manual `pip install`, no OS-level autostart entry to configure. Disabling/unloading the plugin stops the relay process with it.

The plugin's HTTP endpoint only ever listens on `127.0.0.1:39217`; it is never exposed on any network interface. `relay.py` can still be run by hand (`python relay.py login` / `python relay.py serve`) for manual/advanced use - but don't run a manual `serve` at the same time the plugin is enabled: the plugin always spawns its own `relay.py serve` on load, and it does not check whether another instance is already running, so both would end up polling the same WeChat account at once.

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

**The relay's whole lifecycle is owned by `RelayManager`, tied to the plugin's own.** It shells out to whichever of `python`/`python3`/`py` it finds to create a private `venv/` inside the plugin's own folder (never touching any system-wide Python packages), installs its few dependencies into that venv, and only then spawns `relay.py serve` as a direct child process (not detached) - so the relay's lifetime is exactly the plugin's lifetime, with no separate OS-level autostart entry to keep in sync. First-time login reuses `relay.py`'s existing QR flow, just with a `--json` flag that makes it emit single-line JSON events (`qrcode`/`success`/`failed`) on stdout instead of human-readable log text, which the plugin reads with Node's `readline` and renders into an Obsidian `Modal` using a small bundled QR-rendering library (`qrcode-generator`, pure JS, no native dependencies) - so the QR code itself is generated locally, not fetched as an image from anywhere.

## Limitations

- Targets a single WeChat ClawBot binding and a single Claudian provider (`claude`) by design; not built for multi-account or multi-provider routing.
- WeChat ClawBot only allows one bound endpoint at a time.
- The bot cannot open a conversation first; WeChat's protocol is reply-only until the user sends a message.
- If Claudian rolls back a turn very early (before any assistant text exists — for example, if the provider service failed to initialize) the failure surfaces only as an Obsidian `Notice` toast, which this bridge cannot see. WeChat gets a generic "no reply" message in that case, not the specific error text.
- Concurrent use from Claudian's own UI and from WeChat at the same time is not race-proof; requests to the plugin's HTTP endpoint are serialized, but two people typing into the exact same tab simultaneously is not a designed scenario.
- The plugin does not check whether a `relay.py serve` is already running before spawning its own; running one manually while the plugin is also enabled results in two processes polling the same WeChat account.

## Acknowledgments

- [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu — the Obsidian plugin this bridge drives.
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot) by nightsailer (Pan Fan) — the Python WeChat ClawBot iLink API client this relay is built on; its `claude_channel` module (a Claude Code MCP channel bridge) was also the reference for the long-poll and reply-sending flow used here.
- The broader community of WeChat ClawBot <-> Claude Code channel bridges (for example `Johnixr/claude-code-wechat-channel` and its Windows fork `HaFred/cc-wechat-channel-windows`), which informed the reply-filtering approach (forward only final assistant text, drop tool/thinking noise).

## License

For personal use on one machine and one vault; no license file is included and this is not intended for redistribution.
