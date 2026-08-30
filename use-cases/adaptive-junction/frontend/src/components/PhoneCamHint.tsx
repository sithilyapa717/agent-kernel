import { useEffect, useState } from "react";
import { fetchLan } from "../api";

const PHONE_PORT = 5174;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Chrome never shows a camera prompt on http://192.168… — phones must use HTTPS :5174. */
export function PhoneCamHint({ side }: { side?: string }) {
  const [ips, setIps] = useState<string[]>([]);
  const host = window.location.hostname;
  const insecureLan = !window.isSecureContext && !isLoopbackHost(host);
  const path = side ? `/capture/${side}` : window.location.pathname;
  const sameHostHttps = `https://${host}:${PHONE_PORT}${path.startsWith("/capture") ? path : `/capture/${side || "north"}`}`;

  useEffect(() => {
    fetchLan()
      .then((d) => setIps(d.ips || []))
      .catch(() => setIps([]));
  }, []);

  if (insecureLan) {
    return (
      <div className="lan-banner warn">
        <p>
          This <b>http://</b> Wi‑Fi address cannot ask for the camera. Open the HTTPS link on this
          phone:
        </p>
        <p>
          <a href={sameHostHttps}>{sameHostHttps}</a>
        </p>
        <p className="hint">
          Chrome: tap <b>Advanced</b> → <b>Proceed</b> (the cert is local). After the page loads,
          the camera permission popup appears. Then tap Allow.
        </p>
      </div>
    );
  }

  if (isLoopbackHost(host) && ips.length > 0) {
    const urls = ips.map((ip) => `https://${ip}:${PHONE_PORT}/capture/${side || "north"}`);
    return (
      <div className="lan-banner">
        <p>
          <b>Phone camera</b> (same Wi‑Fi). Do not use <code>http://</code> — the permission
          popup will never appear.
        </p>
        <ul>
          {urls.map((u) => (
            <li key={u}>
              <a href={u}>{u}</a>
            </li>
          ))}
        </ul>
        <p className="hint">
          On the phone: Advanced → Proceed (ignore the cert warning), then Allow camera.
        </p>
      </div>
    );
  }

  return null;
}
