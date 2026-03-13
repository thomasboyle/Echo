import React from "react";
import styles from "./VoiceBar.module.css";

export default function VoiceBar({ channelName, user, webrtc, cameraOn, onCameraToggle, onRefreshVoiceActive }) {
  const { isMuted, isDeafened, leaveVoice, toggleMute, toggleDeafen, resumeRemoteAudio, isScreensharing, startScreenshare, stopScreenshare } = webrtc || {};

  const handleVoiceAction = (fn) => () => {
    if (resumeRemoteAudio) resumeRemoteAudio();
    if (fn) fn();
  };

  const handleLeave = () => {
    if (resumeRemoteAudio) resumeRemoteAudio();
    const p = leaveVoice?.();
    if (p && typeof p.then === "function") p.then(() => onRefreshVoiceActive?.());
    else onRefreshVoiceActive?.();
  };

  return (
    <div className={styles.root}>
      <div className={styles.topRow}>
        <div className={styles.header}>
          <span className={styles.status}>Voice Connected</span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.btn} ${isMuted ? styles.active : ""}`}
            onClick={handleVoiceAction(toggleMute)}
            title="Mute"
          >
            Mute
          </button>
          <button
            type="button"
            className={`${styles.btn} ${isDeafened ? styles.active : ""}`}
            onClick={handleVoiceAction(toggleDeafen)}
            title="Deafen"
          >
            Deafen
          </button>
          <button
            type="button"
            className={`${styles.btn} ${cameraOn ? styles.active : ""}`}
            onClick={() => onCameraToggle?.()}
            title="Camera"
          >
            Camera
          </button>
          <button
            type="button"
            className={`${styles.btn} ${isScreensharing ? styles.active : ""}`}
            onClick={() => (isScreensharing ? stopScreenshare() : startScreenshare())}
            title="Screenshare"
          >
            Screenshare
          </button>
          <button type="button" className={styles.leaveBtn} onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
