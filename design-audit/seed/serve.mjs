#!/usr/bin/env node
// Starts the audit stack: the stand-in AI and the Embel app (next dev) on http://127.0.0.1:3105,
// wired to the local generation engine. Every AI click is answered by the stand-in, for free.
//
//   node design-audit/seed/serve.mjs            development server (hot reload)
//   node design-audit/seed/serve.mjs --prod     production build (next build + next start), see README
//
// Requires the local Supabase stack (npm run dev:up). Stop with Ctrl+C. Logs go to
// design-audit/.logs/. seed.mjs starts this itself when nothing is listening yet.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { auditDir, auditStack } from "./stack.mjs";

export async function startAuditServers({ seeding = false, realImages = false, prod = false, quiet = false } = {}) {
  const stack = auditStack();
  const root = path.resolve(auditDir, "..");
  const logs = path.join(auditDir, ".logs");
  mkdirSync(logs, { recursive: true });
  const children = [];
  const env = { ...process.env, ...stack.appEnvironment };
  for (const key of Object.keys(env)) if (/^VERCEL(?:_|$)/u.test(key)) delete env[key];

  const launch = (name, args, extra = {}) => {
    const log = createWriteStream(path.join(logs, `${name}.log`), { flags: "a" });
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    if (!quiet) child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
    children.push(child);
    return child;
  };
  launch("stand-in-ai", [path.join(auditDir, "seed/stand-in-ai.mjs")], {
    AUDIT_SEEDING: seeding ? "1" : "0",
    AUDIT_REAL_IMAGES: realImages ? "1" : "0",
  });
  const next = path.join(root, "node_modules/next/dist/bin/next");
  const port = String(stack.settings.webPort);
  if (prod) {
    // A production build of the same code (writes the repository's .next/ build output, as
    // `npm run build` does). Known limit: in production mode the server refuses a plain-http
    // Supabase address, so /api/session and /api/account/profile answer 503 locally; see README.
    await new Promise((resolve, reject) => {
      const build = launch("next-build", [next, "build", "--webpack"], { NODE_ENV: "production" });
      build.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`next build failed (${code}); see .logs/next-build.log`)),
      );
    });
    launch("next", [next, "start", "--hostname", "127.0.0.1", "--port", port]);
  } else {
    launch("next", [next, "dev", "--hostname", "127.0.0.1", "--port", port], { NODE_ENV: "development" });
  }
  const stop = () => children.forEach((child) => child.kill("SIGTERM"));
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (stop(), process.exit(130)));

  const deadline = Date.now() + 300_000;
  for (const url of [`${stack.aiOrigin}/__health`, `${stack.appOrigin}/sign-in`]) {
    for (;;) {
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(60_000) })).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}; see design-audit/.logs/`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { stack, stop };
}

export async function listening(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prod = process.argv.includes("--prod");
  const stack = auditStack();
  if (await listening(`${stack.appOrigin}/sign-in`)) {
    console.error(`Something is already serving ${stack.appOrigin}. Stop it (for example npm run dev) first.`);
    process.exit(1);
  }
  console.log(prod ? "Building and starting the production build…" : "Starting the development server…");
  await startAuditServers({ prod });
  console.log(`Embel (audit stack) is ready: ${stack.appOrigin}`);
  console.log(`Stand-in AI: ${stack.aiOrigin}  (recipes: POST ${stack.aiOrigin}/__mode)`);
  console.log(`Local email inbox (Mailpit): http://127.0.0.1:${stack.settings.mailPort}`);
  console.log("Press Ctrl+C to stop.");
  await new Promise(() => {});
}
