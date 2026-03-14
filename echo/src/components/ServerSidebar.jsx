import React from "react";
import styles from "./ServerSidebar.module.css";

const EMOJI_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

export default function ServerSidebar({
  servers,
  selectedServerId,
  onSelectServer,
  unread,
  unreadByServer = {},
  mentionByServer = {},
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
        <span className={styles.homeIcon}>H</span>
      </button>
      <div className={styles.divider} />
      {servers.map((s) => (
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
          {((unreadByServer[s.id] || 0) + (mentionByServer[s.id] || 0)) > 0 && <span className={styles.unread} />}
        </button>
      ))}
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
