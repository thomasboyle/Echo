import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const STORAGE_AUDIO_INPUT = "nexus_audio_input_id";
const STORAGE_AUDIO_OUTPUT = "nexus_audio_output_id";

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
  const [hasVideoSource, setHasVideoSource] = useState(false);
  const currentChannelIdRef = useRef(null);
  currentChannelIdRef.current = currentChannelId;
  const serverVoicePeersIntervalRef = useRef(null);

  const localStreamRef = useRef(null);
  const signalingWsRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const peerStreamsRef = useRef({});
  const audioElementsRef = useRef({});
  const iceCandidateQueueRef = useRef({});
  const screenStreamRef = useRef(null);
  const notifyActivity = useCallback(() => {
    onActivity?.();
  }, [onActivity]);

  const addPeer = useCallback((userId, displayName, stream = null, isSpeaking = false, avatarEmoji = "🐱") => {
    setPeers((prev) => {
      const existing = prev.find((p) => p.userId === userId);
      if (existing) {
        return prev.map((p) =>
          p.userId === userId
            ? { ...p, displayName, stream: stream ?? p.stream, isSpeaking, avatarEmoji: avatarEmoji ?? p.avatarEmoji }
            : p
        );
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
    setPeers((prev) => prev.filter((p) => p.userId !== userId));
  }, []);

  const mergeTrackIntoPeerStream = useCallback((userId, track, streamFromEvent) => {
    let stream = peerStreamsRef.current[userId];
    if (!stream) {
      stream = streamFromEvent || new MediaStream([track]);
      peerStreamsRef.current[userId] = stream;
    } else if (!stream.getTracks().includes(track)) {
      stream.addTrack(track);
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
    const tryPlay = (retries = 10) => {
      el.play().then(() => {}).catch(() => {
        if (retries > 0) setTimeout(() => tryPlay(retries - 1), 400);
      });
    };
    tryPlay();
  }, []);

  const leaveVoice = useCallback(async () => {
    setVoiceError(null);
    const ch = currentChannelIdRef.current;
    if (ch && api) await api.leaveVoice(ch).catch(() => {});
    if (signalingWsRef.current) {
      signalingWsRef.current.close();
      signalingWsRef.current = null;
    }
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    Object.keys(audioElementsRef.current).forEach((id) => {
      const el = audioElementsRef.current[id];
      el.srcObject = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    audioElementsRef.current = {};
    peerStreamsRef.current = {};
    iceCandidateQueueRef.current = {};
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    setLocalStream(null);
    setLocalScreenStream(null);
    setHasVideoSource(false);
    setIsScreensharing(false);
    setCurrentChannelId(null);
    setPeers([]);
    setServerVoicePeers([]);
    if (serverVoicePeersIntervalRef.current) {
      clearInterval(serverVoicePeersIntervalRef.current);
      serverVoicePeersIntervalRef.current = null;
    }
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
        notifyActivity();

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
            if (peerConnectionsRef.current[peerId]) continue;
            const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
              addPeer(peerId, p.display_name || "User", stream, false, p.avatar_emoji || "🐱");
            };
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
            if (screenStreamRef.current) {
              screenStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, screenStreamRef.current));
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "offer", to_user_id: peerId, offer }));
            addPeer(peerId, p.display_name || "User", null, false, p.avatar_emoji || "🐱");
          }
        };

        const drainIceQueue = async (uid) => {
          const queue = iceCandidateQueueRef.current[uid] || [];
          delete iceCandidateQueueRef.current[uid];
          const pc = peerConnectionsRef.current[uid];
          for (const c of queue) {
            await pc?.addIceCandidate(c).catch(() => {});
          }
        };

        ws.onmessage = async (ev) => {
          try {
            const data = JSON.parse(ev.data);
            const fromId = data.from_user_id;

            if (data.type === "force_disconnect") {
              leaveVoice();
              notifyActivity();
              return;
            }

            if (data.type === "peer_left") {
              removePeer(data.user_id);
              notifyActivity();
              return;
            }

            if (data.type === "peer_joined") {
              const newUserId = data.user_id;
              if (peerConnectionsRef.current[newUserId]) return;
              const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
                addPeer(newUserId, data.display_name || "User", stream, false, data.avatar_emoji || "🐱");
              };
              stream.getTracks().forEach((track) => pc.addTrack(track, stream));
              if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, screenStreamRef.current));
              }
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              ws.send(JSON.stringify({ type: "offer", to_user_id: newUserId, offer }));
              addPeer(newUserId, data.display_name || "User", null, false, data.avatar_emoji || "🐱");
              notifyActivity();
              return;
            }

            if (data.type === "offer") {
              if (peerConnectionsRef.current[fromId]) {
                const existingPc = peerConnectionsRef.current[fromId];
                existingPc.close();
                delete peerConnectionsRef.current[fromId];
              }
              delete peerStreamsRef.current[fromId];
              const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
                addPeer(fromId, data.from_display_name || "User", stream, false, data.from_avatar_emoji || "🐱");
              };
              stream.getTracks().forEach((track) => pc.addTrack(track, stream));
              if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, screenStreamRef.current));
              }
              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              await drainIceQueue(fromId);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              ws.send(JSON.stringify({ type: "answer", to_user_id: fromId, answer }));
              return;
            }

            if (data.type === "answer") {
              const pc = peerConnectionsRef.current[fromId];
              if (pc && data.answer) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                await drainIceQueue(fromId);
              }
              return;
            }

            if (data.type === "ice-candidate" && data.candidate) {
              const pc = peerConnectionsRef.current[fromId];
              if (!pc) return;
              const cand = new RTCIceCandidate(data.candidate);
              if (!pc.remoteDescription) {
                if (!iceCandidateQueueRef.current[fromId]) iceCandidateQueueRef.current[fromId] = [];
                iceCandidateQueueRef.current[fromId].push(cand);
                return;
              }
              await pc.addIceCandidate(cand).catch(() => {});
            }
          } catch (err) {}
        };

        ws.onopen = async () => {
          let myId = null;
          try {
            const me = await api.getMe();
            myId = me?.id;
          } catch (_) {}
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
    [baseUrl, token, api, leaveVoice, addPeer, removePeer, playRemoteStream, mergeTrackIntoPeerStream]
  );

  const setCameraEnabled = useCallback((enabled) => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }, []);

  const startScreenshare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack?.applyConstraints) {
        try {
          await screenTrack.applyConstraints({
            frameRate: {
              min: 30,
              ideal: 30,
              max: 30,
            },
          });
        } catch (_) {
          // Some platforms ignore or reject strict display track constraints.
        }
      }
      screenStreamRef.current = stream;
      setLocalScreenStream(stream);
      setIsScreensharing(true);
      if (screenTrack) screenTrack.onended = () => stopScreenshare();
      setTimeout(() => invoke("hide_screen_sharing_indicator").catch(() => {}), 1);
      notifyActivity();
      const ws = signalingWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const [peerId, pc] of Object.entries(peerConnectionsRef.current)) {
          const track = screenTrack;
          if (track) {
            pc.addTrack(track, stream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "offer", to_user_id: peerId, offer }));
          }
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
    for (const [peerId, pc] of Object.entries(peerConnectionsRef.current)) {
      const sender = pc.getSenders().find((s) => s.track && stream.getTracks().includes(s.track));
      if (sender) {
        pc.removeTrack(sender);
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
    notifyActivity();
  }, [notifyActivity]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setIsMuted((m) => !m);
  }, []);

  const toggleDeafen = useCallback(() => {
    const next = !isDeafened;
    setIsDeafened(next);
    Object.values(audioElementsRef.current).forEach((el) => {
      el.muted = next;
    });
  }, [isDeafened]);

  const resumeRemoteAudio = useCallback(() => {
    Object.values(audioElementsRef.current).forEach((el) => {
      if (el.srcObject && el.paused) el.play().catch(() => {});
    });
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
