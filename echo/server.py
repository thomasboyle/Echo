"""
Echo server - single-file FastAPI backend with SQLite, WebSocket, voice signaling.
Run: python server.py
"""
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import string
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends, Header, WebSocket, WebSocketDisconnect, Request, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel, field_validator

try:
    import aiosqlite
except ImportError:
    aiosqlite = None

if aiosqlite is None:
    raise ImportError("Install: pip install aiosqlite")

DB_PATH = Path(os.environ.get("NEXUS_DB_PATH", str(Path(__file__).parent / "nexus.db")))
UPLOADS_DIR = Path(os.environ.get("NEXUS_UPLOADS_DIR", str(Path(__file__).parent / "uploads")))
MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024  # 25MB
SECRET = os.environ.get("NEXUS_SECRET", "nexus-dev-secret")
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
TOKEN_MAX_AGE_SEC = 7 * 24 * 3600  # 7 days
MAX_MESSAGE_LENGTH = 3000
MIN_PASSWORD_LENGTH = 8
INVITE_CODE_LENGTH = 6
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_AUTH_PER_WINDOW = 10
RATE_LIMIT_INVITE_PER_WINDOW = 30
FAILED_LOGIN_THRESHOLD = 5
LOCKOUT_SEC = 15 * 60  # 15 minutes
IS_PRODUCTION = os.environ.get("NEXUS_ENV") == "production"
DEFAULT_ICE_SERVERS = [{"urls": "stun:stun.l.google.com:19302"}]

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def generate_token(user_id: str) -> str:
    ts = str(int(time.time()))
    payload = f"{user_id}:{ts}"
    sig = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def verify_token(token: str) -> str | None:
    try:
        user_id, ts, sig = token.rsplit(":", 2)
        if time.time() - int(ts) > TOKEN_MAX_AGE_SEC:
            return None
        payload = f"{user_id}:{ts}"
        expected = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(sig, expected):
            return user_id
    except Exception:
        pass
    return None


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000).hex()


def escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


_rate_auth: dict[str, list[float]] = defaultdict(list)
_rate_invite: dict[str, list[float]] = defaultdict(list)
_failed_logins: dict[str, list[float]] = defaultdict(list)


def get_configured_ice_servers() -> list[dict]:
    raw = os.environ.get("NEXUS_ICE_SERVERS_JSON") or os.environ.get("NEXUS_ICE_SERVERS")
    if not raw:
        return DEFAULT_ICE_SERVERS
    try:
        parsed = json.loads(raw)
    except Exception:
        return DEFAULT_ICE_SERVERS
    if not isinstance(parsed, list):
        return DEFAULT_ICE_SERVERS
    valid = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        urls = entry.get("urls")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list) or not urls:
            continue
        urls = [u for u in urls if isinstance(u, str) and u.strip()]
        if not urls:
            continue
        normalized = {"urls": urls if len(urls) > 1 else urls[0]}
        if isinstance(entry.get("username"), str):
            normalized["username"] = entry["username"]
        if isinstance(entry.get("credential"), str):
            normalized["credential"] = entry["credential"]
        if isinstance(entry.get("credentialType"), str):
            normalized["credentialType"] = entry["credentialType"]
        valid.append(normalized)
    return valid or DEFAULT_ICE_SERVERS


def _prune_old(entries: list[float], window_sec: float) -> None:
    cutoff = time.time() - window_sec
    while entries and entries[0] < cutoff:
        entries.pop(0)


def check_auth_rate_limit(ip: str) -> None:
    _prune_old(_rate_auth[ip], RATE_LIMIT_WINDOW_SEC)
    if len(_rate_auth[ip]) >= RATE_LIMIT_AUTH_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    _rate_auth[ip].append(time.time())


def check_invite_rate_limit(ip: str) -> None:
    _prune_old(_rate_invite[ip], RATE_LIMIT_WINDOW_SEC)
    if len(_rate_invite[ip]) >= RATE_LIMIT_INVITE_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
    _rate_invite[ip].append(time.time())


def check_login_lockout(ip: str) -> None:
    _prune_old(_failed_logins[ip], LOCKOUT_SEC)
    if len(_failed_logins[ip]) >= FAILED_LOGIN_THRESHOLD:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")


def record_failed_login(ip: str) -> None:
    _failed_logins[ip].append(time.time())
    _prune_old(_failed_logins[ip], LOCKOUT_SEC)


def record_successful_login(ip: str) -> None:
    _failed_logins[ip].clear()


def generate_invite_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(INVITE_CODE_LENGTH))


# ---------------------------------------------------------------------------
# DB init (sync for schema, aiosqlite for runtime)
# ---------------------------------------------------------------------------

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            display_name TEXT NOT NULL,
            avatar_emoji TEXT DEFAULT '🐱',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon_emoji TEXT DEFAULT '🌐',
            owner_id TEXT NOT NULL,
            invite_code TEXT UNIQUE,
            invite_expires TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS server_members (
            server_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            joined_at TEXT NOT NULL,
            PRIMARY KEY (server_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT CHECK(type IN ('text', 'voice')) NOT NULL,
            created_at TEXT NOT NULL,
            voice_bandwidth_kbps INTEGER
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dm_channels (
            id TEXT PRIMARY KEY,
            user1_id TEXT NOT NULL,
            user2_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS voice_sessions (
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            joined_at TEXT NOT NULL,
            is_muted INTEGER NOT NULL DEFAULT 0,
            is_deafened INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (channel_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    """)
    cur.execute("PRAGMA table_info(messages)")
    columns = [row[1] for row in cur.fetchall()]
    if "attachments" not in columns:
        cur.execute("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT '[]'")
    cur.execute("PRAGMA table_info(users)")
    user_columns = [row[1] for row in cur.fetchall()]
    if "avatar_url" not in user_columns:
        cur.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
    cur.execute("PRAGMA table_info(channels)")
    channel_columns = [row[1] for row in cur.fetchall()]
    if "voice_bandwidth_kbps" not in channel_columns:
        cur.execute("ALTER TABLE channels ADD COLUMN voice_bandwidth_kbps INTEGER")
    if "voice_user_limit" not in channel_columns:
        cur.execute("ALTER TABLE channels ADD COLUMN voice_user_limit INTEGER")
    cur.execute("PRAGMA table_info(voice_sessions)")
    voice_columns = [row[1] for row in cur.fetchall()]
    if "is_muted" not in voice_columns:
        cur.execute("ALTER TABLE voice_sessions ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0")
    if "is_deafened" not in voice_columns:
        cur.execute("ALTER TABLE voice_sessions ADD COLUMN is_deafened INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


init_db()

# ---------------------------------------------------------------------------
# In-memory state for WebSocket and voice
# ---------------------------------------------------------------------------

channel_connections: dict[str, list[tuple[str, WebSocket]]] = {}
notification_connections: dict[str, list[WebSocket]] = {}
voice_rooms: dict[str, list[tuple[str, WebSocket]]] = {}


def _online_user_ids() -> set[str]:
    out: set[str] = set()
    for uid, conns in notification_connections.items():
        if conns:
            out.add(uid)
    return out


def get_user_from_header(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return verify_token(authorization[7:].strip())


async def get_current_user(authorization: str | None = Header(default=None)):
    user_id = get_user_from_header(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or missing token")
    return user_id


# Dependency that reads from Header
def auth_header(authorization: str | None = Header(default=None)):
    return authorization


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
        return v


class LoginBody(BaseModel):
    username: str
    password: str


class CreateServerBody(BaseModel):
    name: str
    icon_emoji: str = "🌐"


class JoinServerBody(BaseModel):
    invite_code: str


class UpdateServerBody(BaseModel):
    name: str | None = None
    icon_emoji: str | None = None


class CreateChannelBody(BaseModel):
    name: str
    type: str


class UpdateChannelBody(BaseModel):
    name: str | None = None
    voice_bandwidth_kbps: int | None = None
    voice_user_limit: int | None = None


class VoiceDisconnectBody(BaseModel):
    user_id: str


class VoiceModerationBody(BaseModel):
    user_id: str
    enabled: bool = True


class VoiceStateBody(BaseModel):
    muted: bool | None = None
    deafened: bool | None = None


class UpdateProfileBody(BaseModel):
    display_name: str | None = None
    avatar_emoji: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def get_user_row(db: aiosqlite.Connection, user_id: str) -> dict | None:
    async with db.execute(
        "SELECT id, username, display_name, avatar_emoji, COALESCE(avatar_url, '') FROM users WHERE id = ?", (user_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    out = {"id": row[0], "username": row[1], "display_name": row[2], "avatar_emoji": row[3] or "🐱"}
    if row[4]:
        out["avatar_url"] = row[4]
    return out


async def get_channel_row(db: aiosqlite.Connection, channel_id: str) -> dict | None:
    async with db.execute(
        """SELECT c.id, c.server_id, c.name, c.type, s.name as server_name
           FROM channels c LEFT JOIN servers s ON c.server_id = s.id WHERE c.id = ?""",
        (channel_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        async with db.execute(
            "SELECT id, NULL as server_id, 'DM' as name, 'text' as type, id as server_name FROM dm_channels WHERE id = ?",
            (channel_id,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        return {"id": row[0], "server_id": None, "name": "DM", "type": "text", "server_name": "DM"}
    return {"id": row[0], "server_id": row[1], "name": row[2], "type": row[3], "server_name": row[4] or ""}


async def get_channel_member_ids(db: aiosqlite.Connection, ch: dict, channel_id: str) -> list[str]:
    if ch.get("server_id"):
        async with db.execute(
            "SELECT user_id FROM server_members WHERE server_id = ?", (ch["server_id"],)
        ) as cur:
            rows = await cur.fetchall()
        return [r[0] for r in rows]
    async with db.execute(
        "SELECT user1_id, user2_id FROM dm_channels WHERE id = ?", (channel_id,)
    ) as cur:
        row = await cur.fetchone()
    return list(row) if row else []


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    for conns in channel_connections.values():
        for _, ws in conns:
            try:
                await ws.close()
            except Exception:
                pass
    for conns in notification_connections.values():
        for ws in conns:
            try:
                await ws.close()
            except Exception:
                pass
    for conns in voice_rooms.values():
        for _, ws in conns:
            try:
                await ws.close()
            except Exception:
                pass


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    if IS_PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'"
    return response


@app.post("/register")
async def register(body: RegisterBody, request: Request):
    check_auth_rate_limit(get_client_ip(request))
    user_id = str(uuid.uuid4())
    salt = secrets.token_hex(16)
    password_hash = hash_password(body.password, salt)
    created = now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(
                "INSERT INTO users (id, username, password_hash, salt, display_name, avatar_emoji, created_at) VALUES (?,?,?,?,?,?,?)",
                (user_id, body.username, password_hash, salt, body.display_name, "🐱", created),
            )
            await db.commit()
            user = await get_user_row(db, user_id)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="Registration failed")
    return {"token": generate_token(user_id), "user": user}


@app.post("/login")
async def login(body: LoginBody, request: Request):
    ip = get_client_ip(request)
    check_auth_rate_limit(ip)
    check_login_lockout(ip)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, password_hash, salt FROM users WHERE username = ?", (body.username,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        record_failed_login(ip)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    user_id, stored_hash, salt = row
    if hash_password(body.password, salt) != stored_hash:
        record_failed_login(ip)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    record_successful_login(ip)
    async with aiosqlite.connect(DB_PATH) as db:
        user = await get_user_row(db, user_id)
    return {"token": generate_token(user_id), "user": user}


@app.get("/users/me")
async def get_me(authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        user = await get_user_row(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.patch("/users/me")
async def update_me(body: UpdateProfileBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    updates = []
    params = []
    if body.display_name is not None:
        updates.append("display_name = ?")
        params.append(body.display_name)
    if body.avatar_emoji is not None:
        updates.append("avatar_emoji = ?")
        params.append(body.avatar_emoji)
    if not updates:
        async with aiosqlite.connect(DB_PATH) as db:
            return await get_user_row(db, user_id)
    params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        await db.commit()
        return await get_user_row(db, user_id)


MAX_AVATAR_SIZE = 2 * 1024 * 1024  # 2MB


@app.post("/users/me/avatar")
async def upload_avatar(
    authorization: str | None = Header(default=None),
    file: UploadFile = File(...),
):
    user_id = await get_current_user(authorization)
    content_type = (file.content_type or "").strip().lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only image files (JPEG, PNG, GIF, WebP) are allowed")
    size = 0
    chunks = []
    while True:
        chunk = await file.read(65536)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_AVATAR_SIZE:
            raise HTTPException(status_code=413, detail="Avatar exceeds 2MB limit")
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}.get(content_type, ".jpg")
    name = f"avatar_{user_id}{ext}"
    path = UPLOADS_DIR / name
    with open(path, "wb") as f:
        for c in chunks:
            f.write(c)
    url = f"/attachments/{name}"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET avatar_url = ? WHERE id = ?", (url, user_id))
        await db.commit()
        return await get_user_row(db, user_id)


@app.get("/users/search")
async def search_users(q: str, authorization: str | None = Header(default=None)):
    await get_current_user(authorization)
    q = q.strip()
    if len(q) < 2:
        return []
    escaped = escape_like(q)
    pattern = f"%{escaped}%"
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, username, display_name, avatar_emoji FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' LIMIT 20",
            (pattern, pattern),
        ) as cur:
            rows = await cur.fetchall()
    return [{"id": r[0], "username": r[1], "display_name": r[2], "avatar_emoji": r[3] or "🐱"} for r in rows]


# ----- Servers -----

@app.get("/servers")
async def list_servers(authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """SELECT s.id, s.name, s.icon_emoji, s.owner_id FROM servers s
               INNER JOIN server_members m ON s.id = m.server_id WHERE m.user_id = ? ORDER BY s.name""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [{"id": r[0], "name": r[1], "icon_emoji": r[2] or "🌐", "owner_id": r[3]} for r in rows]


@app.post("/servers")
async def create_server(body: CreateServerBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    server_id = str(uuid.uuid4())
    created = now_iso()
    general_id = str(uuid.uuid4())
    voice_id = str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO servers (id, name, icon_emoji, owner_id, created_at) VALUES (?,?,?,?,?)",
            (server_id, body.name, body.icon_emoji or "🌐", user_id, created),
        )
        await db.execute(
            "INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)",
            (server_id, user_id, created),
        )
        await db.execute(
            "INSERT INTO channels (id, server_id, name, type, created_at) VALUES (?,?,?,?,?)",
            (general_id, server_id, "general", "text", created),
        )
        await db.execute(
            "INSERT INTO channels (id, server_id, name, type, created_at) VALUES (?,?,?,?,?)",
            (voice_id, server_id, "General", "voice", created),
        )
        await db.commit()
    return {"id": server_id, "name": body.name, "icon_emoji": body.icon_emoji or "🌐", "owner_id": user_id}


@app.get("/servers/{server_id}/invite")
async def get_invite(server_id: str, authorization: str | None = Header(default=None)):
    await get_current_user(authorization)
    code = generate_invite_code()
    expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE servers SET invite_code = ?, invite_expires = ? WHERE id = ?",
            (code, expires, server_id),
        )
        await db.commit()
    return {"invite_code": code, "expires": expires}


@app.get("/invite/{invite_code}")
async def resolve_invite(invite_code: str, request: Request):
    ip = get_client_ip(request)
    check_invite_rate_limit(ip)
    code = invite_code.strip().upper()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, name FROM servers WHERE invite_code = ? AND (invite_expires IS NULL OR invite_expires > ?)",
            (code, now_iso()),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invalid or expired invite code")
    return {"server_id": row[0], "server_name": row[1]}


@app.post("/servers/{server_id}/join")
async def join_server(server_id: str, body: JoinServerBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, invite_code, invite_expires FROM servers WHERE id = ?", (server_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Server not found")
        sid, code, expires = row
        if code != body.invite_code.strip().upper() or (expires and expires < now_iso()):
            raise HTTPException(status_code=400, detail="Invalid or expired invite code")
        try:
            await db.execute(
                "INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)",
                (server_id, user_id, now_iso()),
            )
            await db.commit()
        except sqlite3.IntegrityError:
            pass
    return {"ok": True}


@app.delete("/servers/{server_id}")
async def delete_server(server_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT owner_id FROM servers WHERE id = ?", (server_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Server not found")
        if row[0] != user_id:
            raise HTTPException(status_code=403, detail="Only the server owner can delete it")
        async with db.execute("SELECT id FROM channels WHERE server_id = ?", (server_id,)) as cur:
            channel_ids = [r[0] for r in await cur.fetchall()]
        for ch_id in channel_ids:
            await db.execute("DELETE FROM voice_sessions WHERE channel_id = ?", (ch_id,))
            await db.execute("DELETE FROM messages WHERE channel_id = ?", (ch_id,))
        await db.execute("DELETE FROM server_members WHERE server_id = ?", (server_id,))
        await db.execute("DELETE FROM channels WHERE server_id = ?", (server_id,))
        await db.execute("DELETE FROM servers WHERE id = ?", (server_id,))
        await db.commit()
    return {"ok": True}


@app.patch("/servers/{server_id}")
async def update_server(server_id: str, body: UpdateServerBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT owner_id FROM servers WHERE id = ?", (server_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Server not found")
        if row[0] != user_id:
            raise HTTPException(status_code=403, detail="Only the server owner can update it")
        sets: list[str] = []
        vals: list[str] = []
        if body.name is not None:
            sets.append("name = ?")
            vals.append((body.name or "").strip() or "Server")
        if body.icon_emoji is not None:
            sets.append("icon_emoji = ?")
            vals.append((body.icon_emoji or "").strip() or "🌐")
        if not sets:
            raise HTTPException(status_code=400, detail="No fields to update")
        vals.append(server_id)
        await db.execute(f"UPDATE servers SET {', '.join(sets)} WHERE id = ?", vals)
        await db.commit()
    return {"ok": True}


@app.get("/servers/{server_id}/members")
async def get_members(server_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            """SELECT u.id, u.username, u.display_name, u.avatar_emoji FROM users u
               INNER JOIN server_members m ON u.id = m.user_id WHERE m.server_id = ? ORDER BY u.display_name""",
            (server_id,),
        ) as cur:
            rows = await cur.fetchall()
        online_set = _online_user_ids()
    members = []
    for r in rows:
        members.append({
            "id": r[0], "username": r[1], "display_name": r[2], "avatar_emoji": r[3] or "🐱",
            "online": r[0] in online_set,
        })
    return members


@app.get("/servers/{server_id}/channels")
async def list_channels(server_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            "SELECT id, server_id, name, type, created_at, COALESCE(voice_bandwidth_kbps, 0), voice_user_limit FROM channels WHERE server_id = ? ORDER BY type, name",
            (server_id,),
        ) as cur:
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r[0],
            "server_id": r[1],
            "name": r[2],
            "type": r[3],
            "created_at": r[4],
            "voice_bandwidth_kbps": r[5] or None,
            "voice_user_limit": r[6] if len(r) > 6 and r[6] is not None else None,
        })
    return out


@app.get("/servers/{server_id}/voice-active")
async def list_voice_active(server_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            """SELECT v.channel_id, MIN(v.joined_at) FROM voice_sessions v
               INNER JOIN channels c ON c.id = v.channel_id AND c.server_id = ? AND c.type = 'voice'
               GROUP BY v.channel_id""",
            (server_id,),
        ) as cur:
            channel_rows = await cur.fetchall()
        async with db.execute(
            """SELECT v.channel_id, u.id, u.display_name, u.avatar_emoji, COALESCE(v.is_muted, 0), COALESCE(v.is_deafened, 0)
               FROM voice_sessions v
               INNER JOIN channels c ON c.id = v.channel_id AND c.server_id = ? AND c.type = 'voice'
               INNER JOIN users u ON u.id = v.user_id""",
            (server_id,),
        ) as cur:
            user_rows = await cur.fetchall()
    by_channel = {r[0]: {"channel_id": r[0], "started_at": r[1], "users": []} for r in channel_rows}
    for r in user_rows:
        ch_id, uid, display_name, avatar_emoji, is_muted, is_deafened = r[0], r[1], r[2], r[3] or "🐱", bool(r[4]), bool(r[5])
        if ch_id in by_channel:
            by_channel[ch_id]["users"].append({
                "id": uid, "display_name": display_name, "avatar_emoji": avatar_emoji,
                "is_muted": is_muted, "is_deafened": is_deafened,
            })
    return list(by_channel.values())


@app.post("/servers/{server_id}/channels")
async def create_channel(server_id: str, body: CreateChannelBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    if body.type not in ("text", "voice"):
        raise HTTPException(status_code=400, detail="type must be 'text' or 'voice'")
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        ch_id = str(uuid.uuid4())
        created = now_iso()
        voice_bw = 320 if body.type == "voice" else None
        voice_limit = None if body.type != "voice" else None
        await db.execute(
            "INSERT INTO channels (id, server_id, name, type, created_at, voice_bandwidth_kbps, voice_user_limit) VALUES (?,?,?,?,?,?,?)",
            (ch_id, server_id, body.name, body.type, created, voice_bw, voice_limit),
        )
        await db.commit()
    return {
        "id": ch_id,
        "server_id": server_id,
        "name": body.name,
        "type": body.type,
        "voice_bandwidth_kbps": voice_bw,
        "voice_user_limit": None,
    }


@app.patch("/servers/{server_id}/channels/{channel_id}")
async def update_channel(
    server_id: str, channel_id: str, body: UpdateChannelBody,
    authorization: str | None = Header(default=None),
):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            "SELECT id FROM channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Channel not found")
        updates = []
        params: list[object] = []
        if body.name is not None:
            updates.append("name = ?")
            params.append(body.name.strip())
        if body.voice_bandwidth_kbps is not None:
            bw = max(8, min(1000, int(body.voice_bandwidth_kbps)))
            updates.append("voice_bandwidth_kbps = ?")
            params.append(bw)
        if body.voice_user_limit is not None:
            limit_val = None if body.voice_user_limit == 0 else max(1, min(100, int(body.voice_user_limit)))
            updates.append("voice_user_limit = ?")
            params.append(limit_val)
        if updates:
            params.extend([channel_id, server_id])
            await db.execute(
                f"UPDATE channels SET {', '.join(updates)} WHERE id = ? AND server_id = ?",
                params,
            )
            await db.commit()
        async with db.execute(
            "SELECT id, server_id, name, type, COALESCE(voice_bandwidth_kbps, 0), voice_user_limit FROM channels WHERE id = ?",
            (channel_id,),
        ) as cur:
            row = await cur.fetchone()
    return {
        "id": row[0],
        "server_id": row[1],
        "name": row[2],
        "type": row[3],
        "voice_bandwidth_kbps": row[4] or None,
        "voice_user_limit": row[5] if len(row) > 5 and row[5] is not None else None,
    }


@app.delete("/servers/{server_id}/channels/{channel_id}")
async def delete_channel(
    server_id: str, channel_id: str,
    authorization: str | None = Header(default=None),
):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, user_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            "SELECT id FROM channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Channel not found")
        await db.execute("DELETE FROM voice_sessions WHERE channel_id = ?", (channel_id,))
        await db.execute("DELETE FROM messages WHERE channel_id = ?", (channel_id,))
        await db.execute("DELETE FROM channels WHERE id = ? AND server_id = ?", (channel_id, server_id))
        await db.commit()
    return {"ok": True}


# ----- Messages -----

@app.get("/channels/{channel_id}/messages")
async def get_messages(channel_id: str, limit: int = 50, before: str | None = None, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch:
            raise HTTPException(status_code=404, detail="Channel not found")
        if ch.get("server_id"):
            async with db.execute(
                "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?",
                (ch["server_id"], user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=403, detail="Not a member")
        else:
            async with db.execute(
                "SELECT 1 FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
                (channel_id, user_id, user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=403, detail="Not in this DM")
        if before:
            async with db.execute(
                """SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at,
                   u.display_name, u.avatar_emoji, COALESCE(m.attachments, '[]') as attachments
                   FROM messages m
                   JOIN users u ON m.author_id = u.id
                   WHERE m.channel_id = ? AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
                   ORDER BY m.created_at DESC LIMIT ?""",
                (channel_id, before, limit),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                """SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at,
                   u.display_name, u.avatar_emoji, COALESCE(m.attachments, '[]') as attachments
                   FROM messages m
                   JOIN users u ON m.author_id = u.id
                   WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?""",
                (channel_id, limit),
            ) as cur:
                rows = await cur.fetchall()
    out = []
    for r in reversed(rows):
        att = r[7] if len(r) > 7 else "[]"
        try:
            attachments = json.loads(att) if isinstance(att, str) else (att or [])
        except Exception:
            attachments = []
        out.append({
            "id": r[0], "channel_id": r[1], "author_id": r[2], "content": r[3], "created_at": r[4],
            "author": {"id": r[2], "display_name": r[5], "avatar_emoji": r[6] or "🐱"},
            "attachments": attachments,
        })
    return out


@app.post("/channels/{channel_id}/attachments")
async def upload_attachment(
    channel_id: str,
    authorization: str | None = Header(default=None),
    file: UploadFile = File(...),
):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch:
            raise HTTPException(status_code=404, detail="Channel not found")
        if ch.get("server_id"):
            async with db.execute(
                "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?",
                (ch["server_id"], user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=403, detail="Not a member")
        else:
            async with db.execute(
                "SELECT 1 FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
                (channel_id, user_id, user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=403, detail="Not in this DM")
    content_type = (file.content_type or "").strip().lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only image files (JPEG, PNG, GIF, WebP) are allowed")
    size = 0
    chunks = []
    while True:
        chunk = await file.read(65536)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_ATTACHMENT_SIZE:
            raise HTTPException(status_code=413, detail="File exceeds 25MB limit")
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}.get(content_type, ".bin")
    name = f"{uuid.uuid4().hex}{ext}"
    path = UPLOADS_DIR / name
    with open(path, "wb") as f:
        for c in chunks:
            f.write(c)
    url = f"/attachments/{name}"
    return {"url": url, "filename": file.filename or name, "content_type": content_type}


@app.get("/attachments/{filename}")
async def get_attachment(filename: str):
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = UPLOADS_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    ext = path.suffix.lower()
    media = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=media)


# ----- DM -----

@app.get("/dm")
async def list_dms(authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """SELECT d.id, d.user1_id, d.user2_id,
                   u.id as other_id, u.display_name, u.avatar_emoji
                   FROM dm_channels d
                   JOIN users u ON u.id = CASE WHEN d.user1_id = ? THEN d.user2_id ELSE d.user1_id END
                   WHERE d.user1_id = ? OR d.user2_id = ? ORDER BY d.id DESC""",
            (user_id, user_id, user_id),
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "id": r[0], "other_user": {"id": r[3], "display_name": r[4], "avatar_emoji": r[5] or "🐱"},
        }
        for r in rows
    ]


@app.post("/dm/{target_user_id}")
async def open_dm(target_user_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    if target_user_id == user_id:
        raise HTTPException(status_code=400, detail="Cannot DM yourself")
    u1, u2 = sorted([user_id, target_user_id])
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM dm_channels WHERE user1_id = ? AND user2_id = ?", (u1, u2)
        ) as cur:
            row = await cur.fetchone()
        if row:
            return {"id": row[0], "user1_id": u1, "user2_id": u2}
        dm_id = str(uuid.uuid4())
        created = now_iso()
        await db.execute(
            "INSERT INTO dm_channels (id, user1_id, user2_id, created_at) VALUES (?,?,?,?)",
            (dm_id, u1, u2, created),
        )
        await db.commit()
    return {"id": dm_id, "user1_id": u1, "user2_id": u2}


# ----- Voice -----

@app.post("/voice/{channel_id}/join")
async def voice_join(channel_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch or ch.get("type") != "voice":
            raise HTTPException(status_code=404, detail="Voice channel not found")
        if ch.get("server_id"):
            async with db.execute(
                "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?",
                (ch["server_id"], user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=403, detail="Not a member")
        async with db.execute(
            "SELECT voice_user_limit FROM channels WHERE id = ?", (channel_id,)
        ) as cur:
            limit_row = await cur.fetchone()
        limit = limit_row[0] if limit_row and limit_row[0] is not None else None
        if limit is not None:
            async with db.execute(
                "SELECT COUNT(*) FROM voice_sessions WHERE channel_id = ?", (channel_id,)
            ) as cur:
                count_row = await cur.fetchone()
            count = count_row[0] if count_row else 0
            if count >= limit:
                raise HTTPException(status_code=403, detail="Channel is full")
    created = now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO voice_sessions (channel_id, user_id, joined_at, is_muted, is_deafened) VALUES (?,?,?,?,?)",
            (channel_id, user_id, created, 0, 0),
        )
        await db.commit()
    return {"ok": True}


@app.post("/voice/{channel_id}/leave")
async def voice_leave(channel_id: str, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
            (channel_id, user_id),
        )
        await db.commit()
    return {"ok": True}


@app.post("/voice/{channel_id}/disconnect")
async def voice_disconnect(channel_id: str, body: VoiceDisconnectBody, authorization: str | None = Header(default=None)):
    requester_id = await get_current_user(authorization)
    target_id = body.user_id
    if requester_id == target_id:
        raise HTTPException(status_code=400, detail="Cannot disconnect yourself")
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch or ch.get("type") != "voice":
            raise HTTPException(status_code=404, detail="Voice channel not found")
        server_id = ch.get("server_id")
        if server_id:
            async with db.execute(
                "SELECT owner_id FROM servers WHERE id = ?", (server_id,)
            ) as cur:
                owner_row = await cur.fetchone()
            if not owner_row or owner_row[0] != requester_id:
                raise HTTPException(status_code=403, detail="Only the server owner can disconnect members from voice")
            for uid in (requester_id, target_id):
                async with db.execute(
                    "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, uid)
                ) as cur:
                    if await cur.fetchone() is None:
                        raise HTTPException(status_code=403, detail="Not a member")
        await db.execute(
            "DELETE FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
            (channel_id, target_id),
        )
        await db.commit()
    others_before = list(voice_rooms.get(channel_id, []))
    if channel_id in voice_rooms:
        voice_rooms[channel_id] = [(u, w) for u, w in voice_rooms[channel_id] if u != target_id]
        if not voice_rooms[channel_id]:
            del voice_rooms[channel_id]
    for uid, ws in others_before:
        if uid == target_id:
            try:
                await ws.send_json({"type": "force_disconnect"})
            except Exception:
                pass
        else:
            try:
                await ws.send_json({"type": "peer_left", "user_id": target_id})
            except Exception:
                pass
    return {"ok": True}


async def ensure_voice_owner_action_permissions(
    db: aiosqlite.Connection,
    channel_id: str,
    requester_id: str,
    target_id: str,
) -> None:
    if requester_id == target_id:
        raise HTTPException(status_code=400, detail="Cannot target yourself")
    ch = await get_channel_row(db, channel_id)
    if not ch or ch.get("type") != "voice":
        raise HTTPException(status_code=404, detail="Voice channel not found")
    server_id = ch.get("server_id")
    if not server_id:
        raise HTTPException(status_code=403, detail="Server-only voice moderation")
    async with db.execute(
        "SELECT owner_id FROM servers WHERE id = ?", (server_id,)
    ) as cur:
        owner_row = await cur.fetchone()
    if not owner_row or owner_row[0] != requester_id:
        raise HTTPException(status_code=403, detail="Only the server owner can moderate voice members")
    for uid in (requester_id, target_id):
        async with db.execute(
            "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?", (server_id, uid)
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="Not a member")


@app.post("/voice/{channel_id}/mute")
async def voice_mute(channel_id: str, body: VoiceModerationBody, authorization: str | None = Header(default=None)):
    requester_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_voice_owner_action_permissions(db, channel_id, requester_id, body.user_id)
        async with db.execute(
            "SELECT 1 FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
            (channel_id, body.user_id),
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="User is not in this voice channel")
        await db.execute(
            "UPDATE voice_sessions SET is_muted = ? WHERE channel_id = ? AND user_id = ?",
            (1 if body.enabled else 0, channel_id, body.user_id),
        )
        await db.commit()
    return {"ok": True}


@app.post("/voice/{channel_id}/deafen")
async def voice_deafen(channel_id: str, body: VoiceModerationBody, authorization: str | None = Header(default=None)):
    requester_id = await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        await ensure_voice_owner_action_permissions(db, channel_id, requester_id, body.user_id)
        async with db.execute(
            "SELECT 1 FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
            (channel_id, body.user_id),
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="User is not in this voice channel")
        await db.execute(
            "UPDATE voice_sessions SET is_deafened = ? WHERE channel_id = ? AND user_id = ?",
            (1 if body.enabled else 0, channel_id, body.user_id),
        )
        await db.commit()
    return {"ok": True}


@app.patch("/voice/{channel_id}/state")
async def voice_state(channel_id: str, body: VoiceStateBody, authorization: str | None = Header(default=None)):
    user_id = await get_current_user(authorization)
    if body.muted is None and body.deafened is None:
        return {"ok": True}
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch or ch.get("type") != "voice":
            raise HTTPException(status_code=404, detail="Voice channel not found")
        async with db.execute(
            "SELECT 1 FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
            (channel_id, user_id),
        ) as cur:
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Not in this voice channel")
        updates = []
        params: list[object] = []
        if body.muted is not None:
            updates.append("is_muted = ?")
            params.append(1 if body.muted else 0)
        if body.deafened is not None:
            updates.append("is_deafened = ?")
            params.append(1 if body.deafened else 0)
        if updates:
            params.extend([channel_id, user_id])
            await db.execute(
                f"UPDATE voice_sessions SET {', '.join(updates)} WHERE channel_id = ? AND user_id = ?",
                params,
            )
            await db.commit()
    return {"ok": True}


@app.get("/voice/{channel_id}/peers")
async def voice_peers(channel_id: str, authorization: str | None = Header(default=None)):
    await get_current_user(authorization)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """SELECT u.id, u.display_name, u.avatar_emoji, COALESCE(v.is_muted, 0), COALESCE(v.is_deafened, 0)
               FROM voice_sessions v
               JOIN users u ON u.id = v.user_id WHERE v.channel_id = ?""",
            (channel_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "id": r[0],
            "display_name": r[1],
            "avatar_emoji": r[2] or "🐱",
            "is_muted": bool(r[3]),
            "is_deafened": bool(r[4]),
        }
        for r in rows
    ]


@app.get("/voice/config/ice-servers")
async def voice_ice_servers(authorization: str | None = Header(default=None)):
    await get_current_user(authorization)
    return {"ice_servers": get_configured_ice_servers()}


@app.post("/voice/echo")
async def voice_test_echo(request: Request, authorization: str | None = Header(default=None)):
    await get_current_user(authorization)
    body = await request.body()
    content_type = request.headers.get("content-type") or "application/octet-stream"
    return Response(content=body, media_type=content_type)


# ----- WebSocket: notifications (unread badges) -----

@app.websocket("/ws/notifications")
async def notifications_websocket(websocket: WebSocket, token: str = ""):
    user_id = verify_token(token)
    if not user_id:
        await websocket.close(code=4001)
        return
    await websocket.accept()
    if user_id not in notification_connections:
        notification_connections[user_id] = []
    notification_connections[user_id].append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if user_id in notification_connections:
            notification_connections[user_id] = [w for w in notification_connections[user_id] if w != websocket]
            if not notification_connections[user_id]:
                del notification_connections[user_id]


# ----- WebSocket: channel messages -----

@app.websocket("/ws/{channel_id}")
async def channel_websocket(websocket: WebSocket, channel_id: str, token: str = ""):
    user_id = verify_token(token)
    if not user_id:
        await websocket.close(code=4001)
        return
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch:
            await websocket.close(code=4004)
            return
        if ch.get("server_id"):
            async with db.execute(
                "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?",
                (ch["server_id"], user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    await websocket.close(code=4003)
                    return
        else:
            async with db.execute(
                "SELECT 1 FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
                (channel_id, user_id, user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    await websocket.close(code=4003)
                    return
        user = await get_user_row(db, user_id)

    await websocket.accept()
    if channel_id not in channel_connections:
        channel_connections[channel_id] = []
    channel_connections[channel_id].append((user_id, websocket))

    for uid, ws in channel_connections[channel_id]:
        if uid != user_id:
            try:
                await ws.send_json({"type": "user_join", "user": user})
            except Exception:
                pass

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")
            if msg_type == "message":
                content = (data.get("content") or "").strip()
                raw_attachments = data.get("attachments") or []
                if not content and not raw_attachments:
                    continue
                if len(content) > MAX_MESSAGE_LENGTH:
                    continue
                attachments = []
                for a in raw_attachments[:10]:
                    if not isinstance(a, dict):
                        continue
                    url = a.get("url") or ""
                    if not isinstance(url, str):
                        continue
                    is_internal = url.startswith("/attachments/") and ".." not in url
                    is_external = url.startswith("http://") or url.startswith("https://")
                    if is_internal or is_external:
                        attachments.append({
                            "url": url,
                            "filename": a.get("filename") or "",
                            "content_type": a.get("content_type") or "image/png",
                        })
                attachments_json = json.dumps(attachments)
                msg_id = str(uuid.uuid4())
                created = now_iso()
                async with aiosqlite.connect(DB_PATH) as db:
                    await db.execute(
                        "INSERT INTO messages (id, channel_id, author_id, content, created_at, attachments) VALUES (?,?,?,?,?,?)",
                        (msg_id, channel_id, user_id, content or "", created, attachments_json),
                    )
                    await db.commit()
                payload = {
                    "type": "message",
                    "id": msg_id,
                    "channel_id": channel_id,
                    "server_id": ch.get("server_id"),
                    "content": content,
                    "attachments": attachments,
                    "author": user,
                    "author_id": user_id,
                    "created_at": created,
                }
                conns = list(channel_connections.get(channel_id, []))
                for uid, ws in conns:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        pass
                async with aiosqlite.connect(DB_PATH) as db:
                    member_ids = await get_channel_member_ids(db, ch, channel_id)
                for uid in member_ids:
                    if uid == user_id:
                        continue
                    for ws in notification_connections.get(uid, []):
                        try:
                            await ws.send_json(payload)
                        except Exception:
                            pass
            elif msg_type == "typing":
                for uid, ws in channel_connections.get(channel_id, []):
                    if uid != user_id:
                        try:
                            await ws.send_json({"type": "typing", "user": {"id": user_id, "display_name": user["display_name"]}})
                        except Exception:
                            pass
    except WebSocketDisconnect:
        pass
    finally:
        if channel_id in channel_connections:
            channel_connections[channel_id] = [(u, w) for u, w in channel_connections[channel_id] if u != user_id]
            if not channel_connections[channel_id]:
                del channel_connections[channel_id]
        for uid, ws in channel_connections.get(channel_id, []):
            if uid != user_id:
                try:
                    await ws.send_json({"type": "user_leave", "user_id": user_id})
                except Exception:
                    pass


# ----- WebSocket: voice signaling -----

@app.websocket("/voice-signal/{channel_id}")
async def voice_signal_websocket(websocket: WebSocket, channel_id: str, token: str = ""):
    user_id = verify_token(token)
    if not user_id:
        await websocket.close(code=4001)
        return
    async with aiosqlite.connect(DB_PATH) as db:
        ch = await get_channel_row(db, channel_id)
        if not ch or ch.get("type") != "voice":
            await websocket.close(code=4004)
            return
        if ch.get("server_id"):
            async with db.execute(
                "SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?",
                (ch["server_id"], user_id),
            ) as cur:
                if await cur.fetchone() is None:
                    await websocket.close(code=4003)
                    return
        user = await get_user_row(db, user_id)

    await websocket.accept()
    if channel_id not in voice_rooms:
        voice_rooms[channel_id] = []
    voice_rooms[channel_id].append((user_id, websocket))

    for uid, ws in voice_rooms.get(channel_id, []):
        if uid == user_id:
            continue
        try:
            await ws.send_json({
                "type": "peer_joined",
                "user_id": user_id,
                "display_name": user["display_name"],
                "avatar_emoji": user.get("avatar_emoji") or "🐱",
            })
        except Exception:
            pass

    existing_ids = [uid for uid, _ in voice_rooms.get(channel_id, []) if uid != user_id]
    if existing_ids:
        placeholders = ",".join("?" * len(existing_ids))
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                f"SELECT id, display_name, avatar_emoji FROM users WHERE id IN ({placeholders})",
                existing_ids,
            ) as cur:
                rows = await cur.fetchall()
        try:
            await websocket.send_json({
                "type": "existing_peers",
                "peers": [
                    {"id": r[0], "display_name": r[1], "avatar_emoji": r[2] or "🐱"}
                    for r in rows
                ],
            })
        except Exception:
            pass

    try:
        while True:
            data = await websocket.receive_json()
            data["from_user_id"] = user_id
            data["from_display_name"] = user["display_name"]
            data["from_avatar_emoji"] = user.get("avatar_emoji") or "🐱"
            others = [(uid, ws) for uid, ws in voice_rooms.get(channel_id, []) if uid != user_id]
            if not others:
                await websocket.send_json({"type": "no_peers"})
            else:
                to_user_id = data.get("to_user_id")
                if to_user_id:
                    targets = [(uid, ws) for uid, ws in others if uid == to_user_id]
                else:
                    targets = others
                for uid, ws in targets:
                    try:
                        await ws.send_json(data)
                    except Exception:
                        pass
    except WebSocketDisconnect:
        pass
    finally:
        if channel_id in voice_rooms:
            voice_rooms[channel_id] = [(u, w) for u, w in voice_rooms[channel_id] if u != user_id]
            if not voice_rooms[channel_id]:
                del voice_rooms[channel_id]
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    "DELETE FROM voice_sessions WHERE channel_id = ? AND user_id = ?",
                    (channel_id, user_id),
                )
                await db.commit()
        except Exception:
            pass
        for uid, ws in voice_rooms.get(channel_id, []):
            try:
                await ws.send_json({"type": "peer_left", "user_id": user_id})
            except Exception:
                pass


if __name__ == "__main__":
    import uvicorn
    print("╔══════════════════════════════════╗")
    print("║     ECHO SERVER v1.0             ║")
    print("╚══════════════════════════════════╝")
    print("📡 Server running on 0.0.0.0:8000")
    print("🔗 Share your local IP with friends")
    print("   Windows: run `ipconfig` in terminal")
    print("   macOS:   run `ifconfig` in terminal")
    uvicorn.run(app, host="0.0.0.0", port=8000)
