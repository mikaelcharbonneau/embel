// Dedicated loopback-only fixture server; esbuild bundles actual workspace code.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url)), output = `${root}.tmp/logo-creation-browser`;
const startedAt = Date.now();
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/fixtures/logo-creation-workspace-preview.tsx`], outfile: `${output}/preview.js`, bundle: true, jsx: "automatic", platform: "browser", loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "warning" });
console.error(JSON.stringify({ event: "synthetic_logo_bundle_ready", elapsedMs: Date.now() - startedAt }));
const server = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'");
  if (request.url?.startsWith("/preview.js") || request.url?.startsWith("/preview.css")) {
    const ext = request.url.startsWith("/preview.js") ? "js" : "css";
    response.setHeader("content-type", ext === "js" ? "application/javascript" : "text/css"); response.end(await readFile(`${output}/preview.${ext}`));
  } else if (/^\/[A-Za-z0-9_-]+\.woff2$/.test(request.url ?? "")) {
    response.setHeader("content-type", "font/woff2"); response.end(await readFile(`${output}${request.url}`));
  } else if (/^\/(?:project-workspace|logo-concepts)\/[a-z-]+\.svg$/.test(request.url ?? "")) {
    try { response.setHeader("content-type", "image/svg+xml"); response.end(await readFile(`${root}public${request.url}`)); }
    catch { response.writeHead(404); response.end(); }
  } else if (request.url?.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{}'); }
  else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><title>Logo creation synthetic fixture</title></head><body><div id="root"></div><script src="/preview.js"></script></body></html>'); }
});
server.listen(3115, "127.0.0.1", () => console.error(JSON.stringify({ event: "synthetic_logo_server_ready", elapsedMs: Date.now() - startedAt })));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
