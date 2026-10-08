import { build } from "esbuild";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
const dir = new URL("../../../.tmp/trademark-preview/", import.meta.url);
await mkdir(dir, { recursive: true });
await copyFile(new URL("../../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2", import.meta.url), new URL("geist.woff2", dir));
await build({ entryPoints: [new URL("./fixture.tsx", import.meta.url).pathname], bundle: true, external: ["/geist.woff2"], outdir: dir.pathname, platform: "browser", sourcemap: false, tsconfig: new URL("../../../tsconfig.json", import.meta.url).pathname });
await writeFile(new URL("index.html", dir), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trademark fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const name = path === "/geist.woff2" ? "geist.woff2" : path === "/fixture.js" ? "fixture.js" : path === "/fixture.css" ? "fixture.css" : "index.html";
  try { response.setHeader("Content-Type", name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html"); response.end(await readFile(new URL(name, dir))); }
  catch { response.writeHead(404).end(); }
}).listen(3186, "127.0.0.1");
