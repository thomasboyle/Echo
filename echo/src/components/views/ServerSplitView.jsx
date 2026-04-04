import React, { useState, useRef, useEffect } from "react";
import styles from "./NeumorphicViews.module.css";
import ChatView from "./ChatView";
import MembersSidebar from "../MembersSidebar";

const HashIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="9" x2="20" y2="9"></line>
    <line x1="4" y1="15" x2="20" y2="15"></line>
    <line x1="10" y1="3" x2="8" y2="21"></line>
    <line x1="16" y1="3" x2="14" y2="21"></line>
  </svg>
);

const MicIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" y1="19" x2="12" y2="22"></line>
    <line x1="8" y1="22" x2="16" y2="22"></line>
  </svg>
);

export default function ServerSplitView({ 
  serverName, channels, unread, mentionByChannel, onSelectChannel,
  selectedChannelId, currentChannel, user, baseUrl, token, api, ws, mentionableUsers,
  onOpenDM, onUnreadClear, onMentionClear, onMessageReceived, onMentionReceived, onMembersRefresh, onActivity, onCall,
  members, serverId, onOpenModal, onServerModal,
  activeVoiceUsers = {},
  currentVoiceChannelId = null,
  onRefreshVoiceActive,
}) {
  const [serverTitleMenuOpen, setServerTitleMenuOpen] = useState(false);
  const [optimisticVoiceChannelId, setOptimisticVoiceChannelId] = useState(null);
  const serverTitleMenuRef = useRef(null);

  useEffect(() => {
    if (currentVoiceChannelId && optimisticVoiceChannelId === currentVoiceChannelId) {
      setOptimisticVoiceChannelId(null);
    }
  }, [currentVoiceChannelId, optimisticVoiceChannelId]);

  useEffect(() => {
    if (!serverTitleMenuOpen) return;
    const onDown = (e) => {
      const el = serverTitleMenuRef.current;
      if (el && !el.contains(e.target)) setServerTitleMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [serverTitleMenuOpen]);

  useEffect(() => {
    if (!serverTitleMenuOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setServerTitleMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [serverTitleMenuOpen]);

  const openModalAndCloseMenu = (kind) => {
    setServerTitleMenuOpen(false);
    onServerModal?.(kind);
  };

  const textChannels = channels.filter(c => c.type === "text" || !c.type);
  const voiceChannels = channels.filter(c => c.type === "voice");

  return (
    <div className={styles.viewContainer} style={{ padding: 0, flexDirection: 'row', gap: '16px', overflow: 'hidden' }}>
      
      {/* Left Pane - Channels List */}
      <div style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '16px', borderRight: '1px solid var(--neu-shadow-dark)' }}>
        <div className={styles.serverTitleHeader} ref={serverTitleMenuRef}>
          <button
            type="button"
            className={styles.serverTitleTrigger}
            onClick={() => setServerTitleMenuOpen((o) => !o)}
            aria-expanded={serverTitleMenuOpen}
            aria-haspopup="menu"
            aria-label={`Server menu, ${serverName || "Server"}`}
          >
            <span className={styles.serverTitleText}>{serverName || "Server"}</span>
            <span className={`${styles.serverTitleChevron} ${serverTitleMenuOpen ? styles.serverTitleChevronOpen : ""}`} aria-hidden>▼</span>
          </button>
          {serverTitleMenuOpen && onServerModal && (
            <div className={styles.serverTitleMenu} role="menu">
              <button type="button" className={styles.serverTitleMenuItem} role="menuitem" onClick={() => openModalAndCloseMenu("serverSettings")}>
                Server settings
              </button>
              <button type="button" className={styles.serverTitleMenuItem} role="menuitem" onClick={() => openModalAndCloseMenu("changeServerIcon")}>
                Change icon
              </button>
              <button type="button" className={styles.serverTitleMenuItemDanger} role="menuitem" onClick={() => openModalAndCloseMenu("confirmDeleteServer")}>
                Delete server
              </button>
            </div>
          )}
        </div>

        <div className={styles.channelList} style={{ flex: 1, overflowY: 'auto', paddingRight: '8px' }}>
          
          <h3 style={{ marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', paddingLeft: '8px', marginTop: '16px' }}>Text Channels</h3>
          {textChannels.map(c => {
            const u = unread[c.id] || 0;
            const m = mentionByChannel[c.id] || 0;
            const totalUnread = u + m;
            const isSelected = selectedChannelId === c.id;
            
            return (
              <button 
                key={c.id} 
                className={`${styles.channelItem} ${isSelected ? 'neu-pressed' : 'neu-flat'}`}
                onClick={() => onSelectChannel(c.id)}
                style={{ padding: '10px 14px', minHeight: '44px', marginBottom: '8px', width: '100%' }}
              >
                <span className={styles.channelIcon} style={{ marginRight: '12px', color: isSelected ? 'var(--text-primary)' : 'var(--text-muted)' }}><HashIcon /></span>
                <span className={styles.channelName} style={{ fontSize: '14px', flex: 1, textAlign: 'left', color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{c.name}</span>
                {totalUnread > 0 && <span className={styles.badge} style={{position: 'static', scale: '0.8'}}>{totalUnread > 99 ? "99+" : totalUnread}</span>}
              </button>
            );
          })}
          
          {voiceChannels.length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <h3 style={{ marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', paddingLeft: '8px' }}>Voice Channels</h3>
              {voiceChannels.map((c) => {
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
                const inVoice = currentVoiceChannelId === c.id || optimisticVoiceChannelId === c.id;
                const isSelected = selectedChannelId === c.id;
                const rowActive = inVoice || isSelected;
                return (
                  <React.Fragment key={c.id}>
                    <button
                      type="button"
                      className={`${styles.channelItem} ${rowActive ? "neu-pressed" : "neu-flat"}`}
                      onClick={async () => {
                        onSelectChannel(c.id);
                        if (currentVoiceChannelId === c.id || optimisticVoiceChannelId === c.id) return;
                        setOptimisticVoiceChannelId(c.id);
                        try {
                          await onCall?.(c.id);
                          onRefreshVoiceActive?.();
                        } catch (_) {}
                        finally {
                          setOptimisticVoiceChannelId((prev) => (prev === c.id ? null : prev));
                        }
                      }}
                      style={{ padding: "10px 14px", minHeight: "44px", marginBottom: "4px", width: "100%" }}
                    >
                      <span
                        className={styles.channelIcon}
                        style={{
                          marginRight: "12px",
                          color: inVoice ? "#23a559" : isSelected ? "var(--text-primary)" : "var(--text-muted)",
                        }}
                      >
                        <MicIcon />
                      </span>
                      <span
                        className={styles.channelName}
                        style={{
                          fontSize: "14px",
                          flex: 1,
                          textAlign: "left",
                          color: rowActive ? "var(--text-primary)" : "var(--text-secondary)",
                        }}
                      >
                        {c.name}
                      </span>
                      {c.voice_user_limit != null && c.voice_user_limit >= 1 && channelUsers.length >= c.voice_user_limit && (
                        <span className={styles.voiceChannelFull}>Full</span>
                      )}
                    </button>
                    {renderedVoiceUsers.length > 0 && (
                      <div className={styles.voiceChannelUsers}>
                        {renderedVoiceUsers.map((u) => (
                          <div key={u.id} className={styles.voiceChannelUser}>
                            <span className={styles.voiceChannelUserAvatar} aria-hidden>
                              {u.avatar_emoji || "🐱"}
                            </span>
                            <span
                              className={`${styles.voiceChannelUserName} ${u.__optimistic ? styles.voiceChannelUserPending : ""}`}
                            >
                              {u.display_name || "User"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
          
          {channels.length === 0 && (
            <div className={styles.emptyState} style={{ padding: '24px 0', fontSize: '12px' }}>
              <p>No channels here.</p>
            </div>
          )}
        </div>
      </div>

      {/* Middle Pane - Chat Window */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingTop: '16px' }}>
         {selectedChannelId && currentChannel ? (
           <ChatView
             channel={currentChannel}
             channelId={selectedChannelId}
             user={user}
             baseUrl={baseUrl}
             token={token}
             api={api}
             ws={ws}
             mentionableUsers={mentionableUsers}
             onOpenDM={onOpenDM}
             onUnreadClear={onUnreadClear}
             onMentionClear={onMentionClear}
             onMessageReceived={onMessageReceived}
             onMentionReceived={onMentionReceived}
             onMembersRefresh={onMembersRefresh}
             onActivity={onActivity}
             onBack={null} 
             hideBack={true}
           />
         ) : (
           <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
             <p>Select a channel to start chatting</p>
           </div>
         )}
      </div>

      {/* Right Pane - Members */}
      <div style={{ width: '240px', flexShrink: 0, padding: '16px', borderLeft: '1px solid var(--neu-shadow-dark)' }}>
        <div className={`neu-flat`} style={{ height: '100%', overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
            <MembersSidebar
                members={members}
                serverId={serverId}
                onOpenDM={onOpenDM}
                onOpenModal={onOpenModal}
            />
        </div>
      </div>
      
    </div>
  );
}
