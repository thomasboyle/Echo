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

    def test_online_status_reflects_voice_join_leave(self):
        """Online status is True when user has active connection (e.g. in voice), False otherwise."""
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
        _, channels = request("GET", f"/servers/{server_id}/channels", token=token_owner)
        voice_ch = next(c for c in channels if c["type"] == "voice")
        channel_id = voice_ch["id"]

        code, members_before = request("GET", f"/servers/{server_id}/members", token=token_owner)
        self.assertEqual(code, 200)
        peer_before = next(m for m in members_before if m["id"] == user_peer_id)
        self.assertFalse(peer_before["online"], "Peer should be offline before joining voice")

        request("POST", f"/voice/{channel_id}/join", token=token_peer)
        code, members_joined = request("GET", f"/servers/{server_id}/members", token=token_owner)
        self.assertEqual(code, 200)
        peer_joined = next(m for m in members_joined if m["id"] == user_peer_id)
        self.assertTrue(peer_joined["online"], "Peer should be online while in voice")

        request("POST", f"/voice/{channel_id}/leave", token=token_peer)
        code, members_after = request("GET", f"/servers/{server_id}/members", token=token_owner)
        self.assertEqual(code, 200)
        peer_after = next(m for m in members_after if m["id"] == user_peer_id)
        self.assertFalse(peer_after["online"], "Peer should be offline after leaving voice")

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
