import React from "react";
import styles from "./NeumorphicViews.module.css";

export default function ServersView({ servers, unreadByServer, mentionByServer, onSelectServer, onOpenModal }) {
  return (
    <div className={styles.viewContainer}>
      <div className={styles.header}>
        <h1 className={styles.title}>Servers</h1>
        <div className={styles.actions}>
          <button className={`${styles.neuBtn} neu-flat`} onClick={() => onOpenModal("joinServer")} aria-label="Join Server">
            Join
          </button>
          <button className={`${styles.neuBtn} neu-flat`} onClick={() => onOpenModal("createServer")} aria-label="Create Server">
            + New
          </button>
        </div>
      </div>
      
      <div className={styles.serverGrid}>
        {servers.map((s) => {
          const unread = (unreadByServer[s.id] || 0) + (mentionByServer[s.id] || 0);
          return (
            <button 
              key={s.id} 
              className={`${styles.serverCard} neu-flat`}
              onClick={() => onSelectServer(s.id)}
            >
              <div className={styles.serverIcon}>
                {s.icon_emoji || "🌐"}
                {unread > 0 && <span className={styles.badge}>{unread > 99 ? "99+" : unread}</span>}
              </div>
              <div>
                <div className={styles.serverName}>{s.name}</div>
                <div className={styles.serverDesc}>A community space for {s.name}! Join the voice channels to hang out.</div>
              </div>
            </button>
          );
        })}
        {servers.length === 0 && (
          <div className={styles.emptyState}>
            <p>You haven't joined any servers yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
