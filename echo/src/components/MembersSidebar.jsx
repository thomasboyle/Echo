import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List } from "react-window";
import styles from "./MembersSidebar.module.css";

const MEMBER_ROW_HEIGHT = 44;
const SECTION_ROW_HEIGHT = 28;

const MemberRow = React.memo(function MemberRow({ index, style, rows, onOpenDM }) {
  const row = rows[index];
  if (!row) return null;
  if (row.kind === "section") {
    return (
      <div style={style} className={styles.virtualSectionTitleRow}>
        <span className={styles.sectionTitle}>{row.label}</span>
      </div>
    );
  }
  const m = row.member;
  return (
    <div style={style} className={styles.memberRowWrap}>
      <button type="button" className={styles.member} onClick={() => onOpenDM(m.id)}>
        <span className={row.online ? styles.statusGreen : styles.statusGray} />
        <span className={row.online ? styles.memberAvatar : styles.memberAvatarOffline}>{m.avatar_emoji || "🐱"}</span>
        <span className={row.online ? styles.memberName : styles.memberNameOffline}>{m.display_name || m.username}</span>
      </button>
    </div>
  );
});

export default React.memo(function MembersSidebar({ members, serverId, onOpenDM, onOpenModal }) {
  const listContainerRef = useRef(null);
  const [listHeight, setListHeight] = useState(0);

  const online = useMemo(() => (members || []).filter((m) => m.online), [members]);
  const offline = useMemo(() => (members || []).filter((m) => !m.online), [members]);
  const rows = useMemo(
    () => [
      { kind: "section", label: "ONLINE" },
      ...online.map((member) => ({ kind: "member", member, online: true })),
      { kind: "section", label: "OFFLINE" },
      ...offline.map((member) => ({ kind: "member", member, online: false })),
    ],
    [online, offline]
  );
  const getItemSize = useCallback((index) => (rows[index]?.kind === "section" ? SECTION_ROW_HEIGHT : MEMBER_ROW_HEIGHT), [rows]);
  const rowProps = useMemo(() => ({ rows, onOpenDM }), [rows, onOpenDM]);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const updateHeight = () => {
      const next = Math.max(0, Math.floor(el.clientHeight));
      setListHeight((prev) => (prev === next ? prev : next));
    };
    updateHeight();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(el);
      return () => observer.disconnect();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }
  }, []);

  if (!serverId) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        MEMBERS — {(members || []).length}
      </div>
      <div className={styles.virtualList} ref={listContainerRef}>
        {listHeight > 0 && (
          <List
            rowCount={rows.length}
            rowHeight={getItemSize}
            rowComponent={MemberRow}
            rowProps={rowProps}
            overscanCount={8}
            style={{ height: listHeight, width: "100%" }}
          >
          </List>
        )}
      </div>
    </div>
  );
});
