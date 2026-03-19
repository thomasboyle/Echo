import { invoke } from "@tauri-apps/api/core";

function addTracksToPeerConnection(pc, mediaStream) {
  if (!pc || !mediaStream) return;
  const tracks = mediaStream.getTracks();
  for (let i = 0; i < tracks.length; i++) {
    pc.addTrack(tracks[i], mediaStream);
  }
}

export function createVideoFeedsController({
  localStreamRef,
  screenStreamRef,
  signalingWsRef,
  peerConnectionsRef,
  setLocalScreenStream,
  setIsScreensharing,
  notifyActivity,
}) {
  const setCameraEnabled = (enabled) => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = enabled));
  };

  const stopScreenshare = async () => {
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
  };

  const startScreenshare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { max: 120 },
        },
        audio: true,
      });
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack?.applyConstraints) {
        try {
          await screenTrack.applyConstraints({
            frameRate: {
              max: 120,
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
            addTracksToPeerConnection(pc, stream);
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
  };

  return {
    setCameraEnabled,
    startScreenshare,
    stopScreenshare,
  };
}
