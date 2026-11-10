// Test-only loopback server. Bundles the actual account editor without a build.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  output = `${root}.tmp/logo-vector-browser`;
await mkdir(output, { recursive: true });
await build({
  entryPoints: [`${root}tests/features/logo-vector/browser-preview.tsx`],
  outfile: `${output}/preview.js`,
  bundle: true,
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
});
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/preview.js") || request.url?.startsWith("/preview.css")) {
    const extension = request.url.startsWith("/preview.js") ? "js" : "css";
    response.setHeader("content-type", extension === "js" ? "application/javascript" : "text/css");
    response.end(await readFile(`${output}/preview.${extension}`));
  } else if (request.url?.startsWith("/api/")) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end("{}");
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}</style><title>Vector editor synthetic fixture</title></head><body><div id="root"></div><script src="/preview.js"></script></body></html>',
    );
  }
});
server.listen(3117, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
