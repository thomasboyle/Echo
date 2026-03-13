import React from "react";
import styles from "./MembersSidebar.module.css";

export default function MembersSidebar({ members, serverId, onOpenDM, onOpenModal }) {
  if (!serverId) return null;
  const online = (members || []).filter((m) => m.online);
  const offline = (members || []).filter((m) => !m.online);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        MEMBERS — {(members || []).length}
      </div>
      <div className={styles.section}>
        <span className={styles.sectionTitle}>ONLINE</span>
        {(online || []).map((m) => (
          <button
            type="button"
            key={m.id}
            className={styles.member}
            onClick={() => onOpenDM(m.id)}
          >
            <span className={styles.statusGreen} />
            <span className={styles.memberAvatar}>{m.avatar_emoji || "🐱"}</span>
            <span className={styles.memberName}>{m.display_name || m.username}</span>
          </button>
        ))}
      </div>
      <div className={styles.section}>
        <span className={styles.sectionTitle}>OFFLINE</span>
        {(offline || []).map((m) => (
          <button
            type="button"
            key={m.id}
            className={styles.member}
            onClick={() => onOpenDM(m.id)}
          >
            <span className={styles.statusGray} />
            <span className={styles.memberAvatarOffline}>{m.avatar_emoji || "🐱"}</span>
            <span className={styles.memberNameOffline}>{m.display_name || m.username}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
