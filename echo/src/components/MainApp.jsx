import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useAuth } from "../hooks/useAuth";
import { createApi } from "../api/client";
import ServerSidebar from "./ServerSidebar";
import ChannelSidebar from "./ChannelSidebar";
import MessageArea from "./MessageArea";
import MembersSidebar from "./MembersSidebar";
import VoiceBar from "./VoiceBar";
import Modals from "./Modals";
import { useWebSocket } from "../hooks/useWebSocket";
import { useWebRTC } from "../hooks/useWebRTC";
import styles from "./MainApp.module.css";

function VideoSlot({ stream, label, muted, onSelect }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  if (!stream) return null;
  return (
    <div className={styles.videoSlot} onClick={() => onSelect?.()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect?.()}>
      <video ref={videoRef} autoPlay playsInline muted={muted} className={styles.videoElement} />
      {label && <span className={styles.videoLabel}>{label}</span>}
    </div>
  );
}

function FocusedVideoView({ stream, label, onBack, onFullscreen, containerRef }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  if (!stream) return null;
  return (
    <div className={styles.focusedVideoWrap}>
      <div className={styles.focusedVideoContainer} ref={containerRef}>
        <video ref={videoRef} autoPlay playsInline className={styles.videoElement} />
        {label && <span className={styles.videoLabel}>{label}</span>}
        <button type="button" className={styles.focusedVideoBack} onClick={onBack} aria-label="Back to chat">Back</button>
        <button type="button" className={styles.focusedVideoFullscreen} onClick={onFullscreen} aria-label="Fullscreen">&#x2922;</button>
      </div>
    </div>
  );
}

export default function MainApp({ user, onLogout, onProfileSaved }) {
  const { token, serverUrl } = useAuth();
  const baseUrl = serverUrl ? (serverUrl.startsWith("http") ? serverUrl : `http://${serverUrl}`).replace(/\/$/, "") : "";
  const api = useMemo(() => createApi(baseUrl, token), [baseUrl, token]);

  const [servers, setServers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [lastViewedChannelByServer, setLastViewedChannelByServer] = useState({});
  const lastViewedChannelByServerRef = useRef(lastViewedChannelByServer);
  lastViewedChannelByServerRef.current = lastViewedChannelByServer;
  const channelsBelongToServerRef = useRef(null);
  const [dmList, setDmList] = useState([]);
  const [view, setView] = useState("servers");
  const [unread, setUnread] = useState({});
  const [unreadByServer, setUnreadByServer] = useState({});
  const [modal, setModal] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [cameraOn, setCameraOn] = useState(false);
  const syncRetryDoneRef = useRef(false);
  const focusedVideoContainerRef = useRef(null);
  const videoPanelInnerRef = useRef(null);
  const videoPanelWheelLockRef = useRef(0);
  const peerVideoStreamCacheRef = useRef(Object.create(null));
  const [focusedVideoKey, setFocusedVideoKey] = useState(null);
  const [videoPanelOverflowing, setVideoPanelOverflowing] = useState(false);
  const [activeVoiceTimers, setActiveVoiceTimers] = useState({});
  const [activeVoiceUsers, setActiveVoiceUsers] = useState({});
  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);

  const ws = useWebSocket(baseUrl.replace(/^http/, "ws"), token);
  const webrtc = useWebRTC(baseUrl, token, api, () => {
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const tasks = [loadServers(), loadDMs()];
    if (view === "servers" && selectedServerId) {
      tasks.push(loadChannels(selectedServerId), loadMembers(selectedServerId), refreshVoiceActive());
    }
    Promise.allSettled(tasks).finally(() => {
      refreshInFlightRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        setTimeout(() => {
          if (!refreshInFlightRef.current) {
            refreshInFlightRef.current = true;
            const pendingTasks = [loadServers(), loadDMs()];
            if (view === "servers" && selectedServerId) {
              pendingTasks.push(loadChannels(selectedServerId), loadMembers(selectedServerId), refreshVoiceActive());
            }
            Promise.allSettled(pendingTasks).finally(() => {
              refreshInFlightRef.current = false;
            });
          }
        }, 0);
      }
    });
  });
  const webrtcRef = useRef(webrtc);
  webrtcRef.current = webrtc;

  useEffect(() => {
    let unlisten;
    getCurrentWindow()
      .onCloseRequested(() => {
        const { currentChannelId, leaveVoice } = webrtcRef.current;
        if (currentChannelId) leaveVoice().catch(() => {});
      })
      .then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const loadServers = useCallback(async () => {
    if (!api) return;
    try {
      const list = await api.getServers();
      setServers(list);
      if (list.length && !selectedServerId) setSelectedServerId(list[0].id);
    } catch (_) {}
  }, [selectedServerId, api]);

  const loadChannels = useCallback(async (serverId) => {
    if (!serverId || !api) return;
    try {
      const list = await api.getChannels(serverId);
      setChannels(list);
      channelsBelongToServerRef.current = serverId;
      const textChannels = list.filter((c) => c.type === "text");
      const firstText = textChannels[0];
      if (firstText) {
        const preferredId = lastViewedChannelByServerRef.current[serverId];
        const preferred = list.find((c) => c.id === preferredId && c.type === "text");
        setSelectedChannelId(preferred ? preferred.id : firstText.id);
      } else {
        setSelectedChannelId(null);
      }
    } catch (_) {}
  }, [api]);

  const loadMembers = useCallback(async (serverId) => {
    if (!serverId || !api) return;
    try {
      const list = await api.getMembers(serverId);
      setMembers(list);
    } catch (_) {}
  }, [api]);

  const loadDMs = useCallback(async () => {
    if (!api) return;
    try {
      const list = await api.getDMs();
      setDmList(list);
    } catch (_) {}
  }, [api]);

  useEffect(() => {
    if (!api) return;
    syncRetryDoneRef.current = false;
    const t1 = setTimeout(() => {
      loadServers();
      loadDMs();
    }, 200);
    const t2 = setTimeout(() => {
      if (syncRetryDoneRef.current) return;
      syncRetryDoneRef.current = true;
      loadServers();
      loadDMs();
    }, 1000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [api, loadServers, loadDMs]);

  useEffect(() => {
    if (selectedServerId) {
      loadChannels(selectedServerId);
      loadMembers(selectedServerId);
    } else {
      channelsBelongToServerRef.current = null;
      setChannels([]);
      setMembers([]);
    }
  }, [selectedServerId, loadChannels, loadMembers]);

  useEffect(() => {
    if (selectedServerId && ws.connected && channels.some((c) => c.id === selectedChannelId)) {
      loadMembers(selectedServerId);
    }
  }, [ws.connected, selectedServerId, selectedChannelId, channels, loadMembers]);

  useEffect(() => {
    if (view !== "servers" || !selectedServerId || !api) return;
    const poll = () => {
      api.getMembers(selectedServerId).then(setMembers).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [view, selectedServerId, api]);

  useEffect(() => {
    if (view === "servers" && selectedServerId && selectedChannelId && channelsBelongToServerRef.current === selectedServerId) {
      const ch = channels.find((c) => c.id === selectedChannelId && c.type === "text");
      if (ch) {
        setLastViewedChannelByServer((prev) => ({ ...prev, [selectedServerId]: selectedChannelId }));
      }
    }
  }, [view, selectedServerId, selectedChannelId, channels]);

  const currentChannel = channels.find((c) => c.id === selectedChannelId) || dmList.find((d) => d.id === selectedChannelId);
  const showVoiceBar = webrtc.isInVoice;
  const voiceChannelName = webrtc.currentChannelId && (channels.find((c) => c.id === webrtc.currentChannelId)?.name || "Voice");

  useEffect(() => {
    if (cameraOn && webrtc.localStream) webrtc.setCameraEnabled?.(true);
  }, [cameraOn, webrtc.localStream]);

  useEffect(() => {
    if (!webrtc.isInVoice) setCameraOn(false);
  }, [webrtc.isInVoice]);

  useEffect(() => {
    if (!cameraOn && !webrtc.isScreensharing) setFocusedVideoKey(null);
  }, [cameraOn, webrtc.isScreensharing]);

  const refreshVoiceActive = useCallback(() => {
    if (view !== "servers" || !selectedServerId || !api) return;
    api.getVoiceActive(selectedServerId).then((list) => {
      const timers = {};
      const users = {};
      (list || []).forEach(({ channel_id, started_at, users: u }) => {
        if (channel_id) {
          if (started_at) timers[channel_id] = started_at;
          if (Array.isArray(u) && u.length) users[channel_id] = u;
        }
      });
      setActiveVoiceTimers(timers);
      setActiveVoiceUsers(users);
    }).catch(() => {
      setActiveVoiceTimers({});
      setActiveVoiceUsers({});
    });
  }, [view, selectedServerId, api]);

  const refreshUiState = useCallback(() => {
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const tasks = [loadServers(), loadDMs()];
    if (view === "servers" && selectedServerId) {
      tasks.push(loadChannels(selectedServerId), loadMembers(selectedServerId), refreshVoiceActive());
    }
    Promise.allSettled(tasks).finally(() => {
      refreshInFlightRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        setTimeout(refreshUiState, 0);
      }
    });
  }, [view, selectedServerId, loadServers, loadDMs, loadChannels, loadMembers, refreshVoiceActive]);

  useEffect(() => {
    if (view !== "servers" || !selectedServerId || !api) return;
    refreshVoiceActive();
    const id = setInterval(refreshVoiceActive, 2500);
    return () => clearInterval(id);
  }, [view, selectedServerId, api, refreshVoiceActive]);

  useEffect(() => {
    if (!api) return;
    const id = setInterval(refreshUiState, 1500);
    return () => clearInterval(id);
  }, [api, refreshUiState]);

  useEffect(() => {
    if (!focusedVideoKey) return;
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      if (document.fullscreenElement === focusedVideoContainerRef.current) {
        document.exitFullscreen?.();
      } else {
        setFocusedVideoKey(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedVideoKey]);

  useEffect(() => {
    const el = videoPanelInnerRef.current;
    if (!el) {
      setVideoPanelOverflowing(false);
      return;
    }

    const updateOverflowState = () => {
      const isOverflowing = el.scrollWidth > el.clientWidth + 1;
      setVideoPanelOverflowing((prev) => (prev === isOverflowing ? prev : isOverflowing));
      if (!isOverflowing && el.scrollLeft !== 0) {
        el.scrollLeft = 0;
      }
    };

    updateOverflowState();

    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(el);
    Array.from(el.children).forEach((child) => resizeObserver.observe(child));

    return () => resizeObserver.disconnect();
  });

  const scrollVideoPanelByFeed = useCallback((direction) => {
    const el = videoPanelInnerRef.current;
    if (!el) return;

    const children = Array.from(el.children);
    if (!children.length) return;

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 0) {
      el.scrollTo({ left: 0, behavior: "smooth" });
      return;
    }

    const firstChildLeft = children[0].offsetLeft;
    const viewportLeft = el.scrollLeft;
    const viewportRight = viewportLeft + el.clientWidth;
    const epsilon = 2;

    const childMetrics = children.map((child, index) => {
      const left = child.offsetLeft - firstChildLeft;
      const right = left + child.offsetWidth;
      const fullyVisible = left >= viewportLeft - epsilon && right <= viewportRight + epsilon;
      return { index, left, right, fullyVisible };
    });

    let currentIndex = childMetrics.find((m) => m.fullyVisible)?.index;
    if (currentIndex == null) {
      currentIndex = childMetrics.reduce((closest, metric) => (
        Math.abs(metric.left - viewportLeft) < Math.abs(childMetrics[closest].left - viewportLeft) ? metric.index : closest
      ), 0);
    }

    const targetIndex = direction > 0
      ? (currentIndex + 1) % childMetrics.length
      : (currentIndex - 1 + childMetrics.length) % childMetrics.length;

    const targetLeft = Math.max(0, Math.min(childMetrics[targetIndex].left, maxScrollLeft));
    el.scrollTo({ left: targetLeft, behavior: "smooth" });
  }, []);

  const handleVideoPanelWheel = useCallback((event) => {
    const now = Date.now();
    if (now < videoPanelWheelLockRef.current) return;
    if (Math.abs(event.deltaY) < 1) return;

    const el = videoPanelInnerRef.current;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 0) return;

    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    scrollVideoPanelByFeed(direction);
    videoPanelWheelLockRef.current = now + 180;
  }, [scrollVideoPanelByFeed]);

  const [showWindowControls, setShowWindowControls] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      setShowWindowControls(false);
      return;
    }
    const win = window;
    const hasTauriGlobals =
      typeof win.__TAURI__ === "object" ||
      typeof win.__TAURI_METADATA__ === "object" ||
      typeof win.__TAURI_INTERNALS__ === "object";
    setShowWindowControls(hasTauriGlobals);
  }, []);

  const handleMinimize = async () => {
    try {
      const w = getCurrentWindow();
      await w.minimize();
    } catch (e) {
      if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) console.error(e);
    }
  };
  const handleMaximize = async () => {
    try {
      const w = getCurrentWindow();
      await w.toggleMaximize();
    } catch (e) {
      if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) console.error(e);
    }
  };
  const handleClose = async () => {
    try {
      const w = getCurrentWindow();
      await w.close();
    } catch (_) {}
    try {
      await exit(0);
    } catch (_) {}
  };

  return (
    <div className={styles.layout}>
      <header className={styles.titlebar} data-tauri-drag-region>
        <div className={styles.titlebarLeft}>
          <span className={styles.logo}>Echo</span>
          <span className={styles.windowTitle}>
            {view === "dms" ? "Direct Messages" : currentChannel ? `# ${currentChannel.name}` : "Echo"}
          </span>
        </div>
        <div className={styles.titlebarRight}>
          {showWindowControls && (
            <>
              <button type="button" className={styles.titlebarBtn} onClick={handleMinimize} aria-label="Minimize">&#x2013;</button>
              <button type="button" className={styles.titlebarBtn} onClick={handleMaximize} aria-label="Maximize">&#x25A1;</button>
              <button type="button" className={styles.titlebarBtnClose} onClick={handleClose} aria-label="Close">&#x2715;</button>
            </>
          )}
        </div>
      </header>

      <aside className={styles.serverSidebar}>
        <ServerSidebar
          servers={servers}
          selectedServerId={selectedServerId}
          onSelectServer={(id) => {
            setSelectedServerId(id);
            if (id) setUnreadByServer((s) => ({ ...s, [id]: 0 }));
          }}
          unread={unread}
          unreadByServer={unreadByServer}
          view={view}
          onViewChange={setView}
          onOpenModal={setModal}
          onModalData={setModalData}
          onServersChange={loadServers}
        />
      </aside>

      <aside className={styles.channelSidebar}>
        <ChannelSidebar
          view={view}
          serverName={servers.find((s) => s.id === selectedServerId)?.name}
          channels={channels}
          selectedChannelId={selectedChannelId}
          selectedServerId={selectedServerId}
          onSelectChannel={setSelectedChannelId}
          dmList={dmList}
          user={user}
          members={members}
          api={api}
          onOpenModal={setModal}
          onModalData={(data) => setModalData({ ...data, serverId: selectedServerId, serverName: servers.find((s) => s.id === selectedServerId)?.name, user })}
          onChannelsChange={() => selectedServerId && loadChannels(selectedServerId)}
          onDmSelect={(dmId) => {
            setView("dms");
            setSelectedChannelId(dmId);
          }}
          webrtc={webrtc}
          currentVoiceChannelId={webrtc.currentChannelId}
          activeVoiceTimers={activeVoiceTimers}
          activeVoiceUsers={activeVoiceUsers}
          onRefreshVoiceActive={refreshVoiceActive}
          onVoiceUserAction={(channelId, targetUser, action) => {
            if (action === "disconnect" && api && targetUser?.id) {
              api.disconnectVoiceUser(channelId, targetUser.id).catch(() => {});
            }
            if (action === "serverMute" && api && targetUser?.id) {
              const next = !(targetUser.is_muted || targetUser.muted || targetUser.server_muted);
              api.muteVoiceUser(channelId, targetUser.id, next).then(refreshVoiceActive).catch(() => {});
            }
            if (action === "serverDeafen" && api && targetUser?.id) {
              const next = !(targetUser.is_deafened || targetUser.deafened || targetUser.server_deafened);
              api.deafenVoiceUser(channelId, targetUser.id, next).then(refreshVoiceActive).catch(() => {});
            }
          }}
        />
      </aside>

      <main className={styles.main}>
        {(() => {
          const videoEntries = [];
          if (cameraOn && webrtc.localStream && webrtc.hasVideoSource) {
            videoEntries.push({
              key: "local-cam",
              stream: webrtc.localStream,
              label: `${user?.display_name || "You"} (camera)`,
              muted: true,
            });
          }
          if (webrtc.localScreenStream) {
            videoEntries.push({
              key: "local-screen",
              stream: webrtc.localScreenStream,
              label: `${user?.display_name || "You"} (screen)`,
              muted: true,
            });
          }
          (webrtc.peers || []).forEach((p) => {
            if (p.stream && p.stream.getVideoTracks().length > 0) {
              const cache = peerVideoStreamCacheRef.current;
              p.stream.getVideoTracks()
                .filter((track) => track.readyState === "live")
                .forEach((track, i) => {
                const key = `${p.userId}-${track.id || i}`;
                let stream = cache[key];
                if (!stream || !stream.getTracks().includes(track)) {
                  stream = new MediaStream([track]);
                  cache[key] = stream;
                }
                videoEntries.push({
                  key,
                  stream,
                  label: p.displayName || "User",
                  muted: false,
                });
              });
            }
          });
          const currentKeys = new Set(videoEntries.map((e) => e.key));
          const cache = peerVideoStreamCacheRef.current;
          for (const k of Object.keys(cache)) {
            if (!currentKeys.has(k)) delete cache[k];
          }

          const hasVideo = videoEntries.length > 0;
          const focusedEntry = focusedVideoKey ? videoEntries.find((e) => e.key === focusedVideoKey) : null;
          const showFocusedView = hasVideo && focusedEntry;

          const handleFullscreen = () => {
            const el = focusedVideoContainerRef.current;
            if (!el) return;
            if (document.fullscreenElement === el) {
              document.exitFullscreen?.();
            } else {
              el.requestFullscreen?.();
            }
          };

          return (
            <>
              {showFocusedView ? (
                <FocusedVideoView
                  stream={focusedEntry.stream}
                  label={focusedEntry.label}
                  onBack={() => setFocusedVideoKey(null)}
                  onFullscreen={handleFullscreen}
                  containerRef={focusedVideoContainerRef}
                />
              ) : (
                <>
                  <div className={styles.mainContent}>
                    <MessageArea
          channel={currentChannel}
          channelId={selectedChannelId}
          user={user}
          baseUrl={baseUrl}
          token={token}
          api={api}
          ws={ws}
          onUnreadClear={() => selectedChannelId && setUnread((u) => ({ ...u, [selectedChannelId]: 0 }))}
          onMessageReceived={(data) => {
            if (data.channel_id !== selectedChannelId) {
              setUnread((u) => ({ ...u, [data.channel_id]: (u[data.channel_id] || 0) + 1 }));
              if (data.server_id) {
                setUnreadByServer((s) => ({ ...s, [data.server_id]: (s[data.server_id] || 0) + 1 }));
              }
            }
          }}
          onMembersRefresh={selectedServerId ? () => loadMembers(selectedServerId) : undefined}
          onActivity={refreshUiState}
        />
                  </div>
                  {hasVideo && (
          <div className={styles.videoPanel} aria-label="Video streams">
            <button
              type="button"
              className={styles.videoPanelScrollBtn}
              aria-label="Scroll video feeds left"
              onClick={() => scrollVideoPanelByFeed(-1)}
            >
              &#x2039;
            </button>
            <div
              ref={videoPanelInnerRef}
              className={`${styles.videoPanelInner} ${videoPanelOverflowing ? styles.videoPanelInnerOverflowing : ""}`}
              onWheel={handleVideoPanelWheel}
            >
              {videoEntries.map((e) => (
                <VideoSlot
                  key={e.key}
                  stream={e.stream}
                  label={e.label}
                  muted={e.muted}
                  onSelect={() => setFocusedVideoKey(e.key)}
                />
              ))}
            </div>
            <button
              type="button"
              className={styles.videoPanelScrollBtnRight}
              aria-label="Scroll video feeds right"
              onClick={() => scrollVideoPanelByFeed(1)}
            >
              &#x203A;
            </button>
          </div>
                  )}
                </>
              )}
            </>
          );
        })()}
        {showVoiceBar && (
          <div className={styles.voiceBarWrap}>
          <VoiceBar
            channelName={voiceChannelName}
            user={user}
            webrtc={webrtc}
            cameraOn={cameraOn}
            onRefreshVoiceActive={refreshVoiceActive}
            onCameraToggle={() => {
              setCameraOn((c) => {
                const next = !c;
                webrtc.setCameraEnabled?.(next);
                return next;
              });
            }}
          />
          </div>
        )}
      </main>

      <aside className={styles.membersSidebar}>
        <MembersSidebar
          members={members}
          serverId={selectedServerId}
          onOpenDM={async (userId) => {
            if (!api) return;
            const ch = await api.openDM(userId);
            setDmList((prev) => {
              const other = members.find((m) => m.id === userId);
              if (prev.some((d) => d.other_user?.id === userId)) return prev;
              return [{ id: ch.id, other_user: other || { id: userId, display_name: "User" } }, ...prev];
            });
            setSelectedChannelId(ch.id);
            setView("dms");
          }}
          onOpenModal={setModal}
        />
      </aside>

      <Modals
        api={api}
        baseUrl={baseUrl}
        user={user}
        modal={modal}
        modalData={modalData}
        onClose={() => { setModal(null); setModalData(null); }}
        onServerCreated={loadServers}
        onServerDeleted={() => {
          loadServers();
          setSelectedServerId(null);
          setSelectedChannelId(null);
          setChannels([]);
          setMembers([]);
        }}
        onServerRenamed={loadServers}
        onChannelCreated={(serverId) => serverId && loadChannels(serverId)}
        onJoinServer={loadServers}
        onProfileSaved={onProfileSaved}
        onDmCreated={loadDMs}
        onOpenDMChannel={(channelId) => {
          setSelectedChannelId(channelId);
          setView("dms");
          loadDMs();
        }}
      />
    </div>
  );
}
