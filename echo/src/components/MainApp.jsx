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
import NavigationBar from "./NavigationBar";
import ServersView from "./views/ServersView";
import ServerSplitView from "./views/ServerSplitView";
import DMsSplitView from "./views/DMsSplitView";
import ChatView from "./views/ChatView";
import SettingsModal from "./SettingsModal";
import { useWebSocket, useNotificationsWebSocket } from "../hooks/useWebSocket";
import { useWebRTC } from "../hooks/useWebRTC";

import styles from "./MainApp.module.css";

const MENTION_RE = /@([\w-]+)(?=\s|$)/g;
function getMentionedUsernames(content) {
  const set = new Set();
  if (typeof content !== "string" || content.indexOf('@') === -1) return set;
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(content)) !== null) set.add(m[1].toLowerCase());
  return set;
}

function useStableCallback(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args) => ref.current(...args), []);
}

function VideoSlot({ stream, label, muted, onSelect }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    return () => { el.srcObject = null; };
  }, [stream]);
  if (!stream) return null;
  return (
    <div className={styles.videoSlot} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect?.()}>
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
    return () => { el.srcObject = null; };
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
  const baseUrl = useMemo(() => serverUrl ? (serverUrl.startsWith("http") ? serverUrl : `http://${serverUrl}`).replace(/\/$/, "") : "", [serverUrl]);
  const api = useMemo(() => createApi(baseUrl, token), [baseUrl, token]);

  const [servers, setServers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  
  const [lastViewedChannelByServer, setLastViewedChannelByServer] = useState({});
  const lastViewedChannelByServerRef = useRef(lastViewedChannelByServer);
  lastViewedChannelByServerRef.current = lastViewedChannelByServer;
  
  const [lastViewedDmId, setLastViewedDmId] = useState(null);
  const lastViewedDmIdRef = useRef(lastViewedDmId);
  lastViewedDmIdRef.current = lastViewedDmId;
  
  const channelsBelongToServerRef = useRef(null);
  const channelsByServerRef = useRef({});
  const channelsRequestVersionRef = useRef({});
  const membersByServerRef = useRef({});
  const membersRequestVersionRef = useRef({});
  
  const [dmList, setDmList] = useState([]);
  const [view, setView] = useState("servers");
  const [unread, setUnread] = useState({});
  const [unreadByServer, setUnreadByServer] = useState({});
  const [mentionByChannel, setMentionByChannel] = useState({});
  const [mentionByServer, setMentionByServer] = useState({});
  
  const mentionByChannelRef = useRef(mentionByChannel);
  mentionByChannelRef.current = mentionByChannel;
  const selectedChannelIdRef = useRef(selectedChannelId);
  const selectedServerIdRef = useRef(selectedServerId);
  const viewRef = useRef(view);
  selectedChannelIdRef.current = selectedChannelId;
  selectedServerIdRef.current = selectedServerId;
  viewRef.current = view;

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
  const isMountedRef = useRef(true);
  const pendingRefreshTimeoutRef = useRef(null);
  const refreshRetryTimeoutRef = useRef(null);
  const explicitServerListRef = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (pendingRefreshTimeoutRef.current) {
        clearTimeout(pendingRefreshTimeoutRef.current);
        pendingRefreshTimeoutRef.current = null;
      }
      if (refreshRetryTimeoutRef.current) {
        clearTimeout(refreshRetryTimeoutRef.current);
        refreshRetryTimeoutRef.current = null;
      }
    };
  }, []);

  const loadServers = useStableCallback(async () => {
    if (!api) return;
    try {
      const list = await api.getServers();
      setServers(list);
      if (list.length && !selectedServerIdRef.current && !explicitServerListRef.current) {
        setSelectedServerId(list[0].id);
      }
    } catch (_) {}
  });

  const loadChannels = useStableCallback(async (serverId) => {
    if (!serverId || !api) return;
    const nextVersion = (channelsRequestVersionRef.current[serverId] || 0) + 1;
    channelsRequestVersionRef.current[serverId] = nextVersion;
    try {
      const list = await api.getChannels(serverId);
      if (channelsRequestVersionRef.current[serverId] !== nextVersion) return;
      channelsByServerRef.current[serverId] = list;
      if (selectedServerIdRef.current !== serverId || viewRef.current !== "servers") return;
      setChannels(list);
      channelsBelongToServerRef.current = serverId;
      
      let firstText;
      let preferred;
      let keepCurrent = false;
      const curId = selectedChannelIdRef.current;
      const preferredId = lastViewedChannelByServerRef.current[serverId];
      
      for (let i = 0, len = list.length; i < len; i++) {
        const c = list[i];
        if (c.type === "text") {
          if (!firstText) firstText = c;
          if (c.id === preferredId) preferred = c;
          if (c.id === curId) keepCurrent = true;
        }
      }
      
      if (firstText) {
        if (!keepCurrent) {
          setSelectedChannelId(preferred ? preferred.id : firstText.id);
        }
      } else {
        setSelectedChannelId(null);
      }
    } catch (_) {}
  });

  const loadMembers = useStableCallback(async (serverId, options = {}) => {
    const applyToUi = options.applyToUi !== false;
    if (!serverId || !api) return;
    const nextVersion = (membersRequestVersionRef.current[serverId] || 0) + 1;
    membersRequestVersionRef.current[serverId] = nextVersion;
    try {
      const list = await api.getMembers(serverId);
      if (membersRequestVersionRef.current[serverId] !== nextVersion) return;
      membersByServerRef.current[serverId] = list;
      if (applyToUi && selectedServerIdRef.current === serverId && viewRef.current === "servers") {
        setMembers(list);
      }
    } catch (_) {}
  });

  const loadDMs = useStableCallback(async () => {
    if (!api) return;
    try {
      const list = await api.getDMs();
      setDmList(list);
    } catch (_) {}
  });

  const refreshVoiceActive = useStableCallback(() => {
    const sid = selectedServerIdRef.current;
    if (viewRef.current !== "servers" || !sid || !api) return;
    api.getVoiceActive(sid).then((list) => {
      const timers = {};
      const users = {};
      if (list) {
        for (let i = 0, len = list.length; i < len; i++) {
          const item = list[i];
          const cid = item.channel_id;
          if (cid) {
            if (item.started_at) timers[cid] = item.started_at;
            const u = item.users;
            if (Array.isArray(u) && u.length) users[cid] = u;
          }
        }
      }
      setActiveVoiceTimers(timers);
      setActiveVoiceUsers(users);
    }).catch(() => {
      setActiveVoiceTimers({});
      setActiveVoiceUsers({});
    });
  });

  const ws = useWebSocket(baseUrl.replace(/^http/, "ws"), token);
  
  const notificationCallbackRef = useRef(null);
  notificationCallbackRef.current = (data) => {
    if (data?.type === "voice_presence") {
      if (
        data.server_id === selectedServerIdRef.current &&
        viewRef.current === "servers"
      ) {
        refreshVoiceActive();
      }
      return;
    }
    const cid = data.channel_id;
    const sid = data.server_id;
    if (cid === selectedChannelIdRef.current) return;
    setUnread((u) => ({ ...u, [cid]: (u[cid] || 0) + 1 }));
    if (sid) {
      setUnreadByServer((s) => ({ ...s, [sid]: (s[sid] || 0) + 1 }));
    }
    const uName = user?.username || user?.display_name;
    if (!uName) return;
    const myName = uName.toLowerCase();
    if (getMentionedUsernames(data.content).has(myName)) {
      setMentionByChannel((c) => ({ ...c, [cid]: (c[cid] || 0) + 1 }));
      if (sid) {
        setMentionByServer((s) => ({ ...s, [sid]: (s[sid] || 0) + 1 }));
      }
    }
  };
  useNotificationsWebSocket(baseUrl, token, notificationCallbackRef);

  const webrtcCallback = useStableCallback(() => {
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const tasks = [loadServers(), loadDMs()];
    const v = viewRef.current;
    const sid = selectedServerIdRef.current;
    if (v === "servers" && sid) {
      tasks.push(loadChannels(sid), loadMembers(sid), refreshVoiceActive());
    }
    Promise.allSettled(tasks).finally(() => {
      refreshInFlightRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        if (pendingRefreshTimeoutRef.current) clearTimeout(pendingRefreshTimeoutRef.current);
        pendingRefreshTimeoutRef.current = setTimeout(() => {
          pendingRefreshTimeoutRef.current = null;
          if (!isMountedRef.current) return;
          if (!refreshInFlightRef.current) {
            refreshInFlightRef.current = true;
            const pendingTasks = [loadServers(), loadDMs()];
            const pv = viewRef.current;
            const psid = selectedServerIdRef.current;
            if (pv === "servers" && psid) {
              pendingTasks.push(loadChannels(psid), loadMembers(psid), refreshVoiceActive());
            }
            Promise.allSettled(pendingTasks).finally(() => {
              refreshInFlightRef.current = false;
            });
          }
        }, 0);
      }
    });
  });

  const webrtc = useWebRTC(baseUrl, token, api, webrtcCallback);
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
      const cachedChannels = channelsByServerRef.current[selectedServerId];
      if (cachedChannels) {
        setChannels(cachedChannels);
        channelsBelongToServerRef.current = selectedServerId;
      } else {
        channelsBelongToServerRef.current = selectedServerId;
        setChannels((prev) => (prev.length ? [] : prev));
      }
      const cachedMembers = membersByServerRef.current[selectedServerId];
      if (cachedMembers) {
        setMembers(cachedMembers);
      } else {
        setMembers((prev) => (prev.length ? [] : prev));
      }
      loadChannels(selectedServerId);
      loadMembers(selectedServerId);
    } else {
      channelsBelongToServerRef.current = null;
      setChannels((prev) => (prev.length ? [] : prev));
      setMembers((prev) => (prev.length ? [] : prev));
    }
  }, [selectedServerId, loadChannels, loadMembers]);

  useEffect(() => {
    if (view !== "servers" || !selectedServerId || !api) return;
    if (!membersByServerRef.current[selectedServerId]) {
      loadMembers(selectedServerId);
    }
    const id = setInterval(() => loadMembers(selectedServerId), 5000);
    return () => clearInterval(id);
  }, [view, selectedServerId, api, loadMembers]);

  useEffect(() => {
    if (view === "servers" && selectedServerId && selectedChannelId && channelsBelongToServerRef.current === selectedServerId) {
      let found = false;
      for (let i = 0, len = channels.length; i < len; i++) {
        if (channels[i].id === selectedChannelId && channels[i].type === "text") {
          found = true; break;
        }
      }
      if (found) {
        setLastViewedChannelByServer((prev) => ({ ...prev, [selectedServerId]: selectedChannelId }));
      }
    }
  }, [view, selectedServerId, selectedChannelId, channels]);

  const currentChannel = useMemo(() => {
    for (let i = 0, len = channels.length; i < len; i++) {
      if (channels[i].id === selectedChannelId) return channels[i];
    }
    for (let i = 0, len = dmList.length; i < len; i++) {
      if (dmList[i].id === selectedChannelId) return dmList[i];
    }
    return undefined;
  }, [channels, dmList, selectedChannelId]);

  const showVoiceBar = webrtc.isInVoice;

  const mentionableUsers = useMemo(() => {
    const uid = user?.id;
    if (view === "servers") {
      if (!members || !members.length) return [];
      const out = [];
      for (let i = 0, len = members.length; i < len; i++) {
        if (members[i].id !== uid) out.push(members[i]);
      }
      return out;
    }
    if (!dmList || !dmList.length) return [];
    const out = [];
    for (let i = 0, len = dmList.length; i < len; i++) {
      const o = dmList[i].other_user;
      if (o) out.push(o);
    }
    return out;
  }, [view, members, dmList, user?.id]);

  const voiceChannelName = useMemo(() => {
    const vid = webrtc.currentChannelId;
    if (!vid) return "Voice";
    for (let i = 0, len = channels.length; i < len; i++) {
      if (channels[i].id === vid) return channels[i].name;
    }
    return "Voice";
  }, [webrtc.currentChannelId, channels]);

  const totalDmUnread = useMemo(() => {
    let sum = 0;
    for (let i = 0, len = dmList.length; i < len; i++) {
      const id = dmList[i].id;
      const u = unread[id];
      const m = mentionByChannel[id];
      if (u) sum += u;
      if (m) sum += m;
    }
    return sum;
  }, [dmList, unread, mentionByChannel]);

  useEffect(() => {
    if (cameraOn && webrtc.localStream) webrtc.setCameraEnabled?.(true);
  }, [cameraOn, webrtc.localStream]);

  useEffect(() => {
    if (!webrtc.isInVoice) setCameraOn(false);
  }, [webrtc.isInVoice]);

  useEffect(() => {
    if (!cameraOn && !webrtc.isScreensharing) setFocusedVideoKey(null);
  }, [cameraOn, webrtc.isScreensharing]);

  const refreshUiState = useStableCallback(() => {
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    const tasks = [loadServers(), loadDMs()];
    Promise.allSettled(tasks).finally(() => {
      refreshInFlightRef.current = false;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        if (refreshRetryTimeoutRef.current) clearTimeout(refreshRetryTimeoutRef.current);
        refreshRetryTimeoutRef.current = setTimeout(() => {
          refreshRetryTimeoutRef.current = null;
          if (!isMountedRef.current) return;
          refreshUiState();
        }, 0);
      }
    });
  });

  useEffect(() => {
    if (view !== "servers" || !selectedServerId || !api) return;
    refreshVoiceActive();
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

  const scrollVideoPanelByFeed = useStableCallback((direction) => {
    const el = videoPanelInnerRef.current;
    if (!el) return;
    const children = el.children;
    const len = children.length;
    if (len === 0) return;

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 0) {
      el.scrollTo({ left: 0, behavior: "smooth" });
      return;
    }

    const firstChildLeft = children[0].offsetLeft;
    const viewportLeft = el.scrollLeft;
    const viewportRight = viewportLeft + el.clientWidth;
    const epsilon = 2;
    
    let currentIndex = 0;
    let closestDist = Infinity;
    
    for (let i = 0; i < len; i++) {
        const child = children[i];
        const left = child.offsetLeft - firstChildLeft;
        const right = left + child.offsetWidth;
        if (left >= viewportLeft - epsilon && right <= viewportRight + epsilon) {
            currentIndex = i;
            break;
        }
        const dist = Math.abs(left - viewportLeft);
        if (dist < closestDist) {
            closestDist = dist;
            currentIndex = i;
        }
    }

    let targetIndex = currentIndex + direction;
    if (targetIndex < 0) targetIndex += len;
    else if (targetIndex >= len) targetIndex -= len;
    targetIndex = targetIndex % len;

    const targetLeft = Math.max(0, Math.min(children[targetIndex].offsetLeft - firstChildLeft, maxScrollLeft));
    el.scrollTo({ left: targetLeft, behavior: "smooth" });
  });

  const handleVideoPanelWheel = useStableCallback((event) => {
    const now = Date.now();
    if (now < videoPanelWheelLockRef.current) return;
    if (Math.abs(event.deltaY) < 1) return;

    const el = videoPanelInnerRef.current;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScrollLeft <= 0) return;

    event.preventDefault();
    scrollVideoPanelByFeed(event.deltaY > 0 ? 1 : -1);
    videoPanelWheelLockRef.current = now + 180;
  });

  const [showWindowControls, setShowWindowControls] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      setShowWindowControls(false);
      return;
    }
    const win = window;
    const hasTauriGlobals = typeof win.__TAURI__ === "object" ||
                            typeof win.__TAURI_METADATA__ === "object" ||
                            typeof win.__TAURI_INTERNALS__ === "object";
    setShowWindowControls(hasTauriGlobals);
  }, []);

  const handleMinimize = useStableCallback(async () => {
    try { await getCurrentWindow().minimize(); } catch (e) { if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) console.error(e); }
  });
  const handleMaximize = useStableCallback(async () => {
    try { await getCurrentWindow().toggleMaximize(); } catch (e) { if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) console.error(e); }
  });
  const handleClose = useStableCallback(async () => {
    try { await getCurrentWindow().close(); } catch (_) {}
    try { await exit(0); } catch (_) {}
  });

  const handleMentionClear = useStableCallback(() => {
    const cid = selectedChannelIdRef.current;
    const sid = selectedServerIdRef.current;
    if (!cid) return;
    const count = mentionByChannelRef.current[cid] || 0;
    setMentionByChannel((c) => ({ ...c, [cid]: 0 }));
    if (sid && count > 0) {
      setMentionByServer((s) => ({ ...s, [sid]: Math.max(0, (s[sid] || 0) - count) }));
    }
  });

  const handleSelectChannel = useStableCallback((id) => {
    setSelectedChannelId(id);
    if (viewRef.current === "dms") setLastViewedDmId(id);
  });

  const selectServerTextChannel = useStableCallback((serverId, list = []) => {
    let firstText;
    let preferred;
    let keepCurrent = false;
    const curId = selectedChannelIdRef.current;
    const preferredId = lastViewedChannelByServerRef.current[serverId];

    for (let i = 0, len = list.length; i < len; i++) {
      const c = list[i];
      if (c.type === "text") {
        if (!firstText) firstText = c;
        if (c.id === preferredId) preferred = c;
        if (c.id === curId) keepCurrent = true;
      }
    }

    if (!firstText) {
      setSelectedChannelId(null);
      return;
    }
    if (!keepCurrent) {
      setSelectedChannelId(preferred ? preferred.id : firstText.id);
    }
  });

  const handleBackToServerList = useStableCallback(() => {
    explicitServerListRef.current = true;
    setSelectedServerId(null);
    setSelectedChannelId(null);
  });

  const handleViewChange = useStableCallback((nextView) => {
    if (nextView === "dms") {
      const preferred = lastViewedDmIdRef.current;
      let found = false;
      if (preferred) {
        for (let i = 0, len = dmList.length; i < len; i++) {
          if (dmList[i].id === preferred) { found = true; break; }
        }
      }
      if (found) {
        setSelectedChannelId(preferred);
      } else if (dmList.length) {
        setSelectedChannelId(dmList[0].id);
      }
    } else if (nextView === "servers") {
      if (!explicitServerListRef.current) {
        const sid = selectedServerIdRef.current || (servers.length > 0 ? servers[0].id : null);
        if (sid) {
          if (!selectedServerIdRef.current) setSelectedServerId(sid);
          const activeList = channelsBelongToServerRef.current === sid ? channels : (channelsByServerRef.current[sid] || []);
          selectServerTextChannel(sid, activeList);
          loadChannels(sid);
        }
      }
    }
    setView(nextView);
  });

  const handleSelectServer = useStableCallback((id) => {
    explicitServerListRef.current = false;
    setSelectedServerId(id);
    setView("servers");
    if (id) {
      setUnreadByServer((s) => ({ ...s, [id]: 0 }));
      const cachedList = channelsBelongToServerRef.current === id ? channels : (channelsByServerRef.current[id] || []);
      selectServerTextChannel(id, cachedList);
    }
  });

  const handleDmSelect = useStableCallback((dmId) => {
    setView("dms");
    setLastViewedDmId(dmId);
    setSelectedChannelId(dmId);
  });

  const handleVoiceUserAction = useStableCallback((channelId, targetUser, action) => {
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
  });

  const handleModalDataSet = useStableCallback((data) => {
    const sid = selectedServerIdRef.current;
    let sname = null;
    for (let i = 0, len = servers.length; i < len; i++) {
      if (servers[i].id === sid) { sname = servers[i].name; break; }
    }
    setModalData({ ...data, serverId: sid, serverName: sname, user });
  });

  const openServerModal = useStableCallback((kind) => {
    const sid = selectedServerIdRef.current;
    let sname = null;
    let icon = "🌐";
    for (let i = 0, len = servers.length; i < len; i++) {
      if (servers[i].id === sid) {
        sname = servers[i].name;
        icon = servers[i].icon_emoji || "🌐";
        break;
      }
    }
    setModalData({ serverId: sid, serverName: sname, icon_emoji: icon, user });
    setModal(kind);
  });

  const handleChannelsChange = useStableCallback(() => {
    const sid = selectedServerIdRef.current;
    if (sid) loadChannels(sid);
  });

  const handleChannelUpdated = useStableCallback((ch) => {
    if (ch?.id) {
      setChannels((prev) => {
        const next = [...prev];
        for (let i = 0, len = next.length; i < len; i++) {
          if (next[i].id === ch.id) {
            next[i] = { ...next[i], ...ch };
            break;
          }
        }
        return next;
      });
    }
  });

  const handleOpenDM = useStableCallback(async (userId) => {
    if (!api) return;
    const ch = await api.openDM(userId);
    let other = null;
    if (members) {
      for (let i = 0, len = members.length; i < len; i++) {
        if (members[i].id === userId) { other = members[i]; break; }
      }
    }
    if (!other && dmList) {
      for (let i = 0, len = dmList.length; i < len; i++) {
        if (dmList[i].other_user?.id === userId) { other = dmList[i].other_user; break; }
      }
    }
    setDmList((prev) => {
      for (let i = 0, len = prev.length; i < len; i++) {
        if (prev[i].other_user?.id === userId) return prev;
      }
      return [{ id: ch.id, other_user: other || { id: userId, display_name: "User" } }, ...prev];
    });
    setLastViewedDmId(ch.id);
    setSelectedChannelId(ch.id);
    setView("dms");
  });

  const handleUnreadClear = useStableCallback(() => {
    const cid = selectedChannelIdRef.current;
    if (cid) setUnread((u) => ({ ...u, [cid]: 0 }));
  });

  const handleMessageReceived = useStableCallback((data) => {
    const { channel_id, server_id } = data;
    if (channel_id !== selectedChannelIdRef.current) {
      setUnread((u) => ({ ...u, [channel_id]: (u[channel_id] || 0) + 1 }));
      if (server_id) {
        setUnreadByServer((s) => ({ ...s, [server_id]: (s[server_id] || 0) + 1 }));
      }
    }
  });

  const handleMentionReceived = useStableCallback((data) => {
    const cid = data.channel_id;
    const sid = data.server_id;
    if (cid === selectedChannelIdRef.current) return;
    setMentionByChannel((c) => ({ ...c, [cid]: (c[cid] || 0) + 1 }));
    if (sid) {
      setMentionByServer((s) => ({ ...s, [sid]: (s[sid] || 0) + 1 }));
    }
  });

  const handleMembersRefresh = useStableCallback(() => {
    const sid = selectedServerIdRef.current;
    if (sid) loadMembers(sid);
  });

  const handleCameraToggle = useStableCallback(() => {
    setCameraOn((c) => {
      const next = !c;
      webrtcRef.current.setCameraEnabled?.(next);
      return next;
    });
  });

  const handleCloseModal = useStableCallback(() => {
    setModal(null);
    setModalData(null);
  });

  const handleServerDeleted = useStableCallback(() => {
    explicitServerListRef.current = false;
    loadServers();
    setSelectedServerId(null);
    setSelectedChannelId(null);
    setChannels([]);
    setMembers([]);
  });

  const handleChannelDeleted = useStableCallback((serverId, channelId) => {
    if (serverId) loadChannels(serverId);
    if (selectedChannelIdRef.current === channelId) setSelectedChannelId(null);
  });

  const handleOpenDMChannel = useStableCallback((channelId) => {
    setLastViewedDmId(channelId);
    setSelectedChannelId(channelId);
    setView("dms");
    loadDMs();
  });

  const videoEntries = useMemo(() => {
    const entries = [];
    if (cameraOn && webrtc.localStream && webrtc.hasVideoSource) {
      entries.push({
        key: "local-cam",
        stream: webrtc.localStream,
        label: (user?.display_name || "You") + " (camera)",
        muted: true,
      });
    }
    if (webrtc.localScreenStream) {
      entries.push({
        key: "local-screen",
        stream: webrtc.localScreenStream,
        label: (user?.display_name || "You") + " (screen)",
        muted: true,
      });
    }
    const peers = webrtc.peers;
    if (peers) {
      const cache = peerVideoStreamCacheRef.current;
      for (let i = 0, plen = peers.length; i < plen; i++) {
        const p = peers[i];
        if (p.stream && p.stream.getVideoTracks) {
          const tracks = p.stream.getVideoTracks();
          if (tracks.length > 0) {
            for (let j = 0, tlen = tracks.length; j < tlen; j++) {
              const track = tracks[j];
              if (track.readyState === "live") {
                const key = p.userId + "-" + (track.id || j);
                let stream = cache[key];
                if (!stream || !stream.getTracks().includes(track)) {
                  stream = new MediaStream([track]);
                  cache[key] = stream;
                }
                entries.push({
                  key,
                  stream,
                  label: p.displayName || "User",
                  muted: false,
                });
              }
            }
          }
        }
      }
    }
    return entries;
  }, [cameraOn, webrtc.localStream, webrtc.hasVideoSource, webrtc.localScreenStream, webrtc.peers, user]);

  useEffect(() => {
    const cache = peerVideoStreamCacheRef.current;
    const currentKeys = new Set();
    for (let i = 0, len = videoEntries.length; i < len; i++) currentKeys.add(videoEntries[i].key);
    const keys = Object.keys(cache);
    for (let i = 0, len = keys.length; i < len; i++) {
      if (!currentKeys.has(keys[i])) delete cache[keys[i]];
    }
  }, [videoEntries]);

  useEffect(() => {
    const el = videoPanelInnerRef.current;
    if (!el) {
      setVideoPanelOverflowing(false);
      return;
    }
    const updateOverflowState = () => {
      const isOverflowing = el.scrollWidth > el.clientWidth + 1;
      setVideoPanelOverflowing((prev) => (prev === isOverflowing ? prev : isOverflowing));
      if (!isOverflowing && el.scrollLeft !== 0) el.scrollLeft = 0;
    };
    updateOverflowState();
    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(el);
    const children = el.children;
    for (let i = 0, len = children.length; i < len; i++) resizeObserver.observe(children[i]);
    return () => resizeObserver.disconnect();
  }, [videoEntries]);

  useEffect(() => {
    if (view !== "dms") return;
    if (selectedChannelId) {
      for (let i = 0, len = dmList.length; i < len; i++) {
        if (dmList[i].id === selectedChannelId) {
          setLastViewedDmId(selectedChannelId);
          return;
        }
      }
    }
    const preferred = lastViewedDmIdRef.current || (dmList.length > 0 ? dmList[0].id : null);
    if (preferred) setSelectedChannelId(preferred);
  }, [view, selectedChannelId, dmList]);

  const hasVideo = videoEntries.length > 0;
  let focusedEntry = null;
  if (focusedVideoKey) {
    for (let i = 0, len = videoEntries.length; i < len; i++) {
      if (videoEntries[i].key === focusedVideoKey) { focusedEntry = videoEntries[i]; break; }
    }
  }
  const showFocusedView = hasVideo && focusedEntry;

  const handleFullscreen = useStableCallback(() => {
    const el = focusedVideoContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  });

  const handleFocusedVideoBack = useStableCallback(() => setFocusedVideoKey(null));
  
  const currentServerName = useMemo(() => {
    for (let i = 0, len = servers.length; i < len; i++) {
      if (servers[i].id === selectedServerId) return servers[i].name;
    }
    return undefined;
  }, [servers, selectedServerId]);

  const renderActiveView = () => {
    if (view === "settings") {
      return (
        <SettingsModal
          user={user}
          api={api}
          baseUrl={baseUrl}
          onClose={() => handleViewChange("servers")}
          onProfileSaved={onProfileSaved}
        />
      );
    }
    
    if (view === "dms") {
      return (
        <DMsSplitView 
          dmList={dmList}
          unread={unread}
          mentionByChannel={mentionByChannel}
          onDmSelect={handleDmSelect}
          onOpenModal={setModal}
          selectedChannelId={selectedChannelId}
          currentChannel={currentChannel}
          user={user}
          baseUrl={baseUrl}
          token={token}
          api={api}
          ws={ws}
          mentionableUsers={mentionableUsers}
          onOpenDM={handleOpenDM}
          onUnreadClear={handleUnreadClear}
          onMentionClear={handleMentionClear}
          onMessageReceived={handleMessageReceived}
          onMentionReceived={handleMentionReceived}
          onMembersRefresh={handleMembersRefresh}
          onActivity={refreshUiState}
          onCall={(channelId) => webrtc.joinVoice(channelId)}
        />
      );
    }

    if (view === "servers") {
      if (!selectedServerId) {
        return (
          <ServersView 
            servers={servers}
            unreadByServer={unreadByServer}
            mentionByServer={mentionByServer}
            onSelectServer={handleSelectServer}
            onOpenModal={setModal}
          />
        );
      }
      return (
        <ServerSplitView 
           serverName={currentServerName}
           channels={channels}
           unread={unread}
           mentionByChannel={mentionByChannel}
           onSelectChannel={handleSelectChannel}
           selectedChannelId={selectedChannelId}
           currentChannel={currentChannel}
           user={user}
           baseUrl={baseUrl}
           token={token}
           api={api}
           ws={ws}
           mentionableUsers={mentionableUsers}
           onOpenDM={handleOpenDM}
           onUnreadClear={handleUnreadClear}
           onMentionClear={handleMentionClear}
           onMessageReceived={handleMessageReceived}
           onMentionReceived={handleMentionReceived}
           onMembersRefresh={handleMembersRefresh}
           onActivity={refreshUiState}
           onCall={(channelId) => webrtc.joinVoice(channelId)}
           members={members}
           serverId={selectedServerId}
           onOpenModal={setModal}
           onServerModal={openServerModal}
           activeVoiceUsers={activeVoiceUsers}
           currentVoiceChannelId={webrtc.currentChannelId}
           onRefreshVoiceActive={refreshVoiceActive}
        />
      );
    }
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

      <div className={styles.mainContent}>
        {showFocusedView ? (
          <FocusedVideoView
            stream={focusedEntry.stream}
            label={focusedEntry.label}
            onBack={handleFocusedVideoBack}
            onFullscreen={handleFullscreen}
            containerRef={focusedVideoContainerRef}
          />
        ) : (
          <>
            {renderActiveView()}
            
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
        {showVoiceBar && (
          <div className={styles.voiceBarWrap}>
            <VoiceBar
              channelName={voiceChannelName}
              user={user}
              webrtc={webrtc}
              cameraOn={cameraOn}
              onRefreshVoiceActive={refreshVoiceActive}
              onCameraToggle={handleCameraToggle}
            />
          </div>
        )}
      </div>

      <NavigationBar 
        activeView={view} 
        onViewChange={handleViewChange} 
        unreadDMs={totalDmUnread} 
        unreadServers={Object.values(unreadByServer).reduce((a, b) => a + b, 0) + Object.values(mentionByServer).reduce((a, b) => a + b, 0)} 
        onBack={view === "servers" && selectedServerId ? handleBackToServerList : undefined}
      />

      <Modals
        api={api}
        baseUrl={baseUrl}
        user={user}
        modal={modal}
        modalData={modalData}
        onClose={handleCloseModal}
        onServerCreated={loadServers}
        onServerDeleted={handleServerDeleted}
        onServerRenamed={loadServers}
        onChannelCreated={useStableCallback((serverId) => serverId && loadChannels(serverId))}
        onChannelDeleted={handleChannelDeleted}
        onJoinServer={loadServers}
        onProfileSaved={onProfileSaved}
        onDmCreated={loadDMs}
        onOpenDMChannel={handleOpenDMChannel}
      />
    </div>
  );
}
