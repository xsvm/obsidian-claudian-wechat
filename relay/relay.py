"""
WeChat ClawBot <-> Claudian relay.

Does NOT talk to Claude Code or any MCP channel. It only:
  1. QR-authenticates with WeChat ClawBot (reusing wechat_clawbot's login code).
  2. Long-polls getUpdates for incoming WeChat text messages.
  3. POSTs the text to the local "wechat-bridge" Obsidian plugin
     (http://127.0.0.1:39217/message), which drives Claudian itself.
  4. Sends the plugin's reply back to WeChat.
  5. Polls the plugin's /pending endpoint for /listen-mode pushes (desktop-
     originated turns) and relays those too.

Usage:
    python relay.py login   # one-time QR login, also saves qrcode.png
    python relay.py serve   # run the long-poll relay loop (keep running)
"""

from __future__ import annotations

import sys

import anyio
import httpx

from wechat_clawbot.api.client import WeixinApiOptions, get_updates, send_message
from wechat_clawbot.api.types import (
    MessageItem,
    MessageItemType,
    MessageState,
    MessageType,
    SendMessageReq,
    TextItem,
    WeixinMessage,
)
from wechat_clawbot.auth.accounts import DEFAULT_BASE_URL
from wechat_clawbot.auth.login_qr import start_weixin_login_with_qr, wait_for_weixin_login
from wechat_clawbot.claude_channel.credentials import (
    AccountData,
    credentials_file_path,
    load_credentials,
    save_credentials,
)
from wechat_clawbot.messaging.inbound import body_from_item_list
from wechat_clawbot.util.random import generate_id

BRIDGE_URL = "http://127.0.0.1:39217/message"
PENDING_URL = "http://127.0.0.1:39217/pending"
LONG_POLL_TIMEOUT_MS = 35_000

# Fast poll while /listen is on, slow poll while it's off, so this relay isn't
# hitting the plugin every few seconds forever for a feature that's usually
# not even enabled.
PENDING_POLL_INTERVAL_ACTIVE_S = 5.0
PENDING_POLL_INTERVAL_IDLE_S = 30.0


def _log(msg: str) -> None:
    print(f"[relay] {msg}", flush=True)


async def login() -> None:
    _log("正在获取微信登录二维码...")
    start_result = await start_weixin_login_with_qr(api_base_url=DEFAULT_BASE_URL, force=True)
    if not start_result.qrcode_url:
        _log(f"获取二维码失败: {start_result.message}")
        sys.exit(1)

    # Save as a PNG so it can be viewed/shown outside the terminal.
    import qrcode

    img = qrcode.make(start_result.qrcode_url)
    png_path = "F:/obsidian/.wechat-relay/qrcode.png"
    img.save(png_path)
    _log(f"二维码已保存: {png_path}")
    _log(f"二维码内容(如需自行生成): {start_result.qrcode_url}")

    _log("请用微信扫描二维码并确认登录...")
    wait_result = await wait_for_weixin_login(
        session_key=start_result.session_key,
        api_base_url=DEFAULT_BASE_URL,
        verbose=True,
    )

    if not wait_result.connected or not wait_result.account_id or not wait_result.bot_token:
        _log(f"登录失败: {wait_result.message}")
        sys.exit(1)

    account = AccountData(
        token=wait_result.bot_token,
        base_url=wait_result.base_url or DEFAULT_BASE_URL,
        account_id=wait_result.account_id,
        user_id=wait_result.user_id,
    )
    save_credentials(account)
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


async def _forward_to_bridge(client: httpx.AsyncClient, text: str) -> str:
    """POST to the Obsidian plugin, retrying only connection-stage failures.

    Obsidian/the plugin can be briefly unreachable (still loading after a
    restart, a plugin reload in progress, etc.) - that's what gets retried.
    A slow-but-working reply is not a failure and must not be retried (see
    BRIDGE_TIMEOUT above for why).
    """
    last_error: Exception | None = None
    for attempt in range(BRIDGE_RETRY_ATTEMPTS):
        try:
            resp = await client.post(BRIDGE_URL, json={"text": text}, timeout=BRIDGE_TIMEOUT)
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
                if not text:
                    continue
                sender_id = msg.from_user_id or "unknown"
                context_token = msg.context_token or ""
                target.sender_id = sender_id
                target.context_token = context_token
                _log(f"收到: from={sender_id} text={text[:50]!r}")

                try:
                    reply = await _forward_to_bridge(client, text)
                except Exception as e:  # noqa: BLE001
                    reply = f"[桥接连接失败] {e}"

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
        anyio.run(login)
    elif cmd == "serve":
        anyio.run(serve)
    else:
        print("Usage: python relay.py [login|serve]")


if __name__ == "__main__":
    main()
