let BASE_URL = "";
let TOKEN = "";

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return url;
  const u = url.trim().replace(/\/$/, "");
  return u.startsWith("http://") || u.startsWith("https://") ? u : `http://${u}`;
}

export const setServerConfig = (url, token) => {
  BASE_URL = normalizeBaseUrl(url || "") || "";
  TOKEN = token || "";
};

function makeHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token || ""}`,
  };
}

function makeJson() {
  return (res) => {
    if (res.ok) return res.json();
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return res.json().then((d) => {
        let msg = res.statusText;
        if (d.detail) {
          if (Array.isArray(d.detail) && d.detail.length > 0 && d.detail[0].msg) {
            msg = d.detail[0].msg;
          } else if (typeof d.detail === "string") {
            msg = d.detail;
          }
        }
        return Promise.reject(new Error(msg));
      });
    }
    return Promise.reject(
      new Error(res.status === 404 ? "Server not found (404). Check if the API is behind a path prefix (e.g. /api)." : res.statusText || `Request failed (${res.status})`)
    );
  };
}

function fetchWithCatch(url, opts = {}) {
  return fetch(url, { ...opts }).catch((err) => {
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      return Promise.reject(new Error("Cannot reach server. Check address, network, and CORS."));
    }
    return Promise.reject(err);
  });
}

function createApi(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl || "") || "";
  const authHeaders = () => makeHeaders(token);
  const parseJson = makeJson();
  if (!base || !token || !base.startsWith("http")) {
    return null;
  }
  return {
    getServers: () => fetchWithCatch(`${base}/servers`, { headers: authHeaders() }).then(parseJson),
    createServer: (name, iconEmoji) =>
      fetch(`${base}/servers`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, icon_emoji: iconEmoji || "🌐" }),
      }).then(parseJson),
    joinServer: (serverId, inviteCode) =>
      fetch(`${base}/servers/${serverId}/join`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ invite_code: inviteCode }),
      }).then(parseJson),
    resolveInvite: (inviteCode) =>
      fetch(`${base}/invite/${encodeURIComponent(inviteCode.trim().toUpperCase())}`).then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.detail || "Invalid invite")))
      ),
    getInvite: (serverId) =>
      fetch(`${base}/servers/${serverId}/invite`, { headers: authHeaders() }).then(parseJson),
    deleteServer: (serverId) =>
      fetch(`${base}/servers/${serverId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }).then(parseJson),
    getChannels: (serverId) =>
      fetch(`${base}/servers/${serverId}/channels`, { headers: authHeaders() }).then(parseJson),
    getVoiceActive: (serverId) =>
      fetchWithCatch(`${base}/servers/${serverId}/voice-active`, { headers: authHeaders() }).then(parseJson),
    createChannel: (serverId, name, type) =>
      fetch(`${base}/servers/${serverId}/channels`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, type }),
      }).then(parseJson),
    updateChannel: (serverId, channelId, name) =>
      fetch(`${base}/servers/${serverId}/channels/${channelId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: name.trim() }),
      }).then(parseJson),
    updateChannelSettings: (serverId, channelId, payload) =>
      fetch(`${base}/servers/${serverId}/channels/${channelId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(payload || {}),
      }).then(parseJson),
    getMessages: (channelId, limit = 50, before = null) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set("before", before);
      return fetch(`${base}/channels/${channelId}/messages?${params}`, {
        headers: authHeaders(),
      }).then(parseJson);
    },
    uploadAttachment: (channelId, file) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch(`${base}/channels/${channelId}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      }).then(parseJson);
    },
    getMembers: (serverId) =>
      fetch(`${base}/servers/${serverId}/members`, { headers: authHeaders() }).then(parseJson),
    getDMs: () => fetch(`${base}/dm`, { headers: authHeaders() }).then(parseJson),
    openDM: (targetUserId) =>
      fetch(`${base}/dm/${targetUserId}`, {
        method: "POST",
        headers: authHeaders(),
      }).then(parseJson),
    searchUsers: (query) =>
      fetch(`${base}/users/search?q=${encodeURIComponent(query)}`, {
        headers: authHeaders(),
      }).then(parseJson),
    getVoicePeers: (channelId) =>
      fetchWithCatch(`${base}/voice/${channelId}/peers`, { headers: authHeaders() }).then(parseJson),
    joinVoice: (channelId) =>
      fetchWithCatch(`${base}/voice/${channelId}/join`, {
        method: "POST",
        headers: authHeaders(),
      }).then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.detail || "Failed")))
      ),
    leaveVoice: (channelId) =>
      fetchWithCatch(`${base}/voice/${channelId}/leave`, {
        method: "POST",
        headers: authHeaders(),
      }).then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.detail || "Failed")))
      ),
    disconnectVoiceUser: (channelId, userId) =>
      fetchWithCatch(`${base}/voice/${channelId}/disconnect`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: userId }),
      }).then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.detail || "Failed")))
      ),
    updateProfile: (displayName, avatarEmoji) =>
      fetch(`${base}/users/me`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({
          ...(displayName != null && { display_name: displayName }),
          ...(avatarEmoji != null && { avatar_emoji: avatarEmoji }),
        }),
      }).then(parseJson),
    uploadAvatar: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch(`${base}/users/me/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      }).then(parseJson);
    },
    getMe: () => fetch(`${base}/users/me`, { headers: authHeaders() }).then(parseJson),
  };
}

export { createApi };

let cachedApi = null;
let cachedBase = "";
let cachedToken = "";

function getApi() {
  if (BASE_URL === cachedBase && TOKEN === cachedToken && cachedApi) return cachedApi;
  cachedBase = BASE_URL;
  cachedToken = TOKEN;
  cachedApi = createApi(BASE_URL, TOKEN);
  return cachedApi;
}

export const api = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === "login") {
        return (username, password) =>
          fetchWithCatch(`${BASE_URL}/login`, {
            method: "POST",
            headers: makeHeaders(TOKEN),
            body: JSON.stringify({ username, password }),
          }).then(makeJson());
      }
      if (prop === "register") {
        return (username, password, displayName) =>
          fetchWithCatch(`${BASE_URL}/register`, {
            method: "POST",
            headers: makeHeaders(TOKEN),
            body: JSON.stringify({ username, password, display_name: displayName }),
          }).then(makeJson());
      }
      const a = getApi();
      if (!a) return undefined;
      const v = a[prop];
      return typeof v === "function" ? v.bind(a) : v;
    },
  }
);
