import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

/** HTTPS-only UI for phones on Wi‑Fi. This PC should keep using HTTP :5173. */
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
