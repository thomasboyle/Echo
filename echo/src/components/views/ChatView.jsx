import React from "react";
import styles from "./NeumorphicViews.module.css";
import MessageArea from "../MessageArea";

export default function ChatView({ 
  channel, 
  channelId, 
  user,
  baseUrl,
  token,
  api,
  ws,
  mentionableUsers,
  onOpenDM,
  onUnreadClear,
  onMentionClear,
  onMessageReceived,
  onMentionReceived,
  onMembersRefresh,
  onActivity,
  onBack,
  onCall,
  hideBack
}) {
  return (
    <div className={styles.viewContainer} style={{ padding: 0 }}>
      {/* Our custom header */}
      <div className={`${styles.header} neumorphic-chat-header`} style={{ padding: '16px', margin: 0, backgroundColor: 'var(--neu-bg)', zIndex: 10, position: 'relative', boxShadow: '0 4px 10px rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between' }}>
        <div className={styles.headerLeft}>
          {!hideBack && (
            <button className={styles.backBtn} onClick={onBack} aria-label="Back">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
            </button>
          )}
          <h1 className={styles.title} style={{ fontSize: '20px' }}>
             {channel?.type === 'text' ? `# ${channel?.name}` : channel?.other_user?.display_name || 'Chat'}
          </h1>
        </div>
        
        {onCall && (
          <div className={styles.headerRight}>
            <button className={`${styles.neuBtn} neu-flat`} onClick={onCall} aria-label="Call" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
              </svg>
              <span>Call</span>
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <MessageArea
          channel={channel}
          channelId={channelId}
          user={user}
          baseUrl={baseUrl}
          token={token}
          api={api}
          ws={ws}
          mentionableUsers={mentionableUsers}
          showChannelHeader={false}
          onOpenDM={onOpenDM}
          onUnreadClear={onUnreadClear}
          onMentionClear={onMentionClear}
          onMessageReceived={onMessageReceived}
          onMentionReceived={onMentionReceived}
          onMembersRefresh={onMembersRefresh}
          onActivity={onActivity}
        />
      </div>
    </div>
  );
}
