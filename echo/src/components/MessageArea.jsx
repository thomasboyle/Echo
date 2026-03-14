import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./MessageArea.module.css";
import { debouncedSearchGifs, gifToAttachment } from "../api/giphy";
import notificationSoundUrl from "@assets/sounds/Notification.mp3";

const MENTION_RE = /@([\w-]+)(?=\s|$)/g;

function getMentionedUsernames(content) {
  if (!content || typeof content !== "string") return new Set();
  const set = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(content)) !== null) set.add(m[1].toLowerCase());
  return set;
}

function parseMessageContent(content) {
  if (!content || typeof content !== "string") return [{ type: "text", value: content || "" }];
  const re = /@([\w-]+)(?=\s|$)/g;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIndex) parts.push({ type: "text", value: content.slice(lastIndex, m.index) });
    parts.push({ type: "mention", value: m[0] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < content.length) parts.push({ type: "text", value: content.slice(lastIndex) });
  return parts.length ? parts : [{ type: "text", value: content }];
}

function playNotificationSound() {
  if (!notificationSoundUrl) return;
  const el = new Audio(notificationSoundUrl);
  el.volume = 0.6;
  el.play().catch(() => {});
}

const GROUP_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_MESSAGES = 200;

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function isImageFile(file) {
  const t = (file.type || "").toLowerCase();
  return ALLOWED_IMAGE_TYPES.includes(t) || t.startsWith("image/");
}

function MessageGroup({ messages, currentUserId, baseUrl, onMentionClick }) {
  const first = messages[0];
  const author = first?.author || {};
  const handleMentionClick = (mentionText) => {
    const username = mentionText.startsWith("@") ? mentionText.slice(1) : mentionText;
    onMentionClick?.(username);
  };
  return (
    <div className={styles.messageGroup}>
      <div className={styles.messageAvatar}>{author.avatar_emoji || "🐱"}</div>
      <div className={styles.messageBody}>
        <div className={styles.messageHeader}>
          <span className={styles.displayName}>{author.display_name || "User"}</span>
          <span className={styles.time}>{formatTime(first?.created_at)}</span>
        </div>
        {messages.map((m) => (
          <div key={m.id} className={styles.messageContent}>
            {m.content && (
              <span>
                {parseMessageContent(m.content).map((part, i) =>
                  part.type === "mention" ? (
                    <button
                      key={i}
                      type="button"
                      className={styles.mention}
                      onClick={() => handleMentionClick(part.value)}
                      title={`Message ${part.value}`}
                    >
                      {part.value}
                    </button>
                  ) : (
                    part.value
                  )
                )}
              </span>
            )}
            {m.attachments?.length > 0 && (
              <div className={styles.attachmentList}>
                {m.attachments.map((att, i) => (
                  <a
                    key={i}
                    href={att.url?.startsWith("http") ? att.url : `${baseUrl || ""}${att.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.attachmentLink}
                  >
                    <img
                      src={att.url?.startsWith("http") ? att.url : `${baseUrl || ""}${att.url}`}
                      alt={att.filename || "Image"}
                      className={styles.attachmentImage}
                    />
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MessageArea({
  channel,
  channelId,
  user,
  baseUrl,
  token,
  api,
  ws,
  mentionableUsers = [],
  onOpenDM,
  onUnreadClear,
  onMentionClear,
  onMessageReceived,
  onMentionReceived,
  onMembersRefresh,
  onActivity,
}) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typing, setTyping] = useState([]);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showGifSearch, setShowGifSearch] = useState(false);
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState({ data: [], pagination: {} });
  const [gifSearching, setGifSearching] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [sending, setSending] = useState(false);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartOffset, setMentionStartOffset] = useState(0);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const attachMenuRef = useRef(null);
  const attachMenuCloseTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);
  const nextCursorRef = useRef(null);
  const [scrollAtBottom, setScrollAtBottom] = useState(true);
  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const scrollAtBottomRef = useRef(scrollAtBottom);
  scrollAtBottomRef.current = scrollAtBottom;

  const currentUserId = user?.id;
  const onMessageReceivedRef = useRef(onMessageReceived);
  const onMentionReceivedRef = useRef(onMentionReceived);
  const onMembersRefreshRef = useRef(onMembersRefresh);
  const onActivityRef = useRef(onActivity);
  onMessageReceivedRef.current = onMessageReceived;
  onMentionReceivedRef.current = onMentionReceived;
  onMembersRefreshRef.current = onMembersRefresh;
  onActivityRef.current = onActivity;

  const handleMentionClick = useCallback(
    async (username) => {
      if (!api || !onOpenDM || !username.trim()) return;
      try {
        const list = await api.searchUsers(username.trim());
        const exact = (list || []).find(
          (u) => (u.username || "").toLowerCase() === username.trim().toLowerCase()
        );
        const target = exact || (list || [])[0];
        if (target?.id) onOpenDM(target.id);
      } catch (_) {}
    },
    [api, onOpenDM]
  );

  const mentionSuggestionsFiltered = React.useMemo(() => {
    if (!mentionQuery.trim()) return mentionableUsers.slice(0, 8);
    const q = mentionQuery.toLowerCase();
    return mentionableUsers
      .filter(
        (u) =>
          (u.username || "").toLowerCase().startsWith(q) ||
          (u.display_name || "").toLowerCase().startsWith(q)
      )
      .slice(0, 8);
  }, [mentionableUsers, mentionQuery]);

  const applyMentionSuggestion = useCallback(
    (selectedUser) => {
      const name = selectedUser?.username || selectedUser?.display_name;
      if (!name) return;
      const before = input.slice(0, mentionStartOffset);
      const after = input.slice(messageInputRef.current?.selectionStart ?? input.length);
      const insert = `@${name} `;
      const next = before + insert + after;
      setInput(next.slice(0, 3000));
      setShowMentionSuggestions(false);
      setMentionQuery("");
      setMentionSelectedIndex(0);
      nextCursorRef.current = before.length + insert.length;
    },
    [input, mentionStartOffset]
  );

  useEffect(() => {
    const el = messageInputRef.current;
    if (!el || nextCursorRef.current == null) return;
    const pos = nextCursorRef.current;
    nextCursorRef.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [input]);

  const loadMessages = useCallback(
    async (before = null) => {
      if (!channelId || !api) return;
      if (before) setLoadingMore(true);
      else setLoading(true);
      try {
        const list = await api.getMessages(channelId, 50, before);
        if (before) {
          setMessages((prev) => {
            const next = [...list, ...prev];
            return next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
          });
        } else {
          setMessages(list);
        }
      } catch (_) {
      } finally {
        if (before) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [channelId, api]
  );

  useEffect(() => {
    if (channelId) {
      onUnreadClear?.();
      onMentionClear?.();
      loadMessages();
    } else {
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when channel or loadMessages changes; callbacks are unstable and would cause request loop
  }, [channelId, loadMessages]);

  useEffect(() => {
    ws.setCallbacks({
      onMessage: (data) => {
        const currentChannelId = channelIdRef.current;
        if (data.channel_id !== currentChannelId) return;
        const normalized = {
          ...data,
          author_id: data.author?.id ?? data.author_id,
        };
        setMessages((prev) => {
          const rest = prev.filter(
            (m) => !(m.optimistic && m.content === normalized.content && (m.author_id || m.author?.id) === currentUserId)
          );
          if (rest.some((m) => m.id === normalized.id)) return rest;
          return [...rest, normalized];
        });
        onMessageReceivedRef.current?.(data);
        onActivityRef.current?.();
        if (scrollAtBottomRef.current && listRef.current) {
          requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
        }
        const mentioned = getMentionedUsernames(data.content);
        const myName = (user?.username || user?.display_name || "").toLowerCase();
        if (myName && mentioned.has(myName)) {
          playNotificationSound();
          invoke("show_notification", { title: "Mention", body: `${data.author?.display_name}: ${(data.content || "").slice(0, 50)}...` }).catch(() => {});
          onMentionReceivedRef.current?.(data);
        }
      },
      onTyping: (data) => {
        setTyping((t) => {
          const next = t.filter((x) => x.user?.id !== data.user?.id);
          if (data.user?.id && data.user.id !== currentUserId) next.push({ user: data.user });
          return next;
        });
        setTimeout(() => setTyping((t) => t.filter((x) => x.user?.id !== data.user?.id)), 5000);
      },
      onUserJoin: () => {
        onMembersRefreshRef.current?.();
        onActivityRef.current?.();
      },
      onUserLeave: () => {
        onMembersRefreshRef.current?.();
        onActivityRef.current?.();
      },
    });
  }, [user, currentUserId]);

  useEffect(() => {
    if (channelId) {
      ws.disconnect();
      if (channel && channel.type === "text") {
        ws.connect(channelId);
      }
    } else {
      ws.disconnect();
    }
    return () => {
      ws.disconnect();
    };
  }, [channelId, channel?.type]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setScrollAtBottom(atBottom);
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text && pendingAttachments.length === 0) return;
    if (text.length > 3000) return;

    const doSend = async (content, attachments) => {
      const optimistic = {
        id: `opt-${Date.now()}`,
        channel_id: channelId,
        author_id: currentUserId,
        author: {
          id: user?.id,
          display_name: user?.display_name ?? "User",
          avatar_emoji: user?.avatar_emoji ?? "🐱",
        },
        content,
        attachments: attachments || [],
        created_at: new Date().toISOString(),
        optimistic: true,
      };
      setMessages((prev) => [...prev, optimistic]);
      setInput("");
      setPendingAttachments([]);
      pendingAttachments.forEach((a) => a.previewUrl && a.previewUrl.startsWith("blob:") && URL.revokeObjectURL(a.previewUrl));
      ws.sendMessage(content, attachments || []);
      if (scrollAtBottom && listRef.current) {
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
      }
    };

    const urlOnlyAttachments = pendingAttachments.filter((a) => a.url && !a.file).map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type }));
    const fileAttachments = pendingAttachments.filter((a) => a.file);

    if (fileAttachments.length === 0) {
      doSend(text, urlOnlyAttachments);
      return;
    }

    setSending(true);
    setUploadError(null);
    Promise.all(fileAttachments.map(({ file }) => api.uploadAttachment(channelId, file)))
      .then((results) => {
        const uploaded = results.map((r) => ({ url: r.url, filename: r.filename, content_type: r.content_type }));
        doSend(text, [...urlOnlyAttachments, ...uploaded]);
      })
      .catch((err) => {
        setUploadError(err?.message || "Upload failed");
      })
      .finally(() => {
        setSending(false);
      });
  };

  const addPendingFiles = useCallback((files) => {
    const next = [];
    for (const file of Array.from(files || [])) {
      if (!isImageFile(file)) continue;
      if (file.size > MAX_ATTACHMENT_SIZE) continue;
      next.push({
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    }
    if (next.length) {
      setPendingAttachments((prev) => [...prev, ...next].slice(0, 10));
      setUploadError(null);
    }
  }, []);

  const removePendingAttachment = (index) => {
    setPendingAttachments((prev) => {
      const a = prev[index];
      if (a?.previewUrl && a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const addPendingGif = useCallback(
    (gif) => {
      const att = gifToAttachment(gif);
      if (!att) return;
      const content = input.trim().slice(0, 3000);
      const optimistic = {
        id: `opt-${Date.now()}`,
        channel_id: channelId,
        author_id: currentUserId,
        author: {
          id: user?.id,
          display_name: user?.display_name ?? "User",
          avatar_emoji: user?.avatar_emoji ?? "🐱",
        },
        content,
        attachments: [att],
        created_at: new Date().toISOString(),
        optimistic: true,
      };
      setMessages((prev) => [...prev, optimistic]);
      setInput("");
      setPendingAttachments([]);
      setShowGifSearch(false);
      setGifQuery("");
      setGifResults({ data: [], pagination: {} });
      ws.sendMessage(content, [att]);
      if (scrollAtBottom && listRef.current) {
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
      }
    },
    [channelId, currentUserId, user, input, ws, scrollAtBottom]
  );

  useEffect(() => {
    if (!showGifSearch) return;
    setGifSearching(true);
    debouncedSearchGifs(gifQuery, 0, (result) => {
      setGifResults(result);
      setGifSearching(false);
    });
  }, [showGifSearch, gifQuery]);

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addPendingFiles(files);
    }
  };

  const handleKeyDown = (e) => {
    if (showMentionSuggestions && mentionSuggestionsFiltered.length > 0) {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyMentionSuggestion(mentionSuggestionsFiltered[mentionSelectedIndex]);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSelectedIndex((i) => (i + 1) % mentionSuggestionsFiltered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSelectedIndex(
          (i) => (i - 1 + mentionSuggestionsFiltered.length) % mentionSuggestionsFiltered.length
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentionSuggestions(false);
        setMentionQuery("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (e) => {
    const el = e.target;
    setInput(el.value);
    sendTyping();
    const pos = el.selectionStart;
    const textBefore = el.value.slice(0, pos);
    const lastAt = textBefore.lastIndexOf("@");
    const afterAt = lastAt >= 0 ? textBefore.slice(lastAt + 1) : "";
    const inMention = lastAt >= 0 && /^\S*$/.test(afterAt);
    if (inMention && mentionableUsers.length > 0) {
      setShowMentionSuggestions(true);
      setMentionQuery(afterAt);
      setMentionStartOffset(lastAt);
      setMentionSelectedIndex(0);
    } else {
      setShowMentionSuggestions(false);
    }
  };

  const typingTimeoutRef = useRef(null);
  const sendTyping = () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    ws.sendTyping();
    typingTimeoutRef.current = setTimeout(() => {}, 2000);
  };

  if (!channelId) {
    return (
      <div className={styles.empty}>
        <p>Select a channel</p>
      </div>
    );
  }

  const name = channel?.name || "channel";
  const grouped = [];
  for (const m of messages) {
    const last = grouped[grouped.length - 1];
    const prev = last?.[0];
    const sameAuthor = prev && prev.author_id === m.author_id;
    const timeOk = prev && new Date(m.created_at) - new Date(prev.created_at) < GROUP_THRESHOLD_MS;
    if (sameAuthor && timeOk && last) {
      last.push(m);
    } else {
      grouped.push([m]);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.channelHeader}>
        <span className={styles.channelName}># {name}</span>
      </div>
      <div
        ref={listRef}
        className={styles.messageList}
        onScroll={handleScroll}
      >
        {loading && <div className={styles.loading}>Loading...</div>}
        {!loading && (
          <>
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => messages.length && loadMessages(messages[0]?.id)}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load older messages"}
            </button>
            {grouped.map((group) => (
              <MessageGroup
                key={group[0].id}
                messages={group}
                currentUserId={currentUserId}
                baseUrl={baseUrl}
                onMentionClick={handleMentionClick}
              />
            ))}
            {typing.length > 0 && (
              <div className={styles.typing}>
                {typing.map((t) => t.user?.display_name).filter(Boolean).join(", ")} typing...
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      {channel?.type !== "voice" && (
        <div className={styles.inputWrap}>
          {showGifSearch && (
            <div className={styles.gifSearchPanel}>
              <div className={styles.gifSearchInputRow}>
                <input
                  type="text"
                  className={styles.gifSearchInput}
                  placeholder="Search GIFs..."
                  value={gifQuery}
                  onChange={(e) => setGifQuery(e.target.value)}
                  autoFocus
                />
                <button type="button" className={styles.gifSearchClose} onClick={() => { setShowGifSearch(false); setGifQuery(""); setGifResults({ data: [], pagination: {} }); }} aria-label="Close GIF search">
                  ×
                </button>
              </div>
              <div className={styles.gifResultsWrap}>
                {gifSearching && gifResults.data.length === 0 && <span className={styles.gifSearchStatus}>Searching...</span>}
                {!gifSearching && gifQuery.trim() && gifResults.data.length === 0 && <span className={styles.gifSearchStatus}>No GIFs found</span>}
                {gifResults.data.length > 0 && (
                  <div className={styles.gifResultsRow}>
                    {gifResults.data.map((gif) => {
                      const src = gif.images?.fixed_height?.webp || gif.images?.fixed_height?.url || gif.images?.original?.url;
                      return (
                        <button
                          key={gif.id}
                          type="button"
                          className={styles.gifThumb}
                          onClick={() => addPendingGif(gif)}
                          aria-label="Add GIF"
                        >
                          <img src={src} alt={gif.title || "GIF"} loading="lazy" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {pendingAttachments.length > 0 && (
            <div className={styles.pendingAttachments}>
              {pendingAttachments.map((a, i) => (
                <div key={i} className={styles.pendingThumb}>
                  <img src={a.previewUrl || a.url} alt="" />
                  <button type="button" className={styles.removeThumb} onClick={() => removePendingAttachment(i)} aria-label="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {uploadError && <span className={styles.charErr}>{uploadError}</span>}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className={styles.hiddenInput}
            onChange={(e) => {
              addPendingFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className={styles.inputRow}>
            <div
              className={styles.attachWrap}
              ref={attachMenuRef}
              onMouseEnter={() => {
                if (attachMenuCloseTimeoutRef.current) {
                  clearTimeout(attachMenuCloseTimeoutRef.current);
                  attachMenuCloseTimeoutRef.current = null;
                }
                setShowAttachMenu(true);
              }}
              onMouseLeave={() => {
                attachMenuCloseTimeoutRef.current = setTimeout(() => setShowAttachMenu(false), 150);
              }}
            >
              <button
                type="button"
                className={styles.attachBtn}
                title="Attach"
                aria-label="Attach"
                aria-expanded={showAttachMenu}
              >
                +
              </button>
              {showAttachMenu && (
                <div
                  className={styles.attachMenu}
                  onMouseEnter={() => {
                    if (attachMenuCloseTimeoutRef.current) {
                      clearTimeout(attachMenuCloseTimeoutRef.current);
                      attachMenuCloseTimeoutRef.current = null;
                    }
                  }}
                >
                  <button
                    type="button"
                    className={styles.attachMenuItem}
                    onClick={() => { fileInputRef.current?.click(); setShowAttachMenu(false); }}
                  >
                    Attach file/image
                  </button>
                  <button
                    type="button"
                    className={styles.attachMenuItem}
                    onClick={() => { setShowGifSearch(true); setShowAttachMenu(false); }}
                  >
                    GIF search
                  </button>
                </div>
              )}
            </div>
            <div className={styles.inputWithSuggestions}>
              <textarea
                ref={messageInputRef}
                className={styles.input}
                placeholder={`Message #${name}`}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
                maxLength={3000}
              />
              {showMentionSuggestions && mentionSuggestionsFiltered.length > 0 && (
                <div className={styles.mentionSuggestions}>
                  {mentionSuggestionsFiltered.map((u, i) => (
                    <button
                      key={u.id}
                      type="button"
                      className={`${styles.mentionSuggestionItem} ${i === mentionSelectedIndex ? styles.mentionSuggestionActive : ""}`}
                      onClick={() => applyMentionSuggestion(u)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span className={styles.mentionSuggestionAvatar}>{u.avatar_emoji || "🐱"}</span>
                      <span className={styles.mentionSuggestionName}>{u.display_name || u.username || "User"}</span>
                      <span className={styles.mentionSuggestionUsername}>@{u.username || u.display_name || ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {input.length >= 2800 && (
            <span className={input.length >= 3000 ? styles.charErr : styles.charWarn}>
              {input.length}/3000
            </span>
          )}
        </div>
      )}
    </div>
  );
}
