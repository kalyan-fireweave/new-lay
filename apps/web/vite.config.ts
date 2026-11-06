import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fireweave } from "@fireweaveai/web-sdk/vite";

function apiOrigin(): string {
  try {
    const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    const line = text.split("\n").find((entry) => entry.startsWith("KEEL_API_ORIGIN="));
    return line?.slice("KEEL_API_ORIGIN=".length) || "http://127.0.0.1:4101";
  } catch {
    return "http://127.0.0.1:4101";
  }
}

function proxy(target: string) {
  return {
    target,
    changeOrigin: true,
    bypass(req: { headers: { accept?: string } }) {
      if (req.headers.accept?.includes("text/html")) return "/index.html";
    },
  };
}

const target = apiOrigin();

export default defineConfig({
  appType: "spa",
  plugins: [react(), fireweave()],
  server: {
    host: "127.0.0.1",
    port: 4100,
    strictPort: true,
    proxy: {
      "/session": proxy(target),
      "/boards": proxy(target),
      "/cards": proxy(target),
      "/search": proxy(target),
      "/teams": proxy(target),
      "/users": proxy(target),
      "/health": proxy(target),
      "/ready": proxy(target),
      "/otel": proxy(target),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
