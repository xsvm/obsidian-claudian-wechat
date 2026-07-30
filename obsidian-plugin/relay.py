"""
WeChat ClawBot <-> Claudian relay.

Does NOT talk to Claude Code or any MCP channel. It only:
  1. QR-authenticates with WeChat ClawBot (reusing wechat_clawbot's login code).
  2. Long-polls getUpdates for incoming WeChat text and image messages
     (images are downloaded/decrypted via wechat_clawbot's own CDN pipeline
     and base64-encoded in memory - never written to disk).
  3. POSTs the text (and image, if any) to the local "wechat-bridge" Obsidian
     plugin (http://127.0.0.1:39217/message), which drives Claudian itself.
  4. Sends the plugin's reply back to WeChat.
  5. Polls the plugin's /pending endpoint for /listen-mode pushes (desktop-
     originated turns) and relays those too.

Usage:
    python relay.py login   # one-time QR login, also saves qrcode.png
    python relay.py serve   # run the long-poll relay loop (keep running)
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import sys

import anyio
import httpx

from wechat_clawbot.api.client import WeixinApiOptions, get_config, get_updates, send_message, send_typing
from wechat_clawbot.api.types import (
    MessageItem,
    MessageItemType,
    MessageState,
    MessageType,
    SendMessageReq,
    SendTypingReq,
    TextItem,
    TypingStatus,
    WeixinMessage,
)
from wechat_clawbot.auth.accounts import CDN_BASE_URL, DEFAULT_BASE_URL
from wechat_clawbot.auth.login_qr import start_weixin_login_with_qr, wait_for_weixin_login
from wechat_clawbot.claude_channel.credentials import (
    AccountData,
    credentials_file_path,
    load_credentials,
    save_credentials,
)
from wechat_clawbot.media.download import download_media_from_item
from wechat_clawbot.messaging.inbound import body_from_item_list
from wechat_clawbot.util.random import generate_id


def _read_bridge_port() -> int:
    """Reads the port the Obsidian plugin actually bound (it falls back to a
    nearby port if 39217 was already taken by something else on this
    machine, and writes whichever one it used to port.txt next to this
    script). Defaults to 39217 if that file isn't there yet."""
    port_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "port.txt")
    try:
        with open(port_file, encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return 39217


BRIDGE_PORT = _read_bridge_port()
BRIDGE_URL = f"http://127.0.0.1:{BRIDGE_PORT}/message"
PENDING_URL = f"http://127.0.0.1:{BRIDGE_PORT}/pending"
LONG_POLL_TIMEOUT_MS = 35_000

# Fast poll while /listen is on, slow poll while it's off, so this relay isn't
# hitting the plugin every few seconds forever for a feature that's usually
# not even enabled.
PENDING_POLL_INTERVAL_ACTIVE_S = 5.0
PENDING_POLL_INTERVAL_IDLE_S = 30.0

# How often to re-send the typing indicator while waiting for Claudian's
# reply. WeChat ClawBot's typing indicator is not "set once, stays on" - it
# needs periodic keepalive, same as the official wechat-clawbot MCP channel
# server (claude_channel/server.py's _TypingManager) does.
TYPING_KEEPALIVE_INTERVAL_S = 5.0


def _log(msg: str) -> None:
    print(f"[relay] {msg}", flush=True)


def _emit_json(event: dict) -> None:
    """Single-line JSON to stdout, for a parent process (the Obsidian plugin)
    to read event-by-event instead of scraping human-readable log text."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


async def login(as_json: bool = False) -> None:
    """Interactive QR login.

    Default mode prints human-readable progress and also saves a qrcode.png
    next to this script, for manual CLI use. `as_json=True` is for the
    Obsidian plugin driving this as a child process: it emits one JSON object
    per line instead (qrcode/success/failed) and skips the PNG file - the
    plugin renders the QR code itself from the raw url.
    """
    if not as_json:
        _log("正在获取微信登录二维码...")
    start_result = await start_weixin_login_with_qr(api_base_url=DEFAULT_BASE_URL, force=True)
    if not start_result.qrcode_url:
        if as_json:
            _emit_json({"event": "failed", "message": start_result.message})
        else:
            _log(f"获取二维码失败: {start_result.message}")
        sys.exit(1)

    if as_json:
        _emit_json({"event": "qrcode", "url": start_result.qrcode_url})
    else:
        # Save as a PNG next to this script so it can be viewed outside the
        # terminal. Only for manual CLI use; the embedded/plugin-driven flow
        # renders the QR itself from the raw url instead.
        import qrcode

        png_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qrcode.png")
        qrcode.make(start_result.qrcode_url).save(png_path)
        _log(f"二维码已保存: {png_path}")
        _log(f"二维码内容(如需自行生成): {start_result.qrcode_url}")
        _log("请用微信扫描二维码并确认登录...")

    wait_result = await wait_for_weixin_login(
        session_key=start_result.session_key,
        api_base_url=DEFAULT_BASE_URL,
        verbose=not as_json,
    )

    if not wait_result.connected or not wait_result.account_id or not wait_result.bot_token:
        if as_json:
            _emit_json({"event": "failed", "message": wait_result.message})
        else:
            _log(f"登录失败: {wait_result.message}")
        sys.exit(1)

    account = AccountData(
        token=wait_result.bot_token,
        base_url=wait_result.base_url or DEFAULT_BASE_URL,
        account_id=wait_result.account_id,
        user_id=wait_result.user_id,
    )
    save_credentials(account)

    if as_json:
        _emit_json({"event": "success", "accountId": account.account_id, "userId": account.user_id})
    else:
        _log("登录成功，凭据已保存至 " + str(credentials_file_path()))


BRIDGE_RETRY_ATTEMPTS = 3
BRIDGE_RETRY_DELAYS = [1.0, 2.0]  # seconds between attempts 1->2 and 2->3

# Only the *connect* phase gets a timeout: failing to even open a TCP
# connection to 127.0.0.1 within 5s means Obsidian/the plugin isn't up yet,
# which is the transient, retry-worthy failure this was built for. There is
# deliberately no read timeout: a real agentic Claude Code turn can easily run
# past two minutes, and a fixed read timeout would misclassify "still working"
# as "failed", causing a retry that re-POSTs the same text - Claudian would
# then process the same user message a second time as an independent turn,
# producing a duplicate reply. Waiting indefinitely for the read is the
# correct behavior here: the plugin's HTTP handler only responds once
# Claudian's turn has actually finished.
BRIDGE_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0)

# Base64 inflates raw bytes by ~4/3 over the local loopback POST; cap the
# source image so a huge photo can't balloon into a multi-ten-MB JSON body.
_IMAGE_MAX_BYTES = 10 * 1024 * 1024

# Magic-byte sniffers for the handful of image formats WeChat actually sends.
# download_media_from_item() doesn't hand back a content-type for images (its
# save_media callback gets content_type=None for the IMAGE branch - see
# wechat_clawbot/media/download.py) since WeChat's own protocol doesn't carry
# one either, so this is the only way to know what we downloaded.
_IMAGE_MAGIC: list[tuple[bytes, str]] = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
]


def _sniff_image_mime(buf: bytes) -> str:
    for magic, mime in _IMAGE_MAGIC:
        if buf.startswith(magic):
            return mime
    if buf.startswith(b"RIFF") and buf[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"  # WeChat photos are virtually always jpeg; sane default.


def _find_image_item(item_list: list[MessageItem] | None) -> MessageItem | None:
    """First IMAGE item with an actually-downloadable CDN payload, if any.

    Deliberately image-only (not the IMAGE > VIDEO > FILE priority the full
    process_message.py reference pipeline uses) - this bridge only forwards
    images to Claudian for now.
    """
    if not item_list:
        return None
    for item in item_list:
        if (
            item.type == MessageItemType.IMAGE
            and item.image_item
            and item.image_item.media
            and item.image_item.media.has_download_source
        ):
            return item
    return None


async def _download_incoming_image(item: MessageItem) -> dict[str, str] | None:
    """Downloads + decrypts a WeChat image message via wechat_clawbot's own CDN
    pipeline - the same download_media_from_item() the official gateway's
    process_message.py uses - kept in memory instead of written to disk, since
    the bridge only needs a base64 blob to hand to Claudian, not a file.
    """
    captured: dict[str, bytes] = {}

    async def _save_media(buf: bytes, content_type, subdir, max_bytes, original_filename=None):
        captured["bytes"] = buf
        return {"path": "memory"}

    try:
        opts = await download_media_from_item(
            item,
            cdn_base_url=CDN_BASE_URL,
            save_media=_save_media,
            log=_log,
            err_log=_log,
            label="inbound",
        )
    except Exception as e:  # noqa: BLE001
        _log(f"图片下载失败: {e}")
        return None

    if not opts.decrypted_pic_path or "bytes" not in captured:
        return None
    buf = captured["bytes"]
    if len(buf) > _IMAGE_MAX_BYTES:
        _log(f"图片超过 {_IMAGE_MAX_BYTES} 字节上限，已丢弃 (size={len(buf)})")
        return None
    return {"mediaType": _sniff_image_mime(buf), "data": base64.b64encode(buf).decode("ascii")}


async def _forward_to_bridge(client: httpx.AsyncClient, text: str, image: dict[str, str] | None = None) -> str:
    """POST to the Obsidian plugin, retrying only connection-stage failures.

    Obsidian/the plugin can be briefly unreachable (still loading after a
    restart, a plugin reload in progress, etc.) - that's what gets retried.
    A slow-but-working reply is not a failure and must not be retried (see
    BRIDGE_TIMEOUT above for why).
    """
    last_error: Exception | None = None
    body: dict[str, object] = {"text": text}
    if image is not None:
        body["image"] = image
    for attempt in range(BRIDGE_RETRY_ATTEMPTS):
        try:
            resp = await client.post(BRIDGE_URL, json=body, timeout=BRIDGE_TIMEOUT)
            data = resp.json()
            if not data.get("ok"):
                return f"[桥接出错] {data.get('error', 'unknown error')}"
            return data.get("reply", "(no reply)")
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            last_error = e
            if attempt < len(BRIDGE_RETRY_DELAYS):
                _log(
                    f"桥接连接失败（第 {attempt + 1}/{BRIDGE_RETRY_ATTEMPTS} 次），"
                    f"{BRIDGE_RETRY_DELAYS[attempt]}秒后重试: {e}"
                )
                await anyio.sleep(BRIDGE_RETRY_DELAYS[attempt])

    return f"[桥接连接失败，已重试 {BRIDGE_RETRY_ATTEMPTS} 次] {last_error}"


async def _send_text_reply(opts: WeixinApiOptions, to: str, text: str, context_token: str) -> None:
    req = SendMessageReq(
        msg=WeixinMessage(
            from_user_id="",
            to_user_id=to,
            client_id=generate_id("wechat-claudian-relay"),
            message_type=MessageType.BOT,
            message_state=MessageState.FINISH,
            item_list=[MessageItem(type=MessageItemType.TEXT, text_item=TextItem(text=text))],
            context_token=context_token,
        )
    )
    await send_message(opts, req)


async def _get_typing_ticket(opts: WeixinApiOptions, sender_id: str, context_token: str) -> str | None:
    try:
        resp = await get_config(opts, ilink_user_id=sender_id, context_token=context_token)
        if resp.ret == 0 and resp.typing_ticket:
            return resp.typing_ticket
    except Exception as e:  # noqa: BLE001
        _log(f"getConfig 获取 typing_ticket 失败: {e}")
    return None


async def _typing_keepalive(opts: WeixinApiOptions, sender_id: str, ticket: str, stop_event: anyio.Event) -> None:
    """Re-sends the typing indicator every TYPING_KEEPALIVE_INTERVAL_S until stop_event is set."""
    while not stop_event.is_set():
        try:
            await send_typing(
                opts,
                SendTypingReq(ilink_user_id=sender_id, typing_ticket=ticket, status=TypingStatus.TYPING),
            )
        except Exception as e:  # noqa: BLE001
            _log(f"typing keepalive 失败: {e}")
            return
        with anyio.move_on_after(TYPING_KEEPALIVE_INTERVAL_S):
            await stop_event.wait()


async def _reply_with_typing_indicator(
    client: httpx.AsyncClient,
    opts: WeixinApiOptions,
    sender_id: str,
    context_token: str,
    text: str,
    image: dict[str, str] | None = None,
) -> str:
    """Shows "typing..." in WeChat for as long as _forward_to_bridge takes to come back."""
    ticket = await _get_typing_ticket(opts, sender_id, context_token)
    if not ticket:
        # No ticket available (getConfig failed, or ClawBot doesn't offer one
        # for this user) - proceed without an indicator rather than fail the
        # whole reply over a cosmetic feature.
        try:
            return await _forward_to_bridge(client, text, image)
        except Exception as e:  # noqa: BLE001
            return f"[桥接连接失败] {e}"

    stop_event = anyio.Event()
    reply: str
    async with anyio.create_task_group() as tg:
        tg.start_soon(_typing_keepalive, opts, sender_id, ticket, stop_event)
        try:
            reply = await _forward_to_bridge(client, text, image)
        except Exception as e:  # noqa: BLE001
            reply = f"[桥接连接失败] {e}"
        finally:
            stop_event.set()

    with contextlib.suppress(Exception):
        await send_typing(
            opts,
            SendTypingReq(ilink_user_id=sender_id, typing_ticket=ticket, status=TypingStatus.CANCEL),
        )
    return reply


class _LastTarget:
    """Most recent WeChat sender/context_token, shared between the two loops below.

    WeChat's protocol is reply-only: sending a message to a user requires a
    context_token from something that user sent. /listen pushes are not
    replies to a specific inbound message, so they reuse the most recent
    context_token instead. This only supports a single active WeChat user,
    matching the rest of this bridge's single-binding design.
    """

    def __init__(self) -> None:
        self.sender_id: str | None = None
        self.context_token: str | None = None


async def _wechat_poll_loop(
    account: AccountData, opts: WeixinApiOptions, target: _LastTarget, client: httpx.AsyncClient
) -> None:
    get_updates_buf = ""
    consecutive_failures = 0

    _log("开始监听微信消息...")
    while True:
        try:
            resp = await get_updates(
                base_url=account.base_url,
                token=account.token,
                get_updates_buf=get_updates_buf,
                timeout_ms=LONG_POLL_TIMEOUT_MS,
            )

            is_error = (resp.ret is not None and resp.ret != 0) or (
                resp.errcode is not None and resp.errcode != 0
            )
            if is_error:
                consecutive_failures += 1
                _log(f"getUpdates 失败: ret={resp.ret} errcode={resp.errcode} errmsg={resp.errmsg}")
                await anyio.sleep(30 if consecutive_failures >= 3 else 2)
                continue
            consecutive_failures = 0

            if resp.get_updates_buf:
                get_updates_buf = resp.get_updates_buf

            for msg in resp.msgs or []:
                if msg.message_type != MessageType.USER:
                    continue
                text = body_from_item_list(msg.item_list)
                image_item = _find_image_item(msg.item_list)
                image = await _download_incoming_image(image_item) if image_item else None
                # A bare photo (no caption) has empty text - only skip the
                # message if there's neither text nor a usable image.
                if not text and not image:
                    continue
                sender_id = msg.from_user_id or "unknown"
                context_token = msg.context_token or ""
                target.sender_id = sender_id
                target.context_token = context_token
                _log(f"收到: from={sender_id} text={text[:50]!r} image={'是' if image else '否'}")

                reply = await _reply_with_typing_indicator(client, opts, sender_id, context_token, text, image)

                try:
                    await _send_text_reply(opts, sender_id, reply, context_token)
                    _log(f"已回复: to={sender_id} text={reply[:50]!r}")
                except Exception as e:  # noqa: BLE001
                    _log(f"发送回复失败: {e}")

        except Exception as e:  # noqa: BLE001
            consecutive_failures += 1
            _log(f"轮询异常: {e}")
            await anyio.sleep(30 if consecutive_failures >= 3 else 2)


async def _pending_push_loop(opts: WeixinApiOptions, target: _LastTarget, client: httpx.AsyncClient) -> None:
    """Polls the plugin's /pending endpoint for /listen-mode pushes and relays them.

    Poll rate adapts to the plugin's reported `listening` state: fast while
    /listen is on (so desktop-originated turns show up in WeChat quickly),
    slow while it's off (so this loop isn't making a request every few
    seconds for a feature nobody has enabled).
    """
    interval = PENDING_POLL_INTERVAL_IDLE_S
    while True:
        await anyio.sleep(interval)
        if not target.sender_id or not target.context_token:
            continue  # No WeChat user has said anything yet; nothing to push to.
        try:
            resp = await client.get(PENDING_URL, timeout=10.0)
            data = resp.json()
        except Exception:
            continue  # Obsidian/plugin unreachable; quietly retry next tick.

        interval = PENDING_POLL_INTERVAL_ACTIVE_S if data.get("listening") else PENDING_POLL_INTERVAL_IDLE_S

        for push in data.get("pushes") or []:
            try:
                await _send_text_reply(opts, target.sender_id, push, target.context_token)
                _log(f"已推送监听内容: to={target.sender_id} text={push[:50]!r}")
            except Exception as e:  # noqa: BLE001
                _log(f"推送监听内容失败: {e}")


async def serve() -> None:
    account = load_credentials()
    if not account:
        _log("未找到凭据，请先运行: python relay.py login")
        sys.exit(1)

    # Give Obsidian + the wechat-bridge plugin time to finish loading when this
    # is launched automatically at login, alongside Obsidian itself. Harmless
    # for manual runs too. The WeChat long-poll below works regardless; this
    # only avoids spurious "bridge connection failed" replies in the first
    # few seconds after boot.
    _log("等待 10 秒，让 Obsidian 完成加载...")
    await anyio.sleep(10)

    _log(f"使用已保存账号: {account.account_id}")
    opts = WeixinApiOptions(base_url=account.base_url, token=account.token)
    target = _LastTarget()

    # One shared client for both loops: avoids rebuilding a connection pool
    # (and its TCP handshake) on every single request to the same local
    # loopback endpoint, whether that's a WeChat message forward, a retry, or
    # a /pending poll tick.
    async with httpx.AsyncClient() as client, anyio.create_task_group() as tg:
        tg.start_soon(_wechat_poll_loop, account, opts, target, client)
        tg.start_soon(_pending_push_loop, opts, target, client)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "login":
        as_json = "--json" in sys.argv[2:]
        anyio.run(login, as_json)
    elif cmd == "serve":
        anyio.run(serve)
    else:
        print("Usage: python relay.py [login [--json]|serve]")


if __name__ == "__main__":
    main()
