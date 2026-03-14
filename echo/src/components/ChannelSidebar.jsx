import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./ChannelSidebar.module.css";

function LivePreviewVideo({ stream }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  if (!stream || stream.getVideoTracks().length === 0) return null;
  return (
    <video ref={videoRef} autoPlay playsInline muted className={styles.livePreviewVideo} />
  );
}

function formatBadgeCount(n) {
  if (n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}

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
  unread = {},
  mentionByChannel = {},
  onOpenModal,
  onModalData,
  onChannelsChange,
  onChannelUpdated,
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
  const [channelUserLimit, setChannelUserLimit] = useState(null);
  const [optimisticVoiceChannelId, setOptimisticVoiceChannelId] = useState(null);
  const [livePreviewUserId, setLivePreviewUserId] = useState(null);
  const [livePreviewAnchorRect, setLivePreviewAnchorRect] = useState(null);
  const livePreviewLeaveDelayRef = useRef(null);

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
      setChannelUserLimit(null);
      return;
    }
    const v = channelContextMenu.channel.voice_bandwidth_kbps;
    setChannelBandwidth(typeof v === "number" ? v : 320);
    const limit = channelContextMenu.channel.voice_user_limit;
    setChannelUserLimit(typeof limit === "number" && limit >= 1 && limit <= 100 ? limit : 0);
  }, [channelContextMenu]);

  useEffect(() => {
    if (currentVoiceChannelId && optimisticVoiceChannelId === currentVoiceChannelId) {
      setOptimisticVoiceChannelId(null);
    }
  }, [currentVoiceChannelId, optimisticVoiceChannelId]);

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

  const handleVoiceUserLimitChange = async (channel, value) => {
    if (!api || !selectedServerId || !channel?.id) return;
    const limit = value === 0 || value === "0" ? 0 : Math.max(1, Math.min(100, Number(value)));
    setChannelUserLimit(limit);
    try {
      if (typeof api.updateChannelSettings === "function") {
        const updated = await api.updateChannelSettings(selectedServerId, channel.id, {
          voice_user_limit: limit === 0 ? 0 : limit,
        });
        onChannelUpdated?.(updated);
      }
      onChannelsChange?.();
    } catch (_) {}
  };

  const commitVoiceUserLimitChange = () => {
    if (!channelContextMenu?.channel) return;
    const value = channelUserLimit ?? 0;
    handleVoiceUserLimitChange(channelContextMenu.channel, value);
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

  const getVoiceState = (voiceUser, currentUserId, currentWebRtcState) => {
    const isCurrentUser = !!currentUserId && voiceUser?.id === currentUserId;
    const mutedFromData = !!(
      voiceUser?.is_muted ||
      voiceUser?.muted ||
      voiceUser?.server_muted ||
      voiceUser?.serverMute ||
      voiceUser?.voice_muted
    );
    const deafenedFromData = !!(
      voiceUser?.is_deafened ||
      voiceUser?.deafened ||
      voiceUser?.server_deafened ||
      voiceUser?.serverDeafen ||
      voiceUser?.voice_deafened
    );
    return {
      muted: isCurrentUser ? !!currentWebRtcState?.isMuted : mutedFromData,
      deafened: isCurrentUser ? !!currentWebRtcState?.isDeafened : deafenedFromData,
    };
  };

  const livePreviewStream = (() => {
    if (!livePreviewUserId || !webrtc) return null;
    if (livePreviewUserId === user?.id) return webrtc.localScreenStream || null;
    const peer = (webrtc.peers || []).find((p) => p.userId === livePreviewUserId);
    const stream = peer?.stream;
    if (!stream || stream.getVideoTracks().length === 0) return null;
    const videoTracks = stream.getVideoTracks().filter((t) => t.readyState === "live");
    return videoTracks.length > 0 ? new MediaStream(videoTracks) : null;
  })();

  const clearLivePreview = () => {
    if (livePreviewLeaveDelayRef.current) {
      clearTimeout(livePreviewLeaveDelayRef.current);
      livePreviewLeaveDelayRef.current = null;
    }
    setLivePreviewUserId(null);
    setLivePreviewAnchorRect(null);
  };

  const scheduleClearLivePreview = () => {
    if (livePreviewLeaveDelayRef.current) clearTimeout(livePreviewLeaveDelayRef.current);
    livePreviewLeaveDelayRef.current = setTimeout(clearLivePreview, 200);
  };

  const handleInvite = () => {
    setServerMenuOpen(false);
    onOpenModal("inviteCode");
    onModalData && onModalData({ serverId: selectedServerId });
  };

  const handleRenameServer = () => {
    setServerMenuOpen(false);
    onOpenModal("renameServer");
    onModalData && onModalData({ serverId: selectedServerId, serverName });
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
              {formatBadgeCount((unread[dm.id] || 0) + (mentionByChannel[dm.id] || 0)) && (
                <span className={styles.channelUnreadBadge} aria-label="Unread">
                  {formatBadgeCount((unread[dm.id] || 0) + (mentionByChannel[dm.id] || 0))}
                </span>
              )}
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
            <button type="button" className={styles.serverMenuItem} onClick={handleRenameServer}>
              Rename server
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
          <span className={styles.channelItemName}># {c.name}</span>
          {formatBadgeCount((unread[c.id] || 0) + (mentionByChannel[c.id] || 0)) && (
            <span className={styles.channelUnreadBadge} aria-label="Unread">
              {formatBadgeCount((unread[c.id] || 0) + (mentionByChannel[c.id] || 0))}
            </span>
          )}
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
          {(() => {
            const channelUsers = activeVoiceUsers[c.id] || [];
            const hasCurrentUser = !!user?.id && channelUsers.some((u) => u.id === user.id);
            const isOptimisticJoin = optimisticVoiceChannelId === c.id;
            const shouldRenderCurrentUser =
              !!user?.id && (isOptimisticJoin || (currentVoiceChannelId === c.id && !hasCurrentUser));
            const renderedVoiceUsersSource = shouldRenderCurrentUser
              ? [
                  {
                    id: user.id,
                    display_name: user.display_name || "You",
                    avatar_emoji: user.avatar_emoji || "🐱",
                    __optimistic: isOptimisticJoin,
                  },
                  ...channelUsers,
                ]
              : channelUsers;
            const seenVoiceUserIds = new Set();
            const renderedVoiceUsers = renderedVoiceUsersSource.filter((voiceUser) => {
              const voiceUserId = voiceUser?.id;
              if (!voiceUserId || seenVoiceUserIds.has(voiceUserId)) return false;
              seenVoiceUserIds.add(voiceUserId);
              return true;
            });
            return (
              <>
                <button
                  type="button"
                  className={`${styles.channelItem} ${
                    currentVoiceChannelId === c.id || optimisticVoiceChannelId === c.id ? styles.activeVoice : ""
                  }`}
                  onClick={async () => {
                    if (currentVoiceChannelId === c.id || optimisticVoiceChannelId === c.id) return;
                    setOptimisticVoiceChannelId(c.id);
                    try {
                      await webrtc?.joinVoice?.(c.id);
                      onRefreshVoiceActive?.();
                    } catch (_) {}
                    finally {
                      setOptimisticVoiceChannelId((prev) => (prev === c.id ? null : prev));
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setChannelContextMenu({ x: e.clientX, y: e.clientY, channel: c });
                  }}
                >
                  <span
                    className={`${styles.voiceChannelName} ${
                      currentVoiceChannelId === c.id || optimisticVoiceChannelId === c.id
                        ? styles.voiceChannelNameGlint
                        : ""
                    }`}
                  >
                    🔊 {c.name}
                  </span>
                  {activeVoiceTimers[c.id] && (
                    <span className={styles.voiceTimer} aria-label={`Active for ${formatElapsed(activeVoiceTimers[c.id])}`}>
                      {formatElapsed(activeVoiceTimers[c.id])}
                    </span>
                  )}
                  {c.voice_user_limit != null && c.voice_user_limit >= 1 && channelUsers.length >= c.voice_user_limit && (
                    <span className={styles.voiceChannelFull}>Full</span>
                  )}
                </button>
                {renderedVoiceUsers.length > 0 && (
                  <div className={styles.voiceChannelUsers}>
                    {renderedVoiceUsers.map((u) => (
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
                        <span className={styles.voiceChannelUserMeta}>
                          <span
                            className={`${styles.voiceChannelUserName} ${u.__optimistic ? styles.voiceJoinPending : ""}`}
                          >
                            {u.display_name || "User"}
                          </span>
                          {(() => {
                            const isScreensharing =
                              u.id === user?.id ? webrtc?.isScreensharing : webrtc?.peerScreensharing?.[u.id];
                            const voiceState = getVoiceState(u, user?.id, webrtc);
                            return (
                              <>
                                {isScreensharing && (
                                  <span
                                    className={styles.voiceLiveBadgeWrap}
                                    onMouseEnter={(e) => {
                                      if (livePreviewLeaveDelayRef.current) {
                                        clearTimeout(livePreviewLeaveDelayRef.current);
                                        livePreviewLeaveDelayRef.current = null;
                                      }
                                      setLivePreviewUserId(u.id);
                                      setLivePreviewAnchorRect(e.currentTarget.getBoundingClientRect());
                                    }}
                                    onMouseLeave={scheduleClearLivePreview}
                                  >
                                    <span className={styles.voiceLiveBadge} title="Screensharing">
                                      LIVE
                                    </span>
                                  </span>
                                )}
                                {voiceState.muted && (
                                  <span
                                    className={styles.voiceStateIcon}
                                    aria-label="Muted"
                                    title="Muted"
                                  >
                                    &#x1F507;
                                  </span>
                                )}
                                {voiceState.deafened && (
                                  <span
                                    className={styles.voiceStateIcon}
                                    aria-label="Deafened"
                                    title="Deafened"
                                  >
                                    &#x1F515;
                                  </span>
                                )}
                              </>
                            );
                          })()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
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
          <button
            type="button"
            className={`${styles.voiceChannelUserContextMenuItem} ${styles.danger}`}
            role="menuitem"
            onClick={() => {
              onOpenModal("confirmDeleteChannel");
              onModalData?.({ channel: channelContextMenu.channel, serverId: selectedServerId });
              setChannelContextMenu(null);
            }}
          >
            Delete channel
          </button>
          {channelContextMenu.channel?.type === "voice" && (
            <>
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
              <div className={styles.voiceChannelContextSection}>
                <div className={styles.voiceChannelBandwidthLabel}>
                  <span>User limit</span>
                  <span>{channelUserLimit === 0 ? "No limit" : (channelUserLimit ?? 0)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={channelUserLimit ?? 0}
                  className={styles.voiceChannelBandwidthSlider}
                  onChange={(e) => setChannelUserLimit(Number(e.target.value))}
                  onMouseUp={commitVoiceUserLimitChange}
                  onTouchEnd={commitVoiceUserLimitChange}
                />
              </div>
            </>
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
      {livePreviewUserId != null &&
        livePreviewAnchorRect != null &&
        createPortal(
          <div
            className={styles.livePreviewPopover}
            style={{
              left: livePreviewAnchorRect.left,
              bottom: typeof window !== "undefined" ? window.innerHeight - livePreviewAnchorRect.top + 6 : 0,
            }}
            onMouseEnter={() => {
              if (livePreviewLeaveDelayRef.current) {
                clearTimeout(livePreviewLeaveDelayRef.current);
                livePreviewLeaveDelayRef.current = null;
              }
            }}
            onMouseLeave={scheduleClearLivePreview}
          >
            <LivePreviewVideo stream={livePreviewStream} />
          </div>,
          document.body
        )}
    </div>
  );
}
