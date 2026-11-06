import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const apiOrigin = process.env.KEEL_API_UPSTREAM ?? process.env.KEEL_API_ORIGIN ?? "http://127.0.0.1:4101";
const port = Number(process.env.KEEL_LISTEN_PORT || new URL(process.env.KEEL_WEB_ORIGIN ?? "http://127.0.0.1:4100").port || 4100);
const proxies = ["/session", "/boards", "/cards", "/search", "/teams", "/users", "/health", "/ready", "/otel", "/pulse"];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function proxied(pathname) {
  return proxies.some((item) => pathname === item || pathname.startsWith(`${item}/`));
}

function sendFile(res, file) {
  res.statusCode = 200;
  res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
  if (file.endsWith(".html")) res.setHeader("cache-control", "no-store");
  createReadStream(file).pipe(res);
}

function proxy(req, res) {
  const target = new URL(req.url ?? "/", apiOrigin);
  const headers = { ...req.headers, host: target.host };
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("The API is unavailable.");
  });
  req.pipe(upstream);
}

createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const accept = String(req.headers.accept ?? "");
  if (pathname.startsWith("/assets/")) {
    const relative = decodeURIComponent(pathname.replace(/^\/+/, ""));
    const file = path.resolve(root, relative);
    const base = `${path.resolve(root)}${path.sep}`;
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("Not found.");
      return;
    }
    sendFile(res, file);
    return;
  }
  if (accept.includes("text/html")) {
    sendFile(res, path.join(root, "index.html"));
    return;
  }
  if (proxied(pathname)) {
    proxy(req, res);
    return;
  }
  sendFile(res, path.join(root, "index.html"));
}).listen(port, "0.0.0.0", () => {
  console.log(`web http://127.0.0.1:${port}`);
});
