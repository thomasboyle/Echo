import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./MessageArea.module.css";
import { debouncedSearchGifs, gifToAttachment } from "../api/giphy";

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

function MessageGroup({ messages, currentUserId, baseUrl }) {
  const first = messages[0];
  const author = first?.author || {};
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
            {m.content && <span>{m.content}</span>}
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
  onUnreadClear,
  onMessageReceived,
  onMembersRefresh,
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
  const attachMenuRef = useRef(null);
  const attachMenuCloseTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const [scrollAtBottom, setScrollAtBottom] = useState(true);
  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const scrollAtBottomRef = useRef(scrollAtBottom);
  scrollAtBottomRef.current = scrollAtBottom;

  const currentUserId = user?.id;
  const onMessageReceivedRef = useRef(onMessageReceived);
  const onMembersRefreshRef = useRef(onMembersRefresh);
  onMessageReceivedRef.current = onMessageReceived;
  onMembersRefreshRef.current = onMembersRefresh;

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
      loadMessages();
    } else {
      setMessages([]);
    }
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
        if (scrollAtBottomRef.current && listRef.current) {
          requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
        }
        if (user && data.content && data.content.includes(user.display_name)) {
          invoke("show_notification", { title: "Mention", body: `${data.author?.display_name}: ${data.content.slice(0, 50)}...` }).catch(() => {});
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
      onUserJoin: () => onMembersRefreshRef.current?.(),
      onUserLeave: () => onMembersRefreshRef.current?.(),
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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
            <textarea
              className={styles.input}
              placeholder={`Message #${name}`}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                sendTyping();
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              maxLength={3000}
            />
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
