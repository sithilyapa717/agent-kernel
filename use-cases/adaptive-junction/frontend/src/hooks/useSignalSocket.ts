import { useEffect, useRef, useState } from "react";
import type { SignalSnapshot } from "../types";
import { fetchSignal, wsUrl } from "../api";

export function useSignalSocket() {
  const [snapshot, setSnapshot] = useState<SignalSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;

    async function bootstrap() {
      try {
        const snap = await fetchSignal();
        if (!closed) setSnapshot(snap);
      } catch {
        /* backend may still be starting */
      }
    }

    function connect() {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
        pingTimer = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
        }, 15000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") setSnapshot(msg.data);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (pingTimer) window.clearInterval(pingTimer);
        const delay = Math.min(5000, 500 * 2 ** retryRef.current);
        retryRef.current += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    }

    bootstrap();
    connect();

    return () => {
      closed = true;
      if (pingTimer) window.clearInterval(pingTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { snapshot, connected };
}
