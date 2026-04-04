import React from "react";
import styles from "./NeumorphicViews.module.css";
import ChatView from "./ChatView";

const UserIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
    <circle cx="12" cy="7" r="4"></circle>
  </svg>
);
        export default function DMsSplitView({ 
  dmList, unread, mentionByChannel, onDmSelect, onOpenModal,
  selectedChannelId, currentChannel, user, baseUrl, token, api, ws, mentionableUsers,
  onOpenDM, onUnreadClear, onMentionClear, onMessageReceived, onMentionReceived, onMembersRefresh, onActivity, onCall
}) {
  return (
    <div className={styles.viewContainer} style={{ padding: 0, flexDirection: 'row', gap: '16px', overflow: 'hidden' }}>
      
      {/* Left Pane - DM List */}
      <div style={{ width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '16px', borderRight: '1px solid var(--neu-shadow-dark)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h1 className={styles.title} style={{ fontSize: '20px', margin: 0 }}>Direct Messages</h1>
          <button type="button" className={`${styles.neuBtn} neu-flat`} onClick={() => onOpenModal("createDM")} aria-label="New DM" style={{ padding: '4px 8px', fontSize: '12px' }}>
            + New
          </button>
        </div>

        <div className={styles.channelList} style={{ flex: 1, overflowY: 'auto' }}>
          {dmList.map((dm) => {
            const u = unread[dm.id] || 0;
            const m = mentionByChannel[dm.id] || 0;
            const totalUnread = u + m;
            const isOnline = dm.other_user?.online === true;
            const isSelected = selectedChannelId === dm.id;
            
            return (
              <button 
                key={dm.id} 
                className={`${styles.channelItem} ${isSelected ? 'neu-pressed' : 'neu-flat'}`}
                onClick={() => onDmSelect(dm.id)}
                style={{ padding: '8px 12px', minHeight: '60px' }}
              >
                <div style={{ position: 'relative' }}>
                  <div className={styles.channelIcon} style={{ background: 'var(--neu-shadow-dark)', padding: '8px', borderRadius: '50%' }}>
                    <UserIcon />
                  </div>
                  <div style={{
                    position: 'absolute',
                    bottom: 0, right: 0,
                    width: '12px', height: '12px',
                    borderRadius: '50%',
                    background: isOnline ? '#23a559' : '#80848e',
                    border: '2px solid var(--neu-bg)'
                  }} />
                </div>
                
                <span className={styles.channelName} style={{ flex: 1, textAlign: 'left', marginLeft: '12px', color: 'white' }}>
                  {dm.other_user?.display_name || dm.other_user?.username || "User"}
                </span>
                {totalUnread > 0 && <span className={styles.badge} style={{position: 'static'}}>{totalUnread > 99 ? "99+" : totalUnread}</span>}
              </button>
            );
          })}
          
          {dmList.length === 0 && (
            <div className={styles.emptyState}>
              <p>You have no direct messages yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Right Pane - Chat Window */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingRight: '16px', paddingTop: '16px' }}>
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
             onBack={null} /* We don't need back logic in a split view */
             onCall={() => onCall(selectedChannelId)}
             hideBack={true}
           />
         ) : (
           <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
             <p>Select a direct message to start chatting</p>
           </div>
         )}
      </div>
      
    </div>
  );
}
