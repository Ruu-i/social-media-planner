import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Everything under /api goes to the Express server, so the browser sees one
    // origin and there is no CORS or cookie trouble in development.
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: true } },
  },
});
