import React from "react";
import styles from "./ServerSidebar.module.css";

const EMOJI_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

function formatBadgeCount(n) {
  if (n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}

export default function ServerSidebar({
  servers,
  selectedServerId,
  onSelectServer,
  unread,
  unreadByServer = {},
  mentionByServer = {},
  totalDmUnread = 0,
  view,
  onViewChange,
  onOpenModal,
  onModalData,
  onServersChange,
}) {
  return (
    <>
      <button
        type="button"
        className={`${styles.serverBtn} ${view === "dms" ? styles.active : ""}`}
        onClick={() => onViewChange("dms")}
        title="Direct Messages"
      >
        <span className={styles.homeIcon}>DM</span>
        {formatBadgeCount(totalDmUnread) && (
          <span className={styles.unreadBadge} aria-label={`${totalDmUnread} unread`}>{formatBadgeCount(totalDmUnread)}</span>
        )}
      </button>
      <div className={styles.divider} />
      {servers.map((s) => {
        const serverCount = (unreadByServer[s.id] || 0) + (mentionByServer[s.id] || 0);
        return (
        <button
          type="button"
          key={s.id}
          className={`${styles.serverBtn} ${selectedServerId === s.id && view === "servers" ? styles.active : ""}`}
          onClick={() => {
            onViewChange("servers");
            onSelectServer(s.id);
          }}
          title={s.name}
        >
          <span
            className={styles.emoji}
            style={{ background: EMOJI_COLORS[servers.indexOf(s) % EMOJI_COLORS.length] }}
          >
            {s.icon_emoji || "🌐"}
          </span>
          {formatBadgeCount(serverCount) && (
            <span className={styles.unreadBadge} aria-label={`${serverCount} unread`}>{formatBadgeCount(serverCount)}</span>
          )}
        </button>
      );})}
      <button
        type="button"
        className={styles.addBtn}
        onClick={() => {
          onOpenModal("createServer");
          onModalData && onModalData({});
        }}
        title="Add server"
      >
        +
      </button>
      <button
        type="button"
        className={styles.addBtn}
        onClick={() => {
          onOpenModal("joinServer");
          onModalData && onModalData({});
        }}
        title="Join server"
      >
        <span className={styles.joinIcon}>J</span>
      </button>
    </>
  );
}
