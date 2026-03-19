"""
Integration tests: run against a real Echo server (HTTP + WebSocket).
Set NEXUS_LIVE_URL (default http://localhost:8000). Set NEXUS_SKIP_LIVE=1 to skip.
Run: python -m unittest nexus.tests.test_integration -v
"""
import asyncio
import json
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

try:
    import websockets
except ImportError:
    websockets = None

BASE = os.environ.get("NEXUS_LIVE_URL", "http://localhost:8000").rstrip("/")
SKIP = os.environ.get("NEXUS_SKIP_LIVE", "").lower() in ("1", "true", "yes")
TIMEOUT = 15


def _unique():
    return uuid.uuid4().hex[:8]


def request(method, path, body=None, token=None):
    url = f"{BASE}{path}" if path.startswith("/") else f"{BASE}/{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ct = r.headers.get_content_type() or ""
            raw = r.read().decode()
            data = json.loads(raw) if ("json" in ct and raw) else None
            return r.getcode(), data
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
            data = json.loads(body) if body else None
        except Exception:
            data = None
        return e.code, data
    except (urllib.error.URLError, OSError) as e:
        raise unittest.SkipTest(f"Server unreachable: {e}")


def ws_base():
    if BASE.startswith("https://"):
        return BASE.replace("https://", "wss://", 1)
    return BASE.replace("http://", "ws://", 1)


def ws_send_receive(path_query, send_obj):
    if not websockets:
        raise unittest.SkipTest("websockets package required for WebSocket tests")
    url = f"{ws_base()}{path_query}"
    async def run():
        async with websockets.connect(url, close_timeout=2) as ws:
            await ws.send(json.dumps(send_obj))
            msg = await asyncio.wait_for(ws.recv(), timeout=TIMEOUT)
            return json.loads(msg)
    return asyncio.run(run())


async def _collect_ws_messages(ws, into_list):
    try:
        while True:
            msg = await ws.recv()
            into_list.append(json.loads(msg))
    except (websockets.ConnectionClosed, asyncio.CancelledError):
        pass


async def _run_voice_multi_client_signaling(ws_base_url):
    loop = asyncio.get_event_loop()

    def do_request(method, path, body=None, token=None):
        return request(method, path, body=body, token=token)

    async def http(method, path, body=None, token=None):
        return await loop.run_in_executor(None, lambda: do_request(method, path, body=body, token=token))

    ua, ub, uc, ud = f"vmulti_a_{_unique()}", f"vmulti_b_{_unique()}", f"vmulti_c_{_unique()}", f"vmulti_d_{_unique()}"
    pw = "password"
    code_a, ra = await http("POST", "/register", body={"username": ua, "password": pw, "display_name": "VA"})
    code_b, rb = await http("POST", "/register", body={"username": ub, "password": pw, "display_name": "VB"})
    code_c, rc = await http("POST", "/register", body={"username": uc, "password": pw, "display_name": "VC"})
    code_d, rd = await http("POST", "/register", body={"username": ud, "password": pw, "display_name": "VD"})
    if code_a != 200 or not ra or "token" not in ra:
        return f"register A failed: {code_a} {ra}"
    if code_b != 200 or not rb or "token" not in rb:
        return f"register B failed: {code_b} {rb}"
    if code_c != 200 or not rc or "token" not in rc:
        return f"register C failed: {code_c} {rc}"
    if code_d != 200 or not rd or "token" not in rd:
        return f"register D failed: {code_d} {rd}"
    token_a, token_b, token_c, token_d = ra["token"], rb["token"], rc["token"], rd["token"]
    user_a_id, user_b_id = ra["user"]["id"], rb["user"]["id"]
    user_c_id, user_d_id = rc["user"]["id"], rd["user"]["id"]

    _, create = await http("POST", "/servers", body={"name": "VMulti"}, token=token_a)
    server_id = create["id"]
    _, channels = await http("GET", f"/servers/{server_id}/channels", token=token_a)
    voice_ch = next(c for c in channels if c["type"] == "voice")
    channel_id = voice_ch["id"]
    _, invite = await http("GET", f"/servers/{server_id}/invite", token=token_a)
    await http("POST", f"/servers/{server_id}/join", body={"invite_code": invite["invite_code"]}, token=token_b)
    await http("POST", f"/servers/{server_id}/join", body={"invite_code": invite["invite_code"]}, token=token_c)
    await http("POST", f"/servers/{server_id}/join", body={"invite_code": invite["invite_code"]}, token=token_d)

    join_path = f"/voice/{channel_id}/join"
    leave_path = f"/voice/{channel_id}/leave"
    ws_path = f"/voice-signal/{channel_id}"

    await http("POST", join_path, token=token_a)
    url_a = f"{ws_base_url}{ws_path}?token={urllib.parse.quote(token_a)}"
    ws_a = await asyncio.wait_for(websockets.connect(url_a, close_timeout=2), timeout=TIMEOUT)
    msgs_a = []
    task_a = asyncio.create_task(_collect_ws_messages(ws_a, msgs_a))

    await http("POST", join_path, token=token_b)
    url_b = f"{ws_base_url}{ws_path}?token={urllib.parse.quote(token_b)}"
    ws_b = await asyncio.wait_for(websockets.connect(url_b, close_timeout=2), timeout=TIMEOUT)
    msgs_b = []
    task_b = asyncio.create_task(_collect_ws_messages(ws_b, msgs_b))

    await asyncio.sleep(0.6)
    peer_joined_b = [m for m in msgs_a if m.get("type") == "peer_joined" and m.get("user_id") == user_b_id]
    existing_a = [m for m in msgs_b if m.get("type") == "existing_peers"]
    if not peer_joined_b:
        return f"A did not receive peer_joined(B): got {[m.get('type') for m in msgs_a]}"
    if not existing_a:
        return f"B did not receive existing_peers: got {[m.get('type') for m in msgs_b]}"
    peer_ids_b = {p.get("id") for p in existing_a[0].get("peers", [])}
    if user_a_id not in peer_ids_b:
        return f"B existing_peers missing A: {peer_ids_b}"

    await http("POST", join_path, token=token_c)
    url_c = f"{ws_base_url}{ws_path}?token={urllib.parse.quote(token_c)}"
    ws_c = await asyncio.wait_for(websockets.connect(url_c, close_timeout=2), timeout=TIMEOUT)
    msgs_c = []
    task_c = asyncio.create_task(_collect_ws_messages(ws_c, msgs_c))

    await asyncio.sleep(0.6)
    peer_joined_c_a = [m for m in msgs_a if m.get("type") == "peer_joined" and m.get("user_id") == user_c_id]
    peer_joined_c_b = [m for m in msgs_b if m.get("type") == "peer_joined" and m.get("user_id") == user_c_id]
    existing_c = [m for m in msgs_c if m.get("type") == "existing_peers"]
    if not peer_joined_c_a:
        return f"A did not receive peer_joined(C): got {[m.get('type') for m in msgs_a]}"
    if not peer_joined_c_b:
        return f"B did not receive peer_joined(C): got {[m.get('type') for m in msgs_b]}"
    if not existing_c:
        return f"C did not receive existing_peers: got {[m.get('type') for m in msgs_c]}"
    peer_ids_c = {p.get("id") for p in existing_c[0].get("peers", [])}
    if user_a_id not in peer_ids_c or user_b_id not in peer_ids_c:
        return f"C existing_peers missing A or B: {peer_ids_c}"

    await ws_b.close()
    task_b.cancel()
    try:
        await task_b
    except asyncio.CancelledError:
        pass
    await http("POST", leave_path, token=token_b)

    await asyncio.sleep(0.5)
    peer_left_a = [m for m in msgs_a if m.get("type") == "peer_left" and m.get("user_id") == user_b_id]
    peer_left_c = [m for m in msgs_c if m.get("type") == "peer_left" and m.get("user_id") == user_b_id]
    if not peer_left_a:
        return f"A did not receive peer_left(B): got {[m.get('type') for m in msgs_a]}"
    if not peer_left_c:
        return f"C did not receive peer_left(B): got {[m.get('type') for m in msgs_c]}"

    await http("POST", join_path, token=token_d)
    url_d = f"{ws_base_url}{ws_path}?token={urllib.parse.quote(token_d)}"
    ws_d = await asyncio.wait_for(websockets.connect(url_d, close_timeout=2), timeout=TIMEOUT)
    msgs_d = []
    task_d = asyncio.create_task(_collect_ws_messages(ws_d, msgs_d))

    await asyncio.sleep(0.6)
    peer_joined_d_a = [m for m in msgs_a if m.get("type") == "peer_joined" and m.get("user_id") == user_d_id]
    peer_joined_d_c = [m for m in msgs_c if m.get("type") == "peer_joined" and m.get("user_id") == user_d_id]
    existing_d = [m for m in msgs_d if m.get("type") == "existing_peers"]
    if not peer_joined_d_a:
        return f"A did not receive peer_joined(D): got {[m.get('type') for m in msgs_a]}"
    if not peer_joined_d_c:
        return f"C did not receive peer_joined(D): got {[m.get('type') for m in msgs_c]}"
    if not existing_d:
        return f"D did not receive existing_peers: got {[m.get('type') for m in msgs_d]}"
    peer_ids_d = {p.get("id") for p in existing_d[0].get("peers", [])}
    if user_a_id not in peer_ids_d or user_c_id not in peer_ids_d:
        return f"D existing_peers missing A or C: {peer_ids_d}"

    for ws in (ws_a, ws_c, ws_d):
        await ws.close()
    for t in (task_a, task_c, task_d):
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    await http("POST", leave_path, token=token_a)
    await http("POST", leave_path, token=token_c)
    await http("POST", leave_path, token=token_d)

    return None


class TestLogin(unittest.TestCase):
    def setUp(self):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")

    def test_register_returns_token_and_user(self):
        u = f"alice_{_unique()}"
        code, data = request("POST", "/register", body={"username": u, "password": "password1", "display_name": "Alice"})
        self.assertEqual(code, 200, data)
        self.assertIn("token", data)
        self.assertIn("user", data)
        self.assertEqual(data["user"]["username"], u)
        self.assertEqual(data["user"]["display_name"], "Alice")

    def test_login_returns_token_and_user(self):
        u = f"bob_{_unique()}"
        request("POST", "/register", body={"username": u, "password": "password2", "display_name": "Bob"})
        code, data = request("POST", "/login", body={"username": u, "password": "password2"})
        self.assertEqual(code, 200, data)
        self.assertIn("token", data)
        self.assertEqual(data["user"]["username"], u)

    def test_login_invalid_password_401(self):
        u = f"carl_{_unique()}"
        request("POST", "/register", body={"username": u, "password": "rightpass", "display_name": "Carl"})
        code, _ = request("POST", "/login", body={"username": u, "password": "wrongpass"})
        self.assertEqual(code, 401)

    def test_get_me_requires_auth(self):
        code, _ = request("GET", "/users/me")
        self.assertEqual(code, 401)

    def test_get_me_with_valid_token(self):
        u = f"dave_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Dave"})
        token = reg["token"]
        code, data = request("GET", "/users/me", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(data["username"], u)


class TestSyncServersAndUsers(unittest.TestCase):
    def setUp(self):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")

    def test_list_servers_after_auth(self):
        u = f"sync_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Sync"})
        code, data = request("GET", "/servers", token=reg["token"])
        self.assertEqual(code, 200)
        self.assertIsInstance(data, list)

    def test_create_server_then_list_servers_and_channels(self):
        u = f"owner_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Owner"})
        token = reg["token"]
        code, create = request("POST", "/servers", body={"name": "My Server", "icon_emoji": "🔧"}, token=token)
        self.assertEqual(code, 200)
        server_id = create["id"]
        code, servers = request("GET", "/servers", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(len(servers), 1)
        self.assertEqual(servers[0]["name"], "My Server")
        code, channels = request("GET", f"/servers/{server_id}/channels", token=token)
        self.assertEqual(code, 200)
        self.assertGreaterEqual(len(channels), 1)
        text_chans = [c for c in channels if c["type"] == "text"]
        voice_chans = [c for c in channels if c["type"] == "voice"]
        self.assertGreaterEqual(len(text_chans), 1)
        self.assertGreaterEqual(len(voice_chans), 1)

    def test_get_members_includes_online_flag(self):
        u = f"mem_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Mem"})
        token = reg["token"]
        _, create = request("POST", "/servers", body={"name": "S"}, token=token)
        server_id = create["id"]
        code, members = request("GET", f"/servers/{server_id}/members", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(len(members), 1)
        self.assertIn("online", members[0])

    def test_online_status_reflects_notifications_socket(self):
        """Online status is True while the client notifications socket is connected."""
        if not websockets:
            self.skipTest("websockets package required")
        u_owner = f"on_own_{_unique()}"
        u_peer = f"on_peer_{_unique()}"
        _, r_owner = request("POST", "/register", body={"username": u_owner, "password": "password", "display_name": "Owner"})
        _, r_peer = request("POST", "/register", body={"username": u_peer, "password": "password", "display_name": "Peer"})
        token_owner = r_owner["token"]
        token_peer = r_peer["token"]
        user_peer_id = r_peer["user"]["id"]
        _, create = request("POST", "/servers", body={"name": "OnlineTest"}, token=token_owner)
        server_id = create["id"]
        _, invite = request("GET", f"/servers/{server_id}/invite", token=token_owner)
        request("POST", f"/servers/{server_id}/join", body={"invite_code": invite["invite_code"]}, token=token_peer)

        code, members_before = request("GET", f"/servers/{server_id}/members", token=token_owner)
        self.assertEqual(code, 200)
        peer_before = next(m for m in members_before if m["id"] == user_peer_id)
        self.assertFalse(peer_before["online"], "Peer should be offline before connecting notifications socket")

        ws_url = f"{ws_base()}/ws/notifications?token={urllib.parse.quote(token_peer)}"
        async def _connect_once():
            async with websockets.connect(ws_url, close_timeout=2):
                await asyncio.sleep(0.25)
                code_joined, members_joined = request("GET", f"/servers/{server_id}/members", token=token_owner)
                self.assertEqual(code_joined, 200)
                peer_joined = next(m for m in members_joined if m["id"] == user_peer_id)
                self.assertTrue(peer_joined["online"], "Peer should be online while notifications socket is open")
            await asyncio.sleep(0.25)
        asyncio.run(_connect_once())

        code, members_after = request("GET", f"/servers/{server_id}/members", token=token_owner)
        self.assertEqual(code, 200)
        peer_after = next(m for m in members_after if m["id"] == user_peer_id)
        self.assertFalse(peer_after["online"], "Peer should be offline after notifications socket closes")

    def test_list_dms_and_open_dm(self):
        u1, u2 = f"dma_{_unique()}", f"dmb_{_unique()}"
        _, r1 = request("POST", "/register", body={"username": u1, "password": "password", "display_name": "DMA"})
        _, r2 = request("POST", "/register", body={"username": u2, "password": "password", "display_name": "DMB"})
        token_a = r1["token"]
        user_b_id = r2["user"]["id"]
        code, dms_before = request("GET", "/dm", token=token_a)
        self.assertEqual(code, 200)
        self.assertEqual(dms_before, [])
        code, open_dm = request("POST", f"/dm/{user_b_id}", token=token_a)
        self.assertEqual(code, 200)
        self.assertIn("id", open_dm)
        code, dms_after = request("GET", "/dm", token=token_a)
        self.assertEqual(code, 200)
        self.assertEqual(len(dms_after), 1)
        self.assertEqual(dms_after[0]["other_user"]["display_name"], "DMB")


class TestVoice(unittest.TestCase):
    def setUp(self):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")

    def test_voice_join_leave_and_peers(self):
        u = f"voice_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Voice"})
        token = reg["token"]
        _, create = request("POST", "/servers", body={"name": "V"}, token=token)
        _, channels = request("GET", f"/servers/{create['id']}/channels", token=token)
        voice_ch = next(c for c in channels if c["type"] == "voice")
        channel_id = voice_ch["id"]
        code, _ = request("POST", f"/voice/{channel_id}/join", token=token)
        self.assertEqual(code, 200)
        code, peers = request("GET", f"/voice/{channel_id}/peers", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(len(peers), 1)
        code, _ = request("POST", f"/voice/{channel_id}/leave", token=token)
        self.assertEqual(code, 200)
        code, peers_after = request("GET", f"/voice/{channel_id}/peers", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(len(peers_after), 0)

    def test_voice_signal_websocket_connect(self):
        if not websockets:
            self.skipTest("websockets package required")
        u = f"voicews_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "VWS"})
        token = reg["token"]
        _, create = request("POST", "/servers", body={"name": "VWS"}, token=token)
        _, channels = request("GET", f"/servers/{create['id']}/channels", token=token)
        voice_ch = next(c for c in channels if c["type"] == "voice")
        channel_id = voice_ch["id"]
        request("POST", f"/voice/{channel_id}/join", token=token)
        path = f"/voice-signal/{channel_id}?token={urllib.parse.quote(token)}"
        data = ws_send_receive(path, {"type": "offer", "offer": {"type": "offer", "sdp": "test"}})
        self.assertIsInstance(data, dict)
        self.assertEqual(data.get("type"), "no_peers")

    def test_voice_multi_client_signaling(self):
        if not websockets:
            self.skipTest("websockets package required")
        result = asyncio.run(_run_voice_multi_client_signaling(ws_base()))
        self.assertIsNone(result, result)


class TestMessagesAndRealtime(unittest.TestCase):
    def setUp(self):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")

    def test_get_messages_empty_then_after_ws_send(self):
        if not websockets:
            self.skipTest("websockets package required")
        u = f"msg_{_unique()}"
        _, reg = request("POST", "/register", body={"username": u, "password": "password", "display_name": "Msg"})
        token = reg["token"]
        _, create = request("POST", "/servers", body={"name": "M"}, token=token)
        _, channels = request("GET", f"/servers/{create['id']}/channels", token=token)
        text_ch = next(c for c in channels if c["type"] == "text")
        channel_id = text_ch["id"]
        code, msgs_before = request("GET", f"/channels/{channel_id}/messages", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(msgs_before, [])
        path = f"/ws/{channel_id}?token={urllib.parse.quote(token)}"
        data = ws_send_receive(path, {"type": "message", "content": "Hello world"})
        self.assertEqual(data["type"], "message")
        self.assertEqual(data["content"], "Hello world")
        self.assertIn("id", data)
        self.assertEqual(data["channel_id"], channel_id)
        code, list_after = request("GET", f"/channels/{channel_id}/messages", token=token)
        self.assertEqual(code, 200)
        self.assertEqual(len(list_after), 1)
        self.assertEqual(list_after[0]["content"], "Hello world")

    def test_broadcast_all_clients_see_message(self):
        if not websockets:
            self.skipTest("websockets package required")
        u1, u2 = f"broad1_{_unique()}", f"broad2_{_unique()}"
        _, r1 = request("POST", "/register", body={"username": u1, "password": "password", "display_name": "B1"})
        _, r2 = request("POST", "/register", body={"username": u2, "password": "password", "display_name": "B2"})
        token1, token2 = r1["token"], r2["token"]
        _, create = request("POST", "/servers", body={"name": "Broad"}, token=token1)
        server_id = create["id"]
        _, channels = request("GET", f"/servers/{server_id}/channels", token=token1)
        text_ch = next(c for c in channels if c["type"] == "text")
        channel_id = text_ch["id"]
        _, invite = request("GET", f"/servers/{server_id}/invite", token=token1)
        request("POST", f"/servers/{server_id}/join", body={"invite_code": invite["invite_code"]}, token=token2)
        path1 = f"/ws/{channel_id}?token={urllib.parse.quote(token1)}"
        data = ws_send_receive(path1, {"type": "message", "content": "Broadcast test"})
        self.assertEqual(data["type"], "message")
        self.assertEqual(data["content"], "Broadcast test")
        code, msgs = request("GET", f"/channels/{channel_id}/messages", token=token2)
        self.assertEqual(code, 200)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["content"], "Broadcast test")


class TestDMMessages(unittest.TestCase):
    def setUp(self):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")

    def test_dm_message_send_and_receive(self):
        if not websockets:
            self.skipTest("websockets package required")
        u1, u2 = f"dma1_{_unique()}", f"dmb1_{_unique()}"
        _, r1 = request("POST", "/register", body={"username": u1, "password": "password", "display_name": "DMA"})
        _, r2 = request("POST", "/register", body={"username": u2, "password": "password", "display_name": "DMB"})
        token_a = r1["token"]
        user_b_id = r2["user"]["id"]
        code, open_dm = request("POST", f"/dm/{user_b_id}", token=token_a)
        self.assertEqual(code, 200)
        dm_id = open_dm["id"]
        code, _ = request("GET", f"/channels/{dm_id}/messages", token=token_a)
        self.assertEqual(code, 200)
        path = f"/ws/{dm_id}?token={urllib.parse.quote(token_a)}"
        data = ws_send_receive(path, {"type": "message", "content": "DM hello"})
        self.assertEqual(data["type"], "message")
        self.assertEqual(data["content"], "DM hello")
        code, msgs = request("GET", f"/channels/{dm_id}/messages", token=token_a)
        self.assertEqual(code, 200)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["content"], "DM hello")


class TestLiveLoginAndServers(unittest.TestCase):
    """Uses fixed test user (NEXUS_TEST_USER / NEXUS_TEST_PASSWORD) to verify no 404."""
    @classmethod
    def setUpClass(cls):
        if SKIP:
            raise unittest.SkipTest("NEXUS_SKIP_LIVE is set")
        user = os.environ.get("NEXUS_TEST_USER", "callisto")
        pw = os.environ.get("NEXUS_TEST_PASSWORD", "password")
        code, data = request("POST", "/login", body={"username": user, "password": pw})
        if code != 200:
            raise unittest.SkipTest(f"Live login failed ({code}). Set NEXUS_TEST_USER/NEXUS_TEST_PASSWORD.")
        cls.token = data["token"]

    def test_login_returns_200_not_404(self):
        user = os.environ.get("NEXUS_TEST_USER", "callisto")
        pw = os.environ.get("NEXUS_TEST_PASSWORD", "password")
        code, data = request("POST", "/login", body={"username": user, "password": pw})
        self.assertNotEqual(code, 404)
        self.assertEqual(code, 200)
        self.assertIn("token", data)
        self.assertIn("user", data)

    def test_servers_endpoint_returns_200_not_404(self):
        code, data = request("GET", "/servers", token=self.token)
        self.assertNotEqual(code, 404)
        self.assertEqual(code, 200)
        self.assertIsInstance(data, list)

    def test_users_me_returns_200_not_404(self):
        code, data = request("GET", "/users/me", token=self.token)
        self.assertNotEqual(code, 404)
        self.assertEqual(code, 200)
        self.assertIn("username", data)


if __name__ == "__main__":
    unittest.main()
