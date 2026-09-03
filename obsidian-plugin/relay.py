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
from pathlib import Path

import anyio
import httpx

from wechat_clawbot.api.client import WeixinApiOptions, get_config, get_updates, send_message, send_typing
from wechat_clawbot.cdn.upload import (
    upload_file_attachment_to_weixin,
    upload_file_to_weixin,
    upload_video_to_weixin,
)
from wechat_clawbot.messaging.send import (
    send_file_message_weixin,
    send_image_message_weixin,
    send_video_message_weixin,
)
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
    credentials_dir,
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

# Fast poll while /listen or /progressive is on, slow poll while both are
# off, so this relay isn't hitting the plugin every few seconds forever for
# features that are usually not even enabled. /progressive polls faster still
# than plain /listen - it's meant to feel like the reply is arriving as it's
# generated, not just "eventually".
PENDING_POLL_INTERVAL_ACTIVE_S = 5.0
PENDING_POLL_INTERVAL_PROGRESSIVE_S = 2.0
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
    BRIDGE_TIMEOUT above for why): by the time a *post-connect* failure
    happens here (the connection dropped mid-response, the body came back
    truncated/unparseable, etc.), the POST body already reached the plugin -
    Claudian may well have already run the turn. Retrying would risk running
    it a *second* time; the safe move is to report the failure plainly and
    point at /hist, which reads Claudian's own message history directly and
    doesn't depend on this HTTP round-trip at all.
    """
    last_error: Exception | None = None
    body: dict[str, object] = {"text": text}
    if image is not None:
        body["image"] = image
    for attempt in range(BRIDGE_RETRY_ATTEMPTS):
        try:
            resp = await client.post(BRIDGE_URL, json=body, timeout=BRIDGE_TIMEOUT)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            # Nothing was sent yet - safe to retry as many times as configured.
            last_error = e
            if attempt < len(BRIDGE_RETRY_DELAYS):
                _log(
                    f"桥接连接失败（第 {attempt + 1}/{BRIDGE_RETRY_ATTEMPTS} 次），"
                    f"{BRIDGE_RETRY_DELAYS[attempt]}秒后重试: {e}"
                )
                await anyio.sleep(BRIDGE_RETRY_DELAYS[attempt])
            continue
        except Exception as e:  # noqa: BLE001
            # Post-connect failure (connection reset mid-transfer, etc.) - do
            # NOT retry (see docstring), and report it clearly instead of
            # letting a generic caller-side catch mislabel it as a connection
            # failure.
            _log(f"桥接请求发送后失败（未重试，避免重复触发这一轮）: {e}")
            return f"[桥接请求发送后失败，回复可能已生成但没能传回] 请发送 /hist 查看最新一轮的实际结果。({e})"

        try:
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            _log(f"桥接响应解析失败: {e}")
            return f"[桥接响应解析失败，回复可能已生成但没能传回] 请发送 /hist 查看最新一轮的实际结果。({e})"

        if not data.get("ok"):
            return f"[桥接出错] {data.get('error', 'unknown error')}"
        return data.get("reply", "(no reply)")

    return f"[桥接连接失败，已重试 {BRIDGE_RETRY_ATTEMPTS} 次] {last_error}"


# Guards `_last_send_monotonic` below - _handle_one_message runs each inbound
# WeChat message as its own background task (see its docstring) and
# _pending_push_loop is a separate long-lived loop, so sends can legitimately
# race each other; without a lock two concurrent callers could both read the
# same stale timestamp and both decide no throttling delay was needed.
_send_gate = anyio.Lock()
_last_send_monotonic = 0.0


async def _send_text_reply(opts: WeixinApiOptions, to: str, text: str, context_token: str) -> None:
    # Enforce WECHAT_SEND_MIN_GAP_S between this and the *previous* send to
    # WeChat, from any caller (chunk-to-chunk within one reply, push-to-push
    # across /listen or /progressive, or a reply racing a push) - see
    # WECHAT_SEND_MIN_GAP_S for why this exists. Held for the whole
    # sleep+send so a burst of callers queues up strictly spaced out, instead
    # of all waking up at once and racing each other again.
    global _last_send_monotonic
    async with _send_gate:
        now = anyio.current_time()
        wait = WECHAT_SEND_MIN_GAP_S - (now - _last_send_monotonic)
        if wait > 0:
            await anyio.sleep(wait)
        _last_send_monotonic = anyio.current_time()
        await _send_text_reply_now(opts, to, text, context_token)


async def _send_text_reply_now(opts: WeixinApiOptions, to: str, text: str, context_token: str) -> None:
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


# WeChat's sendmessage API returns a plain 200 OK even when it silently drops
# (or the client silently displays only part of) a very long single text
# message - `_api_post_fetch` in wechat_clawbot only raises on HTTP >=400 and
# never inspects the response body, so there is no signal to detect this from
# the API call itself. Confirmed as the actual cause of "Claudian replied in
# full but WeChat only showed the first part" reports: character counts
# logged by the caller matched what Claudian generated, so nothing was lost
# on our side before the send - only after. The fix is to never hand a single
# message longer than this to sendmessage at all: split into consecutive
# messages instead, so each individual one stays well under whatever limit
# WeChat enforces. Conservative (WeChat's actual cap is unconfirmed, and CJK
# text runs ~3 bytes/char in UTF-8, so this stays safely under a 4KB body).
WECHAT_TEXT_CHUNK_LIMIT = 1200

# Minimum gap between two consecutive sendmessage calls to the *same* user,
# across every chunk/push in this process - not just within one
# _send_text_chunks call. Root cause behind "只看到第一段就没了" reports:
# sendmessage returns a plain 200 OK even when WeChat silently drops a
# message sent too soon after the previous one to the same recipient (same
# blind spot as the single-long-message case above - _api_post_fetch never
# inspects the body for a rejection). Previously nothing throttled the loop
# in _send_text_chunks, so a long reply that split into many chunks (or
# several /progressive pushes arriving close together) fired them back to
# back with no gap at all, and only the first one or two survived. This is a
# floor enforced right before every send (see _throttled_send_text_reply),
# not a fixed sleep - a naturally slower gap (a chunk that took a while to
# build, or one send that itself took time) never adds extra delay on top.
WECHAT_SEND_MIN_GAP_S = 0.6


def _split_text_chunks(text: str, limit: int = WECHAT_TEXT_CHUNK_LIMIT) -> list[str]:
    """Splits `text` into consecutive chunks of at most `limit` characters
    each, preferring to break on a blank line, then a single newline, then a
    space - only a hard mid-word cut if none of those appear in the back half
    of the window, so chunk boundaries don't usually fall mid-sentence."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        window = remaining[:limit]
        cut = -1
        for sep in ("\n\n", "\n", " "):
            idx = window.rfind(sep, limit // 2)
            if idx != -1:
                cut = idx + len(sep)
                break
        if cut == -1:
            cut = limit
        piece = remaining[:cut].rstrip()
        if piece:
            chunks.append(piece)
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


async def _send_text_chunks(
    opts: WeixinApiOptions,
    to: str,
    text: str,
    context_token: str,
    fallback_context_token: str | None = None,
) -> int:
    """Sends `text` as one or more WeChat messages (see WECHAT_TEXT_CHUNK_LIMIT),
    sequentially so they arrive in order. Returns how many chunks were
    actually delivered. The single call site for outbound text in this file -
    every reply/push path routes through this instead of calling
    _send_text_reply directly, so both the chunking and retry logic apply
    everywhere without being duplicated per call site.

    Each chunk that fails is retried once against `fallback_context_token`
    (the freshest token this process has seen, if different) before being
    given up on - and *only* that one chunk is retried, not the whole
    message from the start. A long agentic turn can easily outlive however
    long a single context_token stays valid partway through sending a
    multi-chunk reply; the previous behavior (retry the entire message from
    scratch, see git history) meant a stale token mid-send either duplicated
    already-delivered chunks (retry succeeds) or, if the retry *also* failed,
    silently dropped every chunk after the failure point - which from WeChat
    looked exactly like "Claudian replied but got cut off partway", even
    though the real content had been generated in full. Retrying in place
    means a single token blip costs at most one chunk.
    """
    parts = _split_text_chunks(text)
    sent = 0
    for chunk in parts:
        try:
            await _send_text_reply(opts, to, chunk, context_token)
            sent += 1
            continue
        except Exception as e:  # noqa: BLE001
            if not fallback_context_token or fallback_context_token == context_token:
                _log(f"发送分段失败，已跳过该段（{len(chunk)} 字符）: {e}")
                continue
        try:
            await _send_text_reply(opts, to, chunk, fallback_context_token)
            sent += 1
        except Exception as e:  # noqa: BLE001
            _log(f"发送分段失败（重试后仍失败），已跳过该段（{len(chunk)} 字符）: {e}")

    if sent < len(parts):
        # At least one chunk never made it out. This used to be silent past
        # the log line above - from the user's side that's indistinguishable
        # from Claudian having generated less text than it actually did,
        # exactly the "最后几段漏发" report this whole pass is about. A
        # best-effort trailing notice at least turns it into something
        # visible with a concrete recovery step, instead of a gap nobody
        # can even tell is there. Wrapped in suppress(): if WeChat is broken
        # enough that this notice itself can't get out either, there is
        # nothing more this function can do about it.
        missing = len(parts) - sent
        notice = f"[有 {missing} 段内容发送失败，已跳过。发送 /hist 查看完整内容]"
        with contextlib.suppress(Exception):
            await _send_text_reply(opts, to, notice, context_token)
    return sent


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


# Mirrors the plugin side's own FILE_SEND_MAX_BYTES check (main.ts rejects
# oversized files before ever queuing them) - kept here too as a second line
# of defense in case a file grows between being queued and actually being
# read off disk for upload.
_FILE_SEND_MAX_BYTES = 20 * 1024 * 1024

_UPLOAD_SEND_BY_CATEGORY = {
    "image": (upload_file_to_weixin, send_image_message_weixin),
    "video": (upload_video_to_weixin, send_video_message_weixin),
    "file": (upload_file_attachment_to_weixin, send_file_message_weixin),
}


async def _send_file_push(opts: WeixinApiOptions, target: "_LastTarget", item: dict) -> None:
    """Uploads and sends one file queued by the plugin's /send or /getfile
    (see PendingFileItem in main.ts). Failures are reported back to the user
    as a plain WeChat text message instead of only ever ending up in
    relay.log - same reasoning as the truncation-diagnosis work: a send that
    silently fails looks indistinguishable from one that was never
    attempted, from the user's side.
    """
    path = item.get("absolutePath")
    name = item.get("fileName") or (os.path.basename(path) if path else "?")
    category = item.get("category") if item.get("category") in _UPLOAD_SEND_BY_CATEGORY else "file"

    if not path or not os.path.isfile(path):
        _log(f"待发送文件不存在，已跳过: {path}")
        return

    size = os.path.getsize(path)
    if size > _FILE_SEND_MAX_BYTES:
        _log(f"待发送文件超过 {_FILE_SEND_MAX_BYTES} 字节上限，已跳过: {path} size={size}")
        with contextlib.suppress(Exception):
            await _send_text_chunks(
                opts, target.sender_id, f"[未发送，文件过大] {name}", target.context_token
            )
        return

    upload_fn, send_fn = _UPLOAD_SEND_BY_CATEGORY[category]
    try:
        uploaded = await upload_fn(path, target.sender_id, opts, CDN_BASE_URL)
        if send_fn is send_file_message_weixin:
            await send_fn(target.sender_id, "", name, uploaded, opts)
        else:
            await send_fn(target.sender_id, "", uploaded, opts)
        _log(f"已发送文件: to={target.sender_id} name={name} category={category} size={size}")
    except Exception as e:  # noqa: BLE001
        _log(f"发送文件失败: name={name} category={category} err={e}")
        with contextlib.suppress(Exception):
            await _send_text_chunks(
                opts, target.sender_id, f"[发送失败] {name}: {e}", target.context_token
            )


def _last_target_path() -> Path:
    """Where the most-recently-seen WeChat sender/context_token is persisted.

    Lives next to the credentials file (same ~/.claude/channels/wechat dir).
    """
    return credentials_dir() / "last_target.json"


def _load_last_target() -> tuple[str, str] | None:
    """Load the last-persisted (sender_id, context_token), or None if never saved / unreadable."""
    try:
        data = json.loads(_last_target_path().read_text("utf-8"))
        sender_id = data.get("senderId")
        context_token = data.get("contextToken")
        if sender_id and context_token:
            return (sender_id, context_token)
    except (FileNotFoundError, json.JSONDecodeError, OSError, KeyError):
        pass
    return None


def _save_last_target(sender_id: str, context_token: str) -> None:
    """Best-effort persist of the last-seen target so a relay restart doesn't
    forget who to proactively push /listen output to (see _LastTarget's own
    docstring for why this loop needs *a* target at all). Deliberately
    swallows any error - this is a convenience cache, not the source of
    truth, and must never crash the message-handling path that calls it.
    """
    try:
        dir_ = credentials_dir()
        dir_.mkdir(parents=True, exist_ok=True)
        _last_target_path().write_text(
            json.dumps({"senderId": sender_id, "contextToken": context_token}), encoding="utf-8"
        )
    except OSError:
        pass


class _LastTarget:
    """Most recent WeChat sender/context_token, shared between the two loops below.

    WeChat's protocol is reply-only: sending a message to a user requires a
    context_token from something that user sent. /listen pushes are not
    replies to a specific inbound message, so they reuse the most recent
    context_token instead. This only supports a single active WeChat user,
    matching the rest of this bridge's single-binding design.

    Persisted to disk (see _load_last_target/_save_last_target) because this
    object itself is otherwise recreated empty on every relay.py restart -
    and the relay restarts often (plugin reloads, crashes, machine reboots).
    Without persistence, _pending_push_loop has nowhere to push proactive
    /listen output (AskUserQuestion prompts, autonomous-agent notifications,
    etc.) until the user happens to send *something* first - at which point
    everything queued since the last successful push dumps out all at once.
    Reusing the last known context_token across a restart carries the same
    "might be stale" risk /listen pushes already accept between two live
    messages; it isn't a new risk category, just a longer window.
    """

    def __init__(self) -> None:
        self.sender_id: str | None = None
        self.context_token: str | None = None


async def _handle_one_message(
    opts: WeixinApiOptions, target: _LastTarget, client: httpx.AsyncClient, msg: WeixinMessage
) -> None:
    """Downloads media (if any), forwards to the bridge, and replies - for exactly
    one WeChat message. Run as its own background task (see _wechat_poll_loop)
    so a message that makes Claudian block on an approval/question doesn't
    stop the poll loop from picking up the next message (e.g. the /answer or
    /approve that's needed to unblock it in the first place).

    The entire body is wrapped in try/except: this task is spawned into a
    long-lived anyio task group that also owns the get_updates() polling
    itself (see _wechat_poll_loop) - an exception escaping here would cancel
    that *whole* task group (anyio's default behavior on a child task
    failing), silently killing the poll loop for every future WeChat message,
    not just this one. RelayManager does not auto-restart a crashed relay
    process, so that failure mode would otherwise look exactly like "Claudian
    replied but WeChat got nothing, forever, until someone reloads the
    plugin" - never allow that.
    """
    try:
        text = body_from_item_list(msg.item_list)
        image_item = _find_image_item(msg.item_list)
        image = await _download_incoming_image(image_item) if image_item else None
        # A bare photo (no caption) has empty text - only skip the message if
        # there's neither text nor a usable image.
        if not text and not image:
            return
        sender_id = msg.from_user_id or "unknown"
        context_token = msg.context_token or ""
        target.sender_id = sender_id
        target.context_token = context_token
        _save_last_target(sender_id, context_token)
        _log(f"收到: from={sender_id} text={text[:50]!r} image={'是' if image else '否'}")

        reply = await _reply_with_typing_indicator(client, opts, sender_id, context_token, text, image)

        if not reply.strip():
            # /progressive mode: every chunk of this turn already went out
            # individually via _pending_push_loop as it happened: the bridge
            # deliberately returns an empty reply here instead of repeating
            # everything a second time in one lump message.
            _log(f"已回复: to={sender_id} (渐进式模式，内容已单独推送)")
            return

        await _send_reply_with_retry(opts, sender_id, reply, context_token, target)
    except Exception as e:  # noqa: BLE001
        _log(f"处理消息时发生未预期的异常（已忽略，不影响后续消息）: {e}")
        # Everything below `_log(f"收到: ...")` above already reports its own
        # failures to the user (see _forward_to_bridge/_reply_with_typing_
        # indicator/_send_text_chunks) - this branch is specifically for
        # failures *before* that point (e.g. image download), where the user
        # would otherwise just see their message go completely unanswered
        # with nothing in WeChat to explain why. Best-effort, using the raw
        # inbound message's own sender/context_token rather than `target`
        # (which this message may have failed before ever setting).
        raw_sender = msg.from_user_id
        raw_token = msg.context_token
        if raw_sender and raw_token:
            with contextlib.suppress(Exception):
                await _send_text_chunks(opts, raw_sender, f"[处理这条消息时出错，已跳过] {e}", raw_token)


async def _send_reply_with_retry(
    opts: WeixinApiOptions, sender_id: str, reply: str, context_token: str, target: _LastTarget
) -> None:
    """Sends the final reply. `target.context_token` (whatever the most recent
    inbound message actually used, kept fresh by every message this loop
    processes) is passed through to `_send_text_chunks` as the per-chunk
    fallback token - see that function for why retrying is done chunk-by-
    chunk rather than by resending the whole reply.

    `chars=`/`chunks=` logged on every send (not just previewed) specifically
    so a future "reply got cut off" report can be checked against fact
    instead of guesswork: compare `chunks` sent here to how many messages
    actually arrived in WeChat. If they match, whatever's missing was never
    sent by us in the first place (a bug on this side); if WeChat shows fewer
    messages than `chunks`, the platform itself dropped one after accepting
    it with a plain 200 OK (see _api_post_fetch in wechat_clawbot, which only
    raises on HTTP >=400 and never inspects the response body for a partial/
    truncated indicator) - a case we currently have no way to detect on our
    own.
    """
    fallback = target.context_token if target.context_token != context_token else None
    n = await _send_text_chunks(opts, sender_id, reply, context_token, fallback)
    _log(f"已回复: to={sender_id} chars={len(reply)} chunks={n} text={reply[:50]!r}")


async def _wechat_poll_loop(
    account: AccountData, opts: WeixinApiOptions, target: _LastTarget, client: httpx.AsyncClient
) -> None:
    get_updates_buf = ""
    consecutive_failures = 0

    _log("开始监听微信消息...")
    # One task group for the whole poll loop's lifetime: each inbound message
    # is spawned into it and runs independently (see _handle_one_message), so
    # a message that's still waiting on a slow/blocked Claudian turn never
    # delays get_updates() from being called again - which is what previously
    # made /answer and /approve impossible to ever deliver (this loop would
    # already be stuck awaiting the *previous* message's reply, indefinitely,
    # since that reply was itself waiting on the /answer that could only ever
    # arrive via this same loop).
    async with anyio.create_task_group() as tg:
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
                    tg.start_soon(_handle_one_message, opts, target, client, msg)

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

    Ack-based, not clear-on-read: the plugin's /pending keeps everything it's
    ever queued until this loop explicitly confirms (via ackPush/ackFiles
    query params on the *next* call) that it finished processing a given
    batch. This matters because the naive "GET clears the queue" version was
    at-most-once delivery - if the response never actually made it back here
    (an httpx timeout, Obsidian's event loop stalling for a few seconds under
    load, anything), the plugin had already emptied its queue and that text
    was gone for good, with nothing logged anywhere since the failure landed
    in a bare `except: continue`. Confirmed as the cause of a real "最后一段/
    几段漏发" report where relay.log showed no error at all for the affected
    turn. Now: only ack ids we actually finish sending this tick; anything
    that fails (see the per-push try/except below) or never arrives at all
    stays unacked and comes right back next poll instead of vanishing.
    """
    interval = PENDING_POLL_INTERVAL_IDLE_S
    ack_push: int | None = None
    ack_files: int | None = None
    while True:
        await anyio.sleep(interval)
        if not target.sender_id or not target.context_token:
            continue  # No WeChat user has said anything yet; nothing to push to.
        try:
            params = {}
            if ack_push is not None:
                params["ackPush"] = str(ack_push)
            if ack_files is not None:
                params["ackFiles"] = str(ack_files)
            resp = await client.get(PENDING_URL, params=params, timeout=10.0)
            data = resp.json()
        except Exception as e:  # noqa: BLE001
            # Deliberately do NOT clear ack_push/ack_files here - whatever we
            # last confirmed is still valid to re-send on the next successful
            # call. Logged (unlike the old silent `continue`) so a string of
            # these actually shows up as a diagnosable pattern instead of an
            # invisible gap in relay.log.
            _log(f"pending 轮询异常: {e}")
            continue

        if data.get("progressive"):
            interval = PENDING_POLL_INTERVAL_PROGRESSIVE_S
        elif data.get("listening"):
            interval = PENDING_POLL_INTERVAL_ACTIVE_S
        else:
            interval = PENDING_POLL_INTERVAL_IDLE_S

        for entry in data.get("pushes") or []:
            push_id = entry.get("id")
            push = entry.get("text") or ""
            try:
                # This is the path /progressive chunks actually go out
                # through (not _send_reply_with_retry, whose reply is empty
                # once anything's been pushed progressively) - `chars=` here
                # is what to check first against a truncation report. Each
                # push is itself now chunk-split too: a single /progressive
                # chunk (one settled block of Claudian's reply) can still be
                # long enough on its own to hit WeChat's silent-truncation
                # limit.
                n = await _send_text_chunks(opts, target.sender_id, push, target.context_token)
                if n == 0 and push.strip():
                    # Every chunk failed - nothing actually reached WeChat, so
                    # this must NOT be acked (unlike the raise-based failures
                    # below, _send_text_chunks swallows its own per-chunk
                    # errors and just returns 0, so there's no exception here
                    # to fall into the `except` branch and stay unacked on
                    # its own - do it explicitly instead). Stop this batch
                    # here so it retries next poll, same as a raised error.
                    _log(f"推送监听内容全部失败: to={target.sender_id} chars={len(push)}")
                    break
                _log(f"已推送监听内容: to={target.sender_id} chars={len(push)} chunks={n} text={push[:50]!r}")
                # Only ack what we actually got through send_text_chunks
                # without raising - a mid-batch exception below leaves this
                # (and everything after it) unacked, so it's retried next
                # poll instead of silently dropped.
                if push_id is not None:
                    ack_push = push_id
            except Exception as e:  # noqa: BLE001
                _log(f"推送监听内容失败: {e}")
                break  # Stop here; unacked items (this one included) retry next tick, in order.

        for entry in data.get("files") or []:
            file_id = entry.get("id")
            try:
                await _send_file_push(opts, target, entry)
                if file_id is not None:
                    ack_files = file_id
            except Exception as e:  # noqa: BLE001
                _log(f"推送文件失败: {e}")
                break


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
    # Restore who to proactively push /listen output to, if we've seen anyone
    # before - otherwise _pending_push_loop sits idle until the user sends
    # something, then dumps the whole backlog at once. See _LastTarget's
    # docstring.
    restored = _load_last_target()
    if restored:
        target.sender_id, target.context_token = restored
        _log(f"已恢复上次的推送目标: {target.sender_id}")

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
