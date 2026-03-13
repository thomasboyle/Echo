import React, { useState, useEffect, useRef, useCallback } from "react";
import styles from "./SettingsModal.module.css";

const STORAGE_KEYS = {
  audioInput: "nexus_audio_input_id",
  audioOutput: "nexus_audio_output_id",
  videoInput: "nexus_video_input_id",
};

const EMOJIS = ["🌐", "🎮", "💬", "🎵", "📚", "🚀", "⭐", "🔥", "💻", "🎨", "🐱", "🐶"];
const MAX_RECORD_MS = 10000;

function getStored(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function setStored(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {}
}

export default function SettingsModal({ user, api, baseUrl, onClose, onProfileSaved }) {
  const [category, setCategory] = useState("Audio");
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [videoInputs, setVideoInputs] = useState([]);
  const [audioInputId, setAudioInputId] = useState("");
  const [audioOutputId, setAudioOutputId] = useState("");
  const [videoInputId, setVideoInputId] = useState("");
  const [testRecording, setTestRecording] = useState(false);
  const [testRecordedBlob, setTestRecordedBlob] = useState(null);
  const [testRecordedUrl, setTestRecordedUrl] = useState(null);
  const [testPlaybackPaused, setTestPlaybackPaused] = useState(true);
  const [accountError, setAccountError] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [avatarEmoji, setAvatarEmoji] = useState("🐱");
  const [avatarFileInputKey, setAvatarFileInputKey] = useState(0);
  const [videoPreviewActive, setVideoPreviewActive] = useState(false);

  const testRecorderRef = useRef(null);
  const testStreamRef = useRef(null);
  const testAudioRef = useRef(null);
  const testChunksRef = useRef([]);
  const testTimerRef = useRef(null);
  const testObjectUrlRef = useRef(null);
  const videoPreviewStreamRef = useRef(null);
  const videoPreviewRef = useRef(null);

  const loadDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const outputs = devices.filter((d) => d.kind === "audiooutput");
      const videos = devices.filter((d) => d.kind === "videoinput");
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      setVideoInputs(videos);
    } catch (_) {
      setAudioInputs([]);
      setAudioOutputs([]);
      setVideoInputs([]);
    }
  }, []);

  useEffect(() => {
    setAudioInputId(getStored(STORAGE_KEYS.audioInput));
    setAudioOutputId(getStored(STORAGE_KEYS.audioOutput));
    setVideoInputId(getStored(STORAGE_KEYS.videoInput));
    loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.display_name || "");
    setAvatarEmoji(user.avatar_emoji || "🐱");
  }, [user]);

  useEffect(() => {
    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
  }, [loadDevices]);

  const handleAudioInputChange = (e) => {
    const v = e.target.value || "";
    setAudioInputId(v);
    setStored(STORAGE_KEYS.audioInput, v);
  };

  const handleAudioOutputChange = (e) => {
    const v = e.target.value || "";
    setAudioOutputId(v);
    setStored(STORAGE_KEYS.audioOutput, v);
  };

  const handleVideoInputChange = (e) => {
    const v = e.target.value || "";
    setVideoInputId(v);
    setStored(STORAGE_KEYS.videoInput, v);
  };

  const stopVideoPreview = useCallback(() => {
    const stream = videoPreviewStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      videoPreviewStreamRef.current = null;
    }
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
    setVideoPreviewActive(false);
  }, []);

  const toggleVideoPreview = useCallback(async () => {
    if (videoPreviewActive) {
      stopVideoPreview();
      return;
    }
    const constraints = { video: true };
    if (videoInputId) constraints.video = { deviceId: videoInputId };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      videoPreviewStreamRef.current = stream;
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
      }
      setVideoPreviewActive(true);
    } catch (err) {
      setAccountError(err?.message || "Could not access camera");
    }
  }, [videoInputId, videoPreviewActive, stopVideoPreview]);

  useEffect(() => {
    if (category !== "Video") stopVideoPreview();
  }, [category, stopVideoPreview]);

  useEffect(() => () => stopVideoPreview(), [stopVideoPreview]);

  const startTestRecord = useCallback(async () => {
    if (testRecording || testRecordedBlob) return;
    const constraints = { audio: true };
    if (audioInputId) constraints.audio = { deviceId: audioInputId };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      testStreamRef.current = stream;
      setTestRecording(true);
      setTestRecordedBlob(null);
      setTestPlaybackPaused(true);
      testChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      testRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) testChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        testStreamRef.current = null;
        if (testChunksRef.current.length === 0) {
          setTestRecording(false);
          return;
        }
        const blob = new Blob(testChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        testChunksRef.current = [];
        setTestRecordedBlob(blob);
        setTestRecordedUrl(URL.createObjectURL(blob));
        setTestRecording(false);
      };
      recorder.start(100);
      testTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.requestData();
          recorder.stop();
        }
      }, MAX_RECORD_MS);
    } catch (err) {
      setTestRecording(false);
      setAccountError(err?.message || "Could not access microphone");
    }
  }, [audioInputId, testRecording, testRecordedBlob]);

  const stopTestRecord = useCallback(() => {
    if (testTimerRef.current) {
      clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
    }
    const rec = testRecorderRef.current;
    if (rec && rec.state === "recording") {
      rec.requestData();
      rec.stop();
      testRecorderRef.current = null;
    }
    setTestRecording(false);
  }, []);

  const playTestPlayback = useCallback(() => {
    if (!testAudioRef.current || !testRecordedBlob) return;
    const el = testAudioRef.current;
    if (el.paused) {
      el.play().then(() => setTestPlaybackPaused(false)).catch(() => {});
    } else {
      el.pause();
      setTestPlaybackPaused(true);
    }
  }, [testRecordedBlob]);

  const resetTestPlayback = useCallback(() => {
    if (testObjectUrlRef.current) {
      URL.revokeObjectURL(testObjectUrlRef.current);
      testObjectUrlRef.current = null;
    }
    if (testAudioRef.current) {
      testAudioRef.current.pause();
      testAudioRef.current.src = "";
    }
    setTestRecordedUrl(null);
    setTestRecordedBlob(null);
    setTestPlaybackPaused(true);
  }, []);

  useEffect(() => {
    const prev = testObjectUrlRef.current;
    testObjectUrlRef.current = testRecordedUrl;
    return () => {
      if (prev) URL.revokeObjectURL(prev);
    };
  }, [testRecordedUrl]);

  useEffect(() => {
    const el = testAudioRef.current;
    if (!el) return;
    el.onended = () => setTestPlaybackPaused(true);
    el.onpause = () => setTestPlaybackPaused(true);
    el.onplay = () => setTestPlaybackPaused(false);
    return () => {
      el.onended = null;
      el.onpause = null;
      el.onplay = null;
    };
  }, [testRecordedBlob]);

  const handleSaveProfile = async () => {
    if (!api) return;
    setAccountError("");
    setAccountLoading(true);
    try {
      await api.updateProfile(displayName.trim() || undefined, avatarEmoji || undefined);
      onProfileSaved?.();
    } catch (e) {
      setAccountError(e?.message || "Failed to save");
    } finally {
      setAccountLoading(false);
    }
  };

  const handleAvatarFile = async (e) => {
    const file = e.target?.files?.[0];
    if (!file || !api) return;
    setAccountError("");
    setAccountLoading(true);
    try {
      await api.uploadAvatar(file);
      onProfileSaved?.();
      setAvatarFileInputKey((k) => k + 1);
    } catch (err) {
      setAccountError(err?.message || "Upload failed");
    } finally {
      setAccountLoading(false);
    }
  };

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") onClose();
  };

  const avatarUrl = user?.avatar_url && baseUrl ? `${baseUrl.replace(/\/$/, "")}${user.avatar_url}` : null;

  return (
    <div className={styles.backdrop} onMouseDown={handleBackdrop} onKeyDown={handleKeyDown} role="dialog" aria-modal="true">
      <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.sidebar}>
          <h2 className={styles.sidebarTitle}>Settings</h2>
          <nav className={styles.nav}>
            <button
              type="button"
              className={`${styles.navItem} ${category === "Audio" ? styles.navItemActive : ""}`}
              onClick={() => setCategory("Audio")}
            >
              Audio
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${category === "Video" ? styles.navItemActive : ""}`}
              onClick={() => setCategory("Video")}
            >
              Video
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${category === "Account" ? styles.navItemActive : ""}`}
              onClick={() => setCategory("Account")}
            >
              Account
            </button>
          </nav>
        </div>
        <div className={styles.main}>
          <div className={styles.content}>
          {category === "Audio" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Audio</h3>
              <div className={styles.twoCol}>
                <div className={styles.field}>
                  <label className={styles.label}>Output device</label>
                  <select
                    className={styles.select}
                    value={audioOutputId}
                    onChange={handleAudioOutputChange}
                    aria-label="Audio output device"
                  >
                    <option value="">Default</option>
                    {audioOutputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Input device</label>
                  <select
                    className={styles.select}
                    value={audioInputId}
                    onChange={handleAudioInputChange}
                    aria-label="Audio input device"
                  >
                    <option value="">Default</option>
                    {audioInputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={styles.testMic}>
                <span className={styles.label}>Test microphone</span>
                <div className={styles.testMicRow}>
                  {!testRecordedBlob ? (
                    <>
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={testRecording ? stopTestRecord : startTestRecord}
                        disabled={audioInputs.length === 0}
                      >
                        {testRecording ? "Stop (max 10s)" : "Record"}
                      </button>
                      {testRecording && (
                        <span className={styles.testHint}>Recording… up to 10 seconds</span>
                      )}
                    </>
                  ) : (
                    <>
                      <button type="button" className={styles.primaryBtn} onClick={playTestPlayback}>
                        {testPlaybackPaused ? "Play" : "Pause"}
                      </button>
                      <button type="button" className={styles.secondaryBtn} onClick={resetTestPlayback}>
                        Record again
                      </button>
                    </>
                  )}
                </div>
                {testRecordedBlob && testRecordedUrl && (
                  <audio
                    ref={testAudioRef}
                    src={testRecordedUrl}
                    controls
                    className={styles.testAudio}
                  />
                )}
              </div>
            </div>
          )}

          {category === "Video" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Video</h3>
              <div className={styles.field}>
                <label className={styles.label}>Camera</label>
                <select
                  className={styles.select}
                  value={videoInputId}
                  onChange={handleVideoInputChange}
                  aria-label="Camera device"
                  disabled={videoPreviewActive}
                >
                  <option value="">Default</option>
                  {videoInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.videoPreviewSection}>
                <div className={styles.videoPreviewFrame}>
                  <video
                    ref={videoPreviewRef}
                    autoPlay
                    playsInline
                    muted
                    className={styles.videoPreview}
                  />
                </div>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={toggleVideoPreview}
                  disabled={videoPreviewActive}
                >
                  Preview
                </button>
                {videoPreviewActive && (
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={toggleVideoPreview}
                  >
                    Stop preview
                  </button>
                )}
              </div>
            </div>
          )}

          {category === "Account" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Account</h3>
              <div className={styles.accountRow}>
                <div className={styles.avatarWrap}>
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className={styles.avatarImg} />
                  ) : (
                    <span className={styles.avatarEmoji}>{user?.avatar_emoji || "🐱"}</span>
                  )}
                </div>
                <div className={styles.accountDetails}>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Username</span>
                    <span className={styles.detailValue}>{user?.username ?? "—"}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Email</span>
                    <span className={styles.detailValue}>—</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Display name</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Display name"
                    />
                  </div>
                </div>
              </div>
              <div className={styles.profilePictureSection}>
                <span className={styles.label}>Profile picture</span>
                <div className={styles.profilePictureRow}>
                  <label className={styles.fileLabel}>
                    <input
                      key={avatarFileInputKey}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      onChange={handleAvatarFile}
                      className={styles.fileInput}
                    />
                    Upload image
                  </label>
                  <span className={styles.hint}>or choose emoji</span>
                </div>
                <div className={styles.emojiGrid}>
                  {EMOJIS.map((e) => (
                    <button
                      type="button"
                      key={e}
                      className={`${styles.emojiBtn} ${avatarEmoji === e ? styles.emojiActive : ""}`}
                      onClick={() => setAvatarEmoji(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
              {accountError && <div className={styles.error}>{accountError}</div>}
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleSaveProfile}
                disabled={accountLoading}
              >
                {accountLoading ? "Saving…" : "Save profile"}
              </button>
            </div>
          )}
          </div>
        <button type="button" className={styles.closeBtn} onClick={onClose}>
          Close
        </button>
        </div>
      </div>
    </div>
  );
}
