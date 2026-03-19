import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import joinSoundUrl from "@assets/sounds/VoiceChat_Join.mp3";
import leaveSoundUrl from "@assets/sounds/VoiceChat_Leave.mp3";

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const STORAGE_AUDIO_INPUT = "nexus_audio_input_id";
const STORAGE_AUDIO_OUTPUT = "nexus_audio_output_id";
const DEFAULT_DISPLAY_NAME = "User";
const DEFAULT_AVATAR_EMOJI = "🐱";

function getStoredAudioInputId() {
  try {
    const id = localStorage.getItem(STORAGE_AUDIO_INPUT);
    return id || "";
  } catch {
    return "";
  }
}

function getStoredAudioOutputId() {
  try {
    const id = localStorage.getItem(STORAGE_AUDIO_OUTPUT);
    return id || "";
  } catch {
    return "";
  }
}

function playSound(url) {
  if (!url) return;
  const el = new Audio(url);
  const outputId = getStoredAudioOutputId();
  if (outputId && typeof el.setSinkId === "function") {
    el.setSinkId(outputId).catch(() => {});
  }
  el.play().catch(() => {});
}

function playAudioWithRetry(el, retries = 10) {
  el.play().then(() => {}).catch(() => {
    if (retries > 0) setTimeout(() => playAudioWithRetry(el, retries - 1), 400);
  });
}

function addTracksToPeerConnection(pc, mediaStream) {
  if (!pc || !mediaStream) return;
  const tracks = mediaStream.getTracks();
  for (let i = 0; i < tracks.length; i++) {
    pc.addTrack(tracks[i], mediaStream);
  }
}

function normalizeIceServers(servers) {
  if (!Array.isArray(servers)) return DEFAULT_ICE_SERVERS;
  const normalized = [];
  for (let i = 0; i < servers.length; i++) {
    const entry = servers[i];
    if (!entry || typeof entry !== "object") continue;
    const urls = entry.urls;
    const urlsValid =
      typeof urls === "string" || (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string"));
    if (!urlsValid) continue;
    const out = { urls };
    if (typeof entry.username === "string") out.username = entry.username;
    if (typeof entry.credential === "string") out.credential = entry.credential;
    if (typeof entry.credentialType === "string") out.credentialType = entry.credentialType;
    normalized.push(out);
  }
  return normalized.length > 0 ? normalized : DEFAULT_ICE_SERVERS;
}

export function useWebRTC(baseUrl, token, api, onActivity) {
  const [isInVoice, setIsInVoice] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [peers, setPeers] = useState([]);
  const [serverVoicePeers, setServerVoicePeers] = useState([]);
  const [currentChannelId, setCurrentChannelId] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [localScreenStream, setLocalScreenStream] = useState(null);
  const [isScreensharing, setIsScreensharing] = useState(false);
  const [peerScreensharing, setPeerScreensharing] = useState({});
  const [hasVideoSource, setHasVideoSource] = useState(false);
  const currentChannelIdRef = useRef(null);
  currentChannelIdRef.current = currentChannelId;
  const serverVoicePeersIntervalRef = useRef(null);

  const localStreamRef = useRef(null);
  const signalingWsRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const peerStreamsRef = useRef({});
  const peerTracksRef = useRef({});
  const audioElementsRef = useRef({});
  const iceCandidateQueueRef = useRef({});
  const screenStreamRef = useRef(null);
  const myUserIdRef = useRef(null);
  const iceServersRef = useRef(DEFAULT_ICE_SERVERS);
  const shouldInitiateOffer = useCallback((myId, peerId) => {
    if (!peerId) return false;
    if (!myId) return true;
    return String(myId) < String(peerId);
  }, []);
  const notifyActivity = useCallback(() => {
    onActivity?.();
  }, [onActivity]);

  const addPeer = useCallback((userId, displayName, stream = null, isSpeaking = false, avatarEmoji = DEFAULT_AVATAR_EMOJI) => {
    setPeers((prev) => {
      for (let i = 0; i < prev.length; i++) {
        const p = prev[i];
        if (p.userId !== userId) continue;
        const next = prev.slice();
        next[i] = {
          ...p,
          displayName,
          stream: stream ?? p.stream,
          isSpeaking,
          avatarEmoji: avatarEmoji ?? p.avatarEmoji,
        };
        return next;
      }
      return [...prev, { userId, displayName, stream, isSpeaking, avatarEmoji }];
    });
  }, []);

  const removePeer = useCallback((userId) => {
    const pc = peerConnectionsRef.current[userId];
    if (pc) {
      pc.close();
      delete peerConnectionsRef.current[userId];
    }
    const el = audioElementsRef.current[userId];
    if (el) {
      el.srcObject = null;
      if (el.parentNode) el.parentNode.removeChild(el);
      delete audioElementsRef.current[userId];
    }
    delete peerStreamsRef.current[userId];
    delete peerTracksRef.current[userId];
    setPeers((prev) => prev.filter((p) => p.userId !== userId));
  }, []);

  const mergeTrackIntoPeerStream = useCallback((userId, track, streamFromEvent) => {
    let stream = peerStreamsRef.current[userId];
    if (!stream) {
      stream = streamFromEvent || new MediaStream([track]);
      peerStreamsRef.current[userId] = stream;
      const trackSet = new Set();
      for (const t of stream.getTracks()) trackSet.add(t);
      peerTracksRef.current[userId] = trackSet;
      return stream;
    }
    let trackSet = peerTracksRef.current[userId];
    if (!trackSet) {
      trackSet = new Set();
      for (const t of stream.getTracks()) trackSet.add(t);
      peerTracksRef.current[userId] = trackSet;
    }
    if (!trackSet.has(track)) {
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      trackSet.add(track);
    }
    return stream;
  }, []);

  const playRemoteStream = useCallback((userId, stream) => {
    if (!stream) return;
    peerStreamsRef.current[userId] = stream;
    let el = audioElementsRef.current[userId];
    if (!el) {
      el = new Audio();
      el.style.position = "absolute";
      el.style.left = "-9999px";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
      audioElementsRef.current[userId] = el;
    }
    el.srcObject = stream;
    el.muted = false;
    el.autoplay = true;
    const outputId = getStoredAudioOutputId();
    if (outputId && typeof el.setSinkId === "function") {
      el.setSinkId(outputId).catch(() => {});
    }
    playAudioWithRetry(el);
  }, []);

  const leaveVoice = useCallback(async () => {
    playSound(leaveSoundUrl);
    setVoiceError(null);
    const ch = currentChannelIdRef.current;
    if (ch && api) await api.leaveVoice(ch).catch(() => {});
    if (signalingWsRef.current) {
      signalingWsRef.current.close();
      signalingWsRef.current = null;
    }
    const peerConnections = peerConnectionsRef.current;
    for (const peerId in peerConnections) {
      peerConnections[peerId].close();
    }
    peerConnectionsRef.current = {};
    const audioElements = audioElementsRef.current;
    for (const id in audioElements) {
      const el = audioElements[id];
      el.srcObject = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    audioElementsRef.current = {};
    peerStreamsRef.current = {};
    peerTracksRef.current = {};
    iceCandidateQueueRef.current = {};
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    myUserIdRef.current = null;
    setLocalStream(null);
    setLocalScreenStream(null);
    setHasVideoSource(false);
    setIsScreensharing(false);
    setPeerScreensharing({});
    setCurrentChannelId(null);
    setPeers([]);
    setServerVoicePeers([]);
    if (serverVoicePeersIntervalRef.current) {
      clearInterval(serverVoicePeersIntervalRef.current);
      serverVoicePeersIntervalRef.current = null;
    }
    setIsMuted(false);
    setIsDeafened(false);
    setIsInVoice(false);
    notifyActivity();
  }, [api, notifyActivity]);

  const joinVoice = useCallback(
    async (channelId) => {
      setVoiceError(null);
      if (!api || !baseUrl || !token) {
        setVoiceError("Not connected. Check server URL in settings.");
        return;
      }
      const prevId = currentChannelIdRef.current;
      if (prevId && prevId !== channelId) {
        await leaveVoice();
      }
      try {
        let myUserId = null;
        try {
          const me = await api.getMe();
          myUserId = me?.id || null;
          myUserIdRef.current = myUserId;
        } catch (_) {
          myUserIdRef.current = null;
        }
        try {
          const cfg = await api.getVoiceIceServers?.();
          iceServersRef.current = normalizeIceServers(cfg?.ice_servers);
        } catch (_) {
          iceServersRef.current = DEFAULT_ICE_SERVERS;
        }

        const audioInputId = getStoredAudioInputId();
        const audioConstraint = audioInputId ? { deviceId: audioInputId } : true;
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraint,
            video: { width: 640, height: 480 },
          });
        } catch (videoErr) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        }
        stream.getVideoTracks().forEach((t) => (t.enabled = false));
        setHasVideoSource(stream.getVideoTracks().length > 0);
        localStreamRef.current = stream;
        setLocalStream(stream);
        await api.joinVoice(channelId);
        const url = baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
        const wsUrl = `${url}/voice-signal/${channelId}?token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(wsUrl);
        signalingWsRef.current = ws;
        setCurrentChannelId(channelId);
        setIsInVoice(true);
        setIsMuted(false);
        setIsDeafened(false);
        notifyActivity();
        playSound(joinSoundUrl);

        const existingPeers = await api.getVoicePeers(channelId).catch(() => []);
        setServerVoicePeers(existingPeers || []);

        serverVoicePeersIntervalRef.current = setInterval(async () => {
          if (!currentChannelIdRef.current || currentChannelIdRef.current !== channelId) return;
          if (!api) return;
          try {
            const list = await api.getVoicePeers(channelId);
            setServerVoicePeers(list || []);
          } catch (_) {}
        }, 2500);

        const sendOffersToPeers = async (peerList, myId, wsRef) => {
          const ws = wsRef?.current;
          if (!ws || ws.readyState !== WebSocket.OPEN || !stream) return;
          for (const p of peerList || []) {
            if (!p?.id || (myId && p.id === myId)) continue;
            const peerId = p.id;
            if (!shouldInitiateOffer(myId, peerId)) continue;
            if (peerConnectionsRef.current[peerId]) continue;
            const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
            peerConnectionsRef.current[peerId] = pc;
            pc.onconnectionstatechange = () => {
              if (pc.connectionState === "connected") {
                const el = audioElementsRef.current[peerId];
                if (el?.srcObject && el.paused) el.play().catch(() => {});
              }
            };
            pc.onicecandidate = (e) => {
              if (e.candidate && wsRef.current?.readyState === WebSocket.OPEN)
                wsRef.current.send(
                  JSON.stringify({
                    type: "ice-candidate",
                    to_user_id: peerId,
                    candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
                  })
                );
            };
            pc.ontrack = (e) => {
              const track = e.track;
              const stream = mergeTrackIntoPeerStream(peerId, track, e.streams?.[0]);
              playRemoteStream(peerId, stream);
              addPeer(peerId, p.display_name || DEFAULT_DISPLAY_NAME, stream, false, p.avatar_emoji || DEFAULT_AVATAR_EMOJI);
            };
            addTracksToPeerConnection(pc, stream);
            if (screenStreamRef.current) {
              addTracksToPeerConnection(pc, screenStreamRef.current);
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "offer", to_user_id: peerId, offer }));
            addPeer(peerId, p.display_name || DEFAULT_DISPLAY_NAME, null, false, p.avatar_emoji || DEFAULT_AVATAR_EMOJI);
          }
        };

        const drainIceQueue = async (uid) => {
          const queue = iceCandidateQueueRef.current[uid] || [];
          delete iceCandidateQueueRef.current[uid];
          if (queue.length === 0) return;
          const pc = peerConnectionsRef.current[uid];
          if (!pc) return;
          for (const c of queue) await pc.addIceCandidate(c).catch(() => {});
        };

        ws.onmessage = async (ev) => {
          if (signalingWsRef.current !== ws || currentChannelIdRef.current !== channelId) return;
          try {
            const data = JSON.parse(ev.data);
            const fromId = data.from_user_id;
            switch (data.type) {
              case "force_disconnect": {
                leaveVoice();
                notifyActivity();
                return;
              }
              case "peer_left": {
                const leftUserId = data.user_id;
                if (leftUserId !== myUserIdRef.current) {
                  playSound(leaveSoundUrl);
                }
                setPeerScreensharing((prev) => {
                  const next = { ...prev };
                  delete next[leftUserId];
                  return next;
                });
                removePeer(leftUserId);
                notifyActivity();
                return;
              }
              case "screenshare_state": {
                setPeerScreensharing((prev) => ({ ...prev, [fromId]: !!data.screensharing }));
                return;
              }
              case "existing_peers": {
                const peerList = data.peers || [];
                const myId = myUserIdRef.current;
                await sendOffersToPeers(peerList, myId, signalingWsRef);
                return;
              }
              case "peer_joined": {
                const newUserId = data.user_id;
                if (newUserId !== myUserIdRef.current) {
                  playSound(joinSoundUrl);
                }
                if (peerConnectionsRef.current[newUserId]) return;
                const myId = myUserIdRef.current;
                if (!shouldInitiateOffer(myId, newUserId)) {
                  addPeer(newUserId, data.display_name || DEFAULT_DISPLAY_NAME, null, false, data.avatar_emoji || DEFAULT_AVATAR_EMOJI);
                  notifyActivity();
                  return;
                }
                const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
                peerConnectionsRef.current[newUserId] = pc;
                pc.onconnectionstatechange = () => {
                  if (pc.connectionState === "connected") {
                    const el = audioElementsRef.current[newUserId];
                    if (el?.srcObject && el.paused) el.play().catch(() => {});
                  }
                };
                pc.onicecandidate = (e) => {
                  if (e.candidate && ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: "ice-candidate",
                        to_user_id: newUserId,
                        candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
                      })
                    );
                };
                pc.ontrack = (e) => {
                  const track = e.track;
                  const stream = mergeTrackIntoPeerStream(newUserId, track, e.streams?.[0]);
                  playRemoteStream(newUserId, stream);
                  addPeer(
                    newUserId,
                    data.display_name || DEFAULT_DISPLAY_NAME,
                    stream,
                    false,
                    data.avatar_emoji || DEFAULT_AVATAR_EMOJI
                  );
                };
                addTracksToPeerConnection(pc, stream);
                if (screenStreamRef.current) {
                  addTracksToPeerConnection(pc, screenStreamRef.current);
                }
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: "offer", to_user_id: newUserId, offer }));
                addPeer(
                  newUserId,
                  data.display_name || DEFAULT_DISPLAY_NAME,
                  null,
                  false,
                  data.avatar_emoji || DEFAULT_AVATAR_EMOJI
                );
                if (screenStreamRef.current && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "screenshare_state", screensharing: true, to_user_id: newUserId }));
                }
                notifyActivity();
                return;
              }
              case "offer": {
                if (peerConnectionsRef.current[fromId]) {
                  const existingPc = peerConnectionsRef.current[fromId];
                  existingPc.close();
                  delete peerConnectionsRef.current[fromId];
                }
                delete peerStreamsRef.current[fromId];
                delete peerTracksRef.current[fromId];
                const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
                peerConnectionsRef.current[fromId] = pc;
                pc.onconnectionstatechange = () => {
                  if (pc.connectionState === "connected") {
                    const el = audioElementsRef.current[fromId];
                    if (el?.srcObject && el.paused) el.play().catch(() => {});
                  }
                };
                pc.onicecandidate = (e) => {
                  if (e.candidate)
                    ws.send(
                      JSON.stringify({
                        type: "ice-candidate",
                        to_user_id: fromId,
                        candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
                      })
                    );
                };
                pc.ontrack = (e) => {
                  const track = e.track;
                  const stream = mergeTrackIntoPeerStream(fromId, track, e.streams?.[0]);
                  playRemoteStream(fromId, stream);
                  addPeer(
                    fromId,
                    data.from_display_name || DEFAULT_DISPLAY_NAME,
                    stream,
                    false,
                    data.from_avatar_emoji || DEFAULT_AVATAR_EMOJI
                  );
                };
                addTracksToPeerConnection(pc, stream);
                if (screenStreamRef.current) {
                  addTracksToPeerConnection(pc, screenStreamRef.current);
                }
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                await drainIceQueue(fromId);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "answer", to_user_id: fromId, answer }));
                return;
              }
              case "answer": {
                const pc = peerConnectionsRef.current[fromId];
                if (pc && data.answer) {
                  await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                  await drainIceQueue(fromId);
                }
                return;
              }
              case "ice-candidate": {
                if (!data.candidate) return;
                const cand = new RTCIceCandidate(data.candidate);
                const pc = peerConnectionsRef.current[fromId];
                if (!pc) {
                  if (!iceCandidateQueueRef.current[fromId]) iceCandidateQueueRef.current[fromId] = [];
                  iceCandidateQueueRef.current[fromId].push(cand);
                  return;
                }
                if (!pc.remoteDescription) {
                  if (!iceCandidateQueueRef.current[fromId]) iceCandidateQueueRef.current[fromId] = [];
                  iceCandidateQueueRef.current[fromId].push(cand);
                  return;
                }
                await pc.addIceCandidate(cand).catch(() => {});
                return;
              }
            }
          } catch (err) {}
        };

        ws.onopen = async () => {
          const myId = myUserIdRef.current;
          await sendOffersToPeers(existingPeers, myId, signalingWsRef);
          setTimeout(async () => {
            const fresh = await api.getVoicePeers(channelId).catch(() => []);
            setServerVoicePeers(fresh || []);
            await sendOffersToPeers(fresh, myId, signalingWsRef);
          }, 1500);
        };
      } catch (err) {
        const msg = err?.message || "Could not join voice channel";
        setVoiceError(msg);
        if (serverVoicePeersIntervalRef.current) {
          clearInterval(serverVoicePeersIntervalRef.current);
          serverVoicePeersIntervalRef.current = null;
        }
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((t) => t.stop());
          localStreamRef.current = null;
        }
        setLocalStream(null);
        setHasVideoSource(false);
        setIsInVoice(false);
        setCurrentChannelId(null);
        throw err;
      }
    },
    [baseUrl, token, api, leaveVoice, addPeer, removePeer, playRemoteStream, mergeTrackIntoPeerStream, notifyActivity, shouldInitiateOffer]
  );

  const setCameraEnabled = useCallback((enabled) => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }, []);

  const startScreenshare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 } },
        audio: true,
      });
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack?.applyConstraints) {
        try {
          await screenTrack.applyConstraints({
            width: { max: 1920 },
            height: { max: 1080 },
            frameRate: {
              min: 60,
              ideal: 60,
              max: 60,
            },
          });
        } catch (_) {}
      }
      screenStreamRef.current = stream;
      setLocalScreenStream(stream);
      setIsScreensharing(true);
      if (screenTrack) screenTrack.onended = () => stopScreenshare();
      setTimeout(() => invoke("hide_screen_sharing_indicator").catch(() => {}), 1);
      notifyActivity();
      const ws = signalingWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const tracks = stream.getTracks();
        if (tracks.length > 0) {
          for (const peerId in peerConnectionsRef.current) {
            const pc = peerConnectionsRef.current[peerId];
            for (let i = 0; i < tracks.length; i++) {
              pc.addTrack(tracks[i], stream);
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "offer", to_user_id: peerId, offer }));
          }
          ws.send(JSON.stringify({ type: "screenshare_state", screensharing: true }));
        }
      }
    } catch (err) {
      setIsScreensharing(false);
      notifyActivity();
      setLocalScreenStream(null);
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
    }
  }, []);

  const stopScreenshare = useCallback(async () => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    const ws = signalingWsRef.current;
    const streamTracks = stream.getTracks();
    const streamTrackSet = new Set(streamTracks);
    for (const peerId in peerConnectionsRef.current) {
      const pc = peerConnectionsRef.current[peerId];
      const senders = pc.getSenders();
      let removedCount = 0;
      for (let i = 0; i < senders.length; i++) {
        const sender = senders[i];
        if (sender.track && streamTrackSet.has(sender.track)) {
          pc.removeTrack(sender);
          removedCount++;
        }
      }
      if (removedCount > 0) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "offer", to_user_id: peerId, offer }));
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setLocalScreenStream(null);
    setIsScreensharing(false);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "screenshare_state", screensharing: false }));
    }
    notifyActivity();
  }, [notifyActivity]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    let nextMuted = false;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
      nextMuted = !t.enabled;
    });
    setIsMuted(nextMuted);
    const channelId = currentChannelIdRef.current;
    if (channelId && api?.updateVoiceState) {
      api.updateVoiceState(channelId, { muted: nextMuted }).catch(() => {});
    }
  }, [api]);

  const toggleDeafen = useCallback(() => {
    const next = !isDeafened;
    setIsDeafened(next);
    const audioElements = audioElementsRef.current;
    for (const peerId in audioElements) audioElements[peerId].muted = next;
    const channelId = currentChannelIdRef.current;
    if (channelId && api?.updateVoiceState) {
      api.updateVoiceState(channelId, { deafened: next }).catch(() => {});
    }
  }, [isDeafened, api]);

  const resumeRemoteAudio = useCallback(() => {
    const audioElements = audioElementsRef.current;
    for (const peerId in audioElements) {
      const el = audioElements[peerId];
      if (el.srcObject && el.paused) el.play().catch(() => {});
    }
  }, []);

  useEffect(() => () => {
    leaveVoice();
  }, []);

  return {
    isInVoice,
    isMuted,
    isDeafened,
    peers,
    serverVoicePeers,
    currentChannelId,
    voiceError,
    localStream,
    localScreenStream,
    isScreensharing,
    peerScreensharing,
    hasVideoSource,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    setCameraEnabled,
    startScreenshare,
    stopScreenshare,
    resumeRemoteAudio,
  };
}
