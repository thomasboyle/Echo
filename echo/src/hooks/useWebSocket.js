import { useState, useCallback, useRef, useEffect } from "react";

const MAX_BACKOFF = 30000;
const INITIAL_BACKOFF = 1000;

export function useWebSocket(baseUrl, token) {
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState(null);
  const wsRef = useRef(null);
  const channelIdRef = useRef(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef(null);
  const callbacksRef = useRef({});

  const connect = useCallback(
    (channelId) => {
      if (!baseUrl || !token || !channelId) return;
      const url = baseUrl.replace(/^http/, "ws");
      const wsUrl = `${url}/ws/${channelId}?token=${encodeURIComponent(token)}`;
      channelIdRef.current = channelId;
      const doConnect = () => {
        if (channelIdRef.current !== channelId) return;
        setLastError(null);
        let hadOpened = false;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          hadOpened = true;
          setConnected(true);
          backoffRef.current = INITIAL_BACKOFF;
        };
        ws.onclose = () => {
          setConnected(false);
          if (wsRef.current === ws) wsRef.current = null;
          const cid = channelIdRef.current;
          if (cid === channelId && baseUrl && token && hadOpened) {
            reconnectTimerRef.current = setTimeout(() => {
              connect(cid);
              backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
            }, backoffRef.current);
          }
        };
        ws.onerror = () => setLastError("WebSocket error");
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            const cbs = callbacksRef.current;
            if (data.type === "message" && cbs.onMessage) cbs.onMessage(data);
            else if (data.type === "typing" && cbs.onTyping) cbs.onTyping(data);
            else if (data.type === "user_join" && cbs.onUserJoin) cbs.onUserJoin(data);
            else if (data.type === "user_leave" && cbs.onUserLeave) cbs.onUserLeave(data);
          } catch (_) {}
        };
      };
      if (wsRef.current) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        const prev = wsRef.current;
        prev.onclose = () => {
          setConnected(false);
          if (wsRef.current === prev) wsRef.current = null;
          doConnect();
        };
        prev.close();
      } else {
        doConnect();
      }
    },
    [baseUrl, token]
  );

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    channelIdRef.current = null;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  const sendMessage = useCallback((content, attachments = []) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "message", content: content || "", attachments: attachments || [] }));
    }
  }, []);

  const sendTyping = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "typing" }));
    }
  }, []);

  const setCallbacks = useCallback((cbs) => {
    const ref = callbacksRef.current;
    for (const k of Object.keys(cbs)) ref[k] = cbs[k];
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  return {
    connected,
    lastError,
    connect,
    disconnect,
    sendMessage,
    sendTyping,
    setCallbacks,
  };
}

const NOTIFICATIONS_BACKOFF = 5000;

export function useNotificationsWebSocket(baseUrl, token, onMessageRef) {
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  useEffect(() => {
    if (!baseUrl || !token) return;
    const url = baseUrl.replace(/^http/, "ws");
    const wsUrl = `${url}/ws/notifications?token=${encodeURIComponent(token)}`;
    let hadOpened = false;
    const doConnect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => { hadOpened = true; };
      ws.onclose = () => {
        wsRef.current = null;
        if (hadOpened && baseUrl && token) {
          reconnectTimerRef.current = setTimeout(doConnect, NOTIFICATIONS_BACKOFF);
        }
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "message" && onMessageRef?.current) onMessageRef.current(data);
        } catch (_) {}
      };
    };
    doConnect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [baseUrl, token]);
}
