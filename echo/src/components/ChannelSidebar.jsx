import React, { useState, useRef, useEffect } from "react";
import styles from "./ChannelSidebar.module.css";

export default function ChannelSidebar({
  view,
  serverName,
  channels,
  selectedChannelId,
  selectedServerId,
  onSelectChannel,
  dmList,
  user,
  members,
  api,
  onOpenModal,
  onModalData,
  onChannelsChange,
  onDmSelect,
  webrtc,
  currentVoiceChannelId,
  activeVoiceTimers = {},
  activeVoiceUsers = {},
  onRefreshVoiceActive,
  onVoiceUserAction,
}) {
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const contextMenuRef = useRef(null);
  const channelContextMenuRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [channelContextMenu, setChannelContextMenu] = useState(null);
  const [channelBandwidth, setChannelBandwidth] = useState(null);

  useEffect(() => {
    if (!serverMenuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setServerMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [serverMenuOpen]);

  useEffect(() => {
    if (!contextMenu && !channelContextMenu) return;
    const close = (e) => {
      if (contextMenuRef.current?.contains(e.target)) return;
      if (channelContextMenuRef.current?.contains(e.target)) return;
      setContextMenu(null);
      setChannelContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [contextMenu, channelContextMenu]);

  useEffect(() => {
    if (!channelContextMenu?.channel) {
      setChannelBandwidth(null);
      return;
    }
    const v = channelContextMenu.channel.voice_bandwidth_kbps;
    setChannelBandwidth(typeof v === "number" ? v : 320);
  }, [channelContextMenu]);

  const handleVoiceBandwidthChange = async (channel, value) => {
    if (!api || !selectedServerId || !channel?.id) return;
    const bandwidth = Number(value);
    if (!Number.isFinite(bandwidth)) return;
    setChannelBandwidth(bandwidth);
    try {
      if (typeof api.updateChannelSettings === "function") {
        await api.updateChannelSettings(selectedServerId, channel.id, {
          voice_bandwidth_kbps: bandwidth,
        });
      }
      onChannelsChange?.();
    } catch (_) {}
  };

  const commitVoiceBandwidthChange = () => {
    if (!channelContextMenu?.channel) return;
    const value = channelBandwidth ?? 320;
    handleVoiceBandwidthChange(channelContextMenu.channel, value);
  };

  const textChannels = (channels || []).filter((c) => c.type === "text");
  const voiceChannels = (channels || []).filter((c) => c.type === "voice");

  const [now, setNow] = useState(() => Date.now());
  const hasActiveTimers = (activeVoiceTimers && Object.keys(activeVoiceTimers).length > 0) || false;
  useEffect(() => {
    if (!hasActiveTimers) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveTimers]);

  const formatElapsed = (startedAtIso) => {
    const start = new Date(startedAtIso).getTime();
    const elapsed = Math.floor((now - start) / 1000);
    if (elapsed < 0) return "0:00:00";
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${h}:${pad(m)}:${pad(s)}`;
  };

  const handleInvite = () => {
    setServerMenuOpen(false);
    onOpenModal("inviteCode");
    onModalData && onModalData({ serverId: selectedServerId });
  };

  const handleDeleteServer = () => {
    setServerMenuOpen(false);
    onOpenModal("confirmDeleteServer");
    onModalData && onModalData({ serverId: selectedServerId, serverName });
  };

  if (view === "dms") {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.dmTitle}>Direct Messages</span>
          <button
            type="button"
            className={styles.addChannel}
            onClick={() => { onOpenModal("userSearch"); onModalData && onModalData({}); }}
            title="Find user"
          >
            +
          </button>
        </div>
        <div className={styles.channelList}>
          {dmList.map((dm) => (
            <button
              type="button"
              key={dm.id}
              className={`${styles.channelItem} ${selectedChannelId === dm.id ? styles.active : ""}`}
              onClick={() => onSelectChannel(dm.id)}
            >
              <span className={styles.dmAvatar}>{dm.other_user?.avatar_emoji || "🐱"}</span>
              {dm.other_user?.display_name || "User"}
            </button>
          ))}
        </div>
        <div className={styles.userPanel}>
          <span className={styles.userAvatar}>{user?.avatar_emoji || "🐱"}</span>
          <span className={styles.userName}>{user?.display_name || "User"}</span>
          <button
            type="button"
            onClick={() => { onOpenModal("userSettings"); onModalData && onModalData({}); }}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header} ref={menuRef}>
        <button
          type="button"
          className={styles.serverHeaderBtn}
          onClick={() => setServerMenuOpen((o) => !o)}
          title={serverName || "Server"}
        >
          <span className={styles.serverName}>{serverName || "Server"}</span>
          <span className={`${styles.chevron} ${serverMenuOpen ? styles.chevronOpen : ""}`}>▼</span>
        </button>
        {serverMenuOpen && (
          <div className={styles.serverMenu}>
            <button type="button" className={styles.serverMenuItem} onClick={handleInvite}>
              Invite
            </button>
            <button type="button" className={styles.serverMenuDelete} onClick={handleDeleteServer}>
              Delete server
            </button>
          </div>
        )}
      </div>
      <div className={styles.divider} />
      <div className={styles.section}>
        <span className={styles.sectionTitle}>TEXT CHANNELS</span>
        <button
          type="button"
          className={styles.addChannel}
          onClick={() => { onOpenModal("createChannel"); onModalData && onModalData({}); }}
          title="Create channel"
        >
          +
        </button>
      </div>
      {textChannels.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`${styles.channelItem} ${selectedChannelId === c.id ? styles.active : ""}`}
          onClick={() => onSelectChannel(c.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setChannelContextMenu({ x: e.clientX, y: e.clientY, channel: c });
          }}
        >
          # {c.name}
        </button>
      ))}
      <div className={styles.section}>
        <span className={styles.sectionTitle}>VOICE CHANNELS</span>
        <button
          type="button"
          className={styles.addChannel}
          onClick={() => { onOpenModal("createChannel"); onModalData && onModalData({ type: "voice" }); }}
          title="Create voice channel"
        >
          +
        </button>
      </div>
      {voiceChannels.map((c) => (
        <React.Fragment key={c.id}>
          <button
            type="button"
            className={`${styles.channelItem} ${currentVoiceChannelId === c.id ? styles.activeVoice : ""}`}
            onClick={async () => {
              if (currentVoiceChannelId === c.id) return;
              try {
                if (currentVoiceChannelId) {
                  await webrtc?.leaveVoice?.();
                  onRefreshVoiceActive?.();
                }
                await webrtc?.joinVoice?.(c.id);
                onRefreshVoiceActive?.();
              } catch (_) {}
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setChannelContextMenu({ x: e.clientX, y: e.clientY, channel: c });
            }}
          >
            <span className={styles.voiceChannelName}>🔊 {c.name}</span>
            {activeVoiceTimers[c.id] && (
              <span className={styles.voiceTimer} aria-label={`Active for ${formatElapsed(activeVoiceTimers[c.id])}`}>
                {formatElapsed(activeVoiceTimers[c.id])}
              </span>
            )}
          </button>
          {activeVoiceUsers[c.id]?.length > 0 && (
            <div className={styles.voiceChannelUsers}>
              {activeVoiceUsers[c.id].map((u) => (
                <div
                  key={u.id}
                  className={styles.voiceChannelUser}
                  onContextMenu={(e) => {
                    if (user?.id === u.id) return;
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      channelId: c.id,
                      user: u,
                    });
                  }}
                >
                  <span className={styles.voiceChannelUserAvatar}>{u.avatar_emoji || "🐱"}</span>
                  <span className={styles.voiceChannelUserName}>{u.display_name || "User"}</span>
                </div>
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
      {channelContextMenu && (
        <div
          ref={channelContextMenuRef}
          className={styles.voiceChannelUserContextMenu}
          style={{ left: channelContextMenu.x, top: channelContextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            className={styles.voiceChannelUserContextMenuItem}
            role="menuitem"
            onClick={() => {
              onOpenModal("renameChannel");
              onModalData?.({ channel: channelContextMenu.channel, serverId: selectedServerId });
              setChannelContextMenu(null);
            }}
          >
            Rename
          </button>
          {channelContextMenu.channel?.type === "voice" && (
            <div className={styles.voiceChannelContextSection}>
              <div className={styles.voiceChannelBandwidthLabel}>
                <span>Bandwidth</span>
                <span>{(channelBandwidth ?? 320).toFixed(0)} kbps</span>
              </div>
              <input
                type="range"
                min={8}
                max={1000}
                step={8}
                value={channelBandwidth ?? 320}
                className={styles.voiceChannelBandwidthSlider}
                onChange={(e) => setChannelBandwidth(Number(e.target.value))}
                onMouseUp={commitVoiceBandwidthChange}
                onTouchEnd={commitVoiceBandwidthChange}
              />
            </div>
          )}
        </div>
      )}
      {webrtc?.voiceError && (
        <div className={styles.voiceError} role="alert">
          {webrtc.voiceError}
        </div>
      )}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.voiceChannelUserContextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            className={styles.voiceChannelUserContextMenuItem}
            role="menuitem"
            onClick={() => {
              onVoiceUserAction?.(contextMenu.channelId, contextMenu.user, "serverMute");
              setContextMenu(null);
            }}
          >
            Server mute
          </button>
          <button
            type="button"
            className={styles.voiceChannelUserContextMenuItem}
            role="menuitem"
            onClick={() => {
              onVoiceUserAction?.(contextMenu.channelId, contextMenu.user, "serverDeafen");
              setContextMenu(null);
            }}
          >
            Server deafen
          </button>
          <button
            type="button"
            className={`${styles.voiceChannelUserContextMenuItem} ${styles.danger}`}
            role="menuitem"
            onClick={() => {
              onVoiceUserAction?.(contextMenu.channelId, contextMenu.user, "disconnect");
              setContextMenu(null);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
      <div className={styles.spacer} />
      <div className={styles.userPanel}>
        <span className={styles.userAvatar}>{user?.avatar_emoji || "🐱"}</span>
        <span className={styles.userName}>{user?.display_name || "User"}</span>
        <button
          type="button"
          onClick={() => { onOpenModal("userSettings"); onModalData && onModalData({}); }}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
