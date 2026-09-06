# Claudian WeChat Bridge

[中文](README.zh-CN.md) | English

![version](https://img.shields.io/badge/version-v1.0.2-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-desktop-lightgrey)
![Obsidian](https://img.shields.io/badge/Obsidian-plugin-7c3aed)
![stack](https://img.shields.io/badge/built_with-TypeScript_%7C_Python-3178c6)

Remote control your [Claudian](https://github.com/YishenTu/claudian) AI coding agent inside Obsidian directly from WeChat, via the official WeChat ClawBot (iLink) interface.

WeChat messages and images are relayed into a live Claudian session, and Claudian's responses are relayed straight back to the same WeChat conversation — turning your WeChat chat into a portable remote controller for your Obsidian agent.

## Overview

Claudian embeds Claude Code (and other coding agents) as a sidebar inside Obsidian. WeChat ClawBot is an official WeChat capability that lets a bot account exchange messages with WeChat users over a long-polling HTTP API. This project connects the two seamlessly.

Shipped as a single self-contained Obsidian plugin folder:

- `obsidian-plugin/` — Obsidian plugin (`claudian-wechat`) running inside Obsidian alongside Claudian. It exposes a local loopback HTTP interface and drives Claudian's own chat tabs and runtime objects.
- `obsidian-plugin/relay.py` — Bundled Python script managing the WeChat ClawBot protocol (QR login, long-poll `getUpdates`, `sendMessage`) and forwarding data between WeChat and the plugin's local HTTP endpoint.

The plugin manages `relay.py`'s entire lifecycle automatically: it locates your system Python, bootstraps an isolated virtual environment (`venv/`, created only on first run), installs dependencies, presents an in-Obsidian QR code modal for initial WeChat login, and spawns `relay.py serve` as a managed child process. When the plugin is disabled or Obsidian is closed, the relay exits cleanly.

All communications between the plugin and relay stay strictly on `127.0.0.1`.

## Architecture

```
WeChat User (Mobile)
    |
    v
WeChat ClawBot (Official Tencent Server)
    |  iLink API: QR login, long-poll getUpdates, sendMessage
    v
relay.py                                    (bundled with plugin, managed as child process)
    |  HTTP POST 127.0.0.1:39217/message     (loopback only)
    v
obsidian-plugin (claudian-wechat)            (TypeScript, running in Obsidian)
    |  interacts with loaded Claudian plugin runtime
    v
Claudian (github.com/YishenTu/claudian)      (driven via runtime objects)
    |
    v
Claude Code / Configured Provider
```

## Features

- **Zero-Config Bootstrap**: Automatically creates a dedicated Python virtual environment, prompts QR login inside Obsidian, and manages background relay processes.
- **Two-Way Streaming**: Send text and images from WeChat into Claudian; receive responses and status updates back in real time.
- **Multi-Image Batching**: Send multiple photos in sequence with cached buffering; append a follow-up caption to send together, or use `/skip` to send buffered images immediately.
- **Mid-Send Tab Switch Protection**: Automatically tracks and verifies target conversation IDs before and during message dispatch to prevent sending to the wrong tab or losing responses.
- **Remote Session Management**:
  - `/list` or `/ls` — List known Claudian sessions sorted by update time
  - `/switch N` or `/goto N` — Switch to session `#N`
  - `/new` — Detach and start a fresh session on the next message
- **Runtime Configuration Control**: Switch `/model` (omit arguments to list available models), `/effort` (thinking level), and `/permission` (permission mode) from WeChat.
- **Slash Commands Forwarding**: Send `/commands` to discover Claude's native commands, vault commands, and skills; all slash commands can be executed straight from WeChat.
- **Desktop Mirroring (`/listen`)**: Push desktop Claudian interactions to WeChat in real time.
- **Noise Filtering**: Cleans out internal tool calls, raw thinking traces, and subagent chatter, forwarding only final assistant text.
- **Bilingual Interface**: Full Chinese and English bilingual support, automatically matched to Claudian's configured `locale`.
- **Token Usage Metric**: Reports context window token consumption at the end of each completed turn.

## Requirements

- Desktop Obsidian (`isDesktopOnly`, Windows / macOS / Linux).
- [Claudian](https://github.com/YishenTu/claudian) plugin installed, enabled, and configured with a working provider.
- WeChat account with official ClawBot access.
- Python 3.11+ available on system `PATH`.
- Node.js & npm (only required if building from source).

## Installation

### Method A: From Release (Recommended)

1. Download the latest release package from [Releases](https://github.com/xsvm/obsidian-claudian-wechat/releases).
2. Extract to `<vault>/.obsidian/plugins/claudian-wechat/`.
3. Enable **Claudian WeChat Bridge** in Obsidian Settings -> Community Plugins.
4. Open the Claudian sidebar once so the bridge can attach.

### Method B: Build from Source

```bash
git clone https://github.com/xsvm/obsidian-claudian-wechat.git
cd obsidian-claudian-wechat/obsidian-plugin
npm install
npm run build
```

Copy the built files (`manifest.json`, `main.js`, `relay.py`, `strings.json`) into `<vault>/.obsidian/plugins/claudian-wechat/` and enable the plugin.

## Commands Reference

| Command | Description |
| :--- | :--- |
| `/help` | Display command reference and usage |
| `/list` or `/ls` | List known conversations, numbered |
| `/switch N` or `/goto N` | Switch to conversation `#N` |
| `/new` | Start a brand new conversation |
| `/model` | List available models for the current provider (static list for claude, discovered models for others) |
| `/model <name>` | Change model (e.g. `/model opus`, `/model sonnet`) |
| `/effort <level>` | Change reasoning effort (e.g. `/effort low`, `/effort high`) |
| `/permission <mode>` | Change permission mode (e.g. `/permission yolo`, `/permission default`) |
| `/status` | View current model, effort, permission mode, and listen state |
| `/hist` | List input history in current session |
| `/hist N` | View the response corresponding to message `#N` |
| `/skip` | Immediately dispatch cached images without waiting for caption |
| `/listen on` / `/listen off` | Toggle live mirroring of desktop turns to WeChat |
| `/commands` | List Claude Code's native slash commands |
| *any other text* | Forwarded directly to Claudian as prompt |

## Design Principles

- **Non-Invasive API Usage**: Drives Claudian through its native methods (`claudian.mutateSettings` and `InputController.sendMessage`) rather than tampering with DOM elements or raw settings files.
- **Local Isolation**: HTTP server strictly binds to `127.0.0.1:39217` without external network exposure.
- **Lifecycle Guarantees**: `relay.py` child process is tightly managed by `RelayManager` to avoid orphaned background processes.

## Acknowledgments

- [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu — The core Obsidian agent plugin driven by this bridge.
- [wechat-clawbot](https://github.com/nightsailer/wechat-clawbot) by nightsailer (Pan Fan) — Python WeChat ClawBot iLink API client foundation.
- The wider WeChat ClawBot ↔ Claude Code bridging community.

## Community

Join the WeChat group for questions, feedback, and updates:

![WeChat group QR code](assets/wechat-group-qrcode.png)

## License

This project is licensed under the [MIT License](LICENSE).
