import React, { useState, useEffect } from "react";
import styles from "./Modals.module.css";
import SettingsModal from "./SettingsModal";

const EMOJIS = ["🌐", "🎮", "💬", "🎵", "📚", "🚀", "⭐", "🔥", "💻", "🎨", "🐱", "🐶"];

export default function Modals({
  api,
  baseUrl,
  user,
  modal,
  modalData,
  onClose,
  onServerCreated,
  onServerDeleted,
  onChannelCreated,
  onJoinServer,
  onProfileSaved,
  onDmCreated,
  onOpenDMChannel,
}) {
  const [createServerName, setCreateServerName] = useState("");
  const [createServerEmoji, setCreateServerEmoji] = useState("🌐");
  const [joinCode, setJoinCode] = useState("");
  const [resolvedServer, setResolvedServer] = useState(null);
  const [joinServerId, setJoinServerId] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [createChannelName, setCreateChannelName] = useState("");
  const [createChannelType, setCreateChannelType] = useState("text");
  const [renameChannelName, setRenameChannelName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const data = modalData || {};
  const serverId = data.serverId;

  useEffect(() => {
    if (modal === "createChannel" && data.type) setCreateChannelType(data.type);
    if (modal === "renameChannel" && data.channel) setRenameChannelName(data.channel.name || "");
    if (!modal) setError("");
  }, [modal, data]);

  const handleCreateServer = async () => {
    if (!api) return;
    setError("");
    setLoading(true);
    try {
      await api.createServer(createServerName.trim() || "New Server", createServerEmoji);
      setCreateServerName("");
      setCreateServerEmoji("🌐");
      onServerCreated?.();
      onClose();
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleJoinServer = async () => {
    if (!api) return;
    setError("");
    const code = joinCode.trim().toUpperCase();
    if (!code || code.length !== 6) {
      setError("Enter 6-character invite code");
      return;
    }
    setLoading(true);
    try {
      let serverId = joinServerId.trim();
      if (!serverId) {
        const resolved = await api.resolveInvite(code);
        serverId = resolved.server_id;
        setResolvedServer(resolved.server_name);
      }
      await api.joinServer(serverId, code);
      setJoinCode("");
      setJoinServerId("");
      setResolvedServer(null);
      onJoinServer?.();
      onClose();
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const loadInvite = async () => {
    if (!serverId || !api) return;
    setLoading(true);
    try {
      const res = await api.getInvite(serverId);
      setInviteCode(res.invite_code || "");
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (modal === "inviteCode" && serverId) loadInvite();
  }, [modal, serverId]);

  const handleCreateChannel = async () => {
    if (!api) return;
    setError("");
    if (!serverId || !createChannelName.trim()) {
      setError("Enter channel name");
      return;
    }
    setLoading(true);
    try {
      await api.createChannel(serverId, createChannelName.trim(), createChannelType);
      setCreateChannelName("");
      setCreateChannelType("text");
      onChannelCreated?.(serverId);
      onClose();
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRenameChannel = async () => {
    if (!api) return;
    setError("");
    const channel = data.channel;
    if (!serverId || !channel?.id || !renameChannelName.trim()) {
      setError("Enter channel name");
      return;
    }
    setLoading(true);
    try {
      await api.updateChannel(serverId, channel.id, renameChannelName.trim());
      setRenameChannelName("");
      onChannelCreated?.(serverId);
      onClose();
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const copyInvite = () => {
    if (inviteCode) navigator.clipboard.writeText(inviteCode);
  };

  const handleSearch = async () => {
    if (!api || searchQuery.trim().length < 2) return;
    setLoading(true);
    try {
      const list = await api.searchUsers(searchQuery.trim());
      setSearchResults(list);
    } catch (e) {
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDM = async (userId) => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      const ch = await api.openDM(userId);
      onDmCreated?.();
      onOpenDMChannel?.(ch.id);
      onClose();
    } catch (e) {
      setError(e.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDeleteServer = async () => {
    if (!serverId || !api) return;
    setLoading(true);
    setError("");
    try {
      await api.deleteServer(serverId);
      onServerDeleted?.();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to delete");
    } finally {
      setLoading(false);
    }
  };

  if (!modal) return null;

  if (modal === "userSettings") {
    return (
      <SettingsModal
        user={user ?? modalData?.user}
        api={api}
        baseUrl={baseUrl}
        onClose={onClose}
        onProfileSaved={onProfileSaved}
      />
    );
  }

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div className={styles.backdrop} onMouseDown={handleBackdrop} onKeyDown={handleKeyDown} role="dialog">
      <div className={styles.card} onMouseDown={(e) => e.stopPropagation()}>
        {modal === "createServer" && (
          <>
            <h2 className={styles.title}>Create Server</h2>
            <input
              className={styles.input}
              placeholder="Server name"
              value={createServerName}
              onChange={(e) => setCreateServerName(e.target.value)}
            />
            <div className={styles.emojiGrid}>
              {EMOJIS.map((e) => (
                <button
                  type="button"
                  key={e}
                  className={`${styles.emojiBtn} ${createServerEmoji === e ? styles.emojiActive : ""}`}
                  onClick={() => setCreateServerEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.primary} onClick={handleCreateServer} disabled={loading}>
              {loading ? "..." : "Create"}
            </button>
          </>
        )}

        {modal === "joinServer" && (
          <>
            <h2 className={styles.title}>Join Server</h2>
            <input
              className={styles.input}
              placeholder="Invite code (6 characters)"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value);
                if (e.target.value.length === 6 && api) api.resolveInvite(e.target.value).then((r) => setResolvedServer(r.server_name)).catch(() => setResolvedServer(null));
                else setResolvedServer(null);
              }}
              maxLength={6}
            />
            {resolvedServer && <p className={styles.hint}>Server: {resolvedServer}</p>}
            <input
              className={styles.input}
              placeholder="Or paste server ID (optional)"
              value={joinServerId}
              onChange={(e) => setJoinServerId(e.target.value)}
            />
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.primary} onClick={handleJoinServer} disabled={loading}>
              {loading ? "..." : "Join"}
            </button>
          </>
        )}

        {modal === "inviteCode" && (
          <>
            <h2 className={styles.title}>Invite</h2>
            <div className={styles.inviteRow}>
              <code className={styles.inviteCode}>{inviteCode || (loading ? "..." : "—")}</code>
              <button type="button" className={styles.copyBtn} onClick={copyInvite} disabled={!inviteCode}>
                Copy
              </button>
            </div>
            {error && <div className={styles.error}>{error}</div>}
          </>
        )}

        {modal === "createChannel" && (
          <>
            <h2 className={styles.title}>Create Channel</h2>
            <input
              className={styles.input}
              placeholder="Channel name"
              value={createChannelName}
              onChange={(e) => setCreateChannelName(e.target.value)}
            />
            <div className={styles.radioGroup}>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="type"
                  checked={createChannelType === "text"}
                  onChange={() => setCreateChannelType("text")}
                />
                Text
              </label>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="type"
                  checked={createChannelType === "voice"}
                  onChange={() => setCreateChannelType("voice")}
                />
                Voice
              </label>
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.primary} onClick={handleCreateChannel} disabled={loading}>
              {loading ? "..." : "Create"}
            </button>
          </>
        )}

        {modal === "renameChannel" && (
          <>
            <h2 className={styles.title}>Rename Channel</h2>
            <input
              className={styles.input}
              placeholder="Channel name"
              value={renameChannelName}
              onChange={(e) => setRenameChannelName(e.target.value)}
            />
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.primary} onClick={handleRenameChannel} disabled={loading}>
              {loading ? "..." : "Rename"}
            </button>
          </>
        )}

        {modal === "confirmDeleteServer" && (
          <>
            <h2 className={styles.title}>Delete server</h2>
            <p className={styles.confirmMessage}>
              Are you sure you want to delete <strong>{data.serverName || "this server"}</strong>? This will remove the server and all channels and messages. This cannot be undone.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryBtn} onClick={onClose} disabled={loading}>
                Cancel
              </button>
              <button type="button" className={styles.dangerBtn} onClick={handleConfirmDeleteServer} disabled={loading}>
                {loading ? "..." : "Delete"}
              </button>
            </div>
          </>
        )}

        {modal === "userSearch" && (
          <>
            <h2 className={styles.title}>Find User</h2>
            <div className={styles.searchRow}>
              <input
                className={styles.input}
                placeholder="Search by username"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button type="button" className={styles.primary} onClick={handleSearch} disabled={loading}>
                Search
              </button>
            </div>
            <div className={styles.resultList}>
              {searchResults.map((u) => (
                <button
                  type="button"
                  key={u.id}
                  className={styles.resultItem}
                  onClick={() => handleOpenDM(u.id)}
                >
                  <span className={styles.resultAvatar}>{u.avatar_emoji || "🐱"}</span>
                  {u.display_name || u.username}
                </button>
              ))}
            </div>
          </>
        )}

        {modal !== "confirmDeleteServer" && (
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
