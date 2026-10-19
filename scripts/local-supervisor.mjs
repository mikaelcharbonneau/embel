// Prototype process supervision only. Credentials stay in the existing closed
// child factories; operational events contain fixed labels and exit metadata.
const signals = new Set(["SIGTERM", "SIGINT", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGHUP", "SIGQUIT", "SIGBUS", "SIGILL", "SIGPIPE", "SIGALRM", "SIGUSR1", "SIGUSR2", "SIGTRAP", "SIGXCPU", "SIGXFSZ"]);
const backoff = [1_000, 2_000, 4_000];

export function superviseLocalPrototype({ startWorker, startWeb, onEvent, onExitCode }) {
  const live = new Set();
  let worker = null, stopping = false, attempts = 0, exitCode = 0;
  let retryTimer, shutdownTimer;
  const report = event => onEvent({ ...event, at: new Date().toISOString() });
  const settle = () => { if (stopping && !live.size) clearTimeout(shutdownTimer); };
  function stop(code = 0, signal = "SIGTERM") {
    if (stopping) return;
    stopping = true; exitCode = Math.max(exitCode, code); onExitCode(exitCode);
    clearTimeout(retryTimer);
    report({ event: "local_shutdown", signal });
    for (const child of [...live]) child.kill(signal);
    if (live.size) {
      shutdownTimer = setTimeout(() => {
        report({ event: "local_shutdown_forced" });
        for (const child of [...live]) child.kill("SIGKILL");
      }, 20_000);
      shutdownTimer.unref();
    }
  }
  function ended(role, child, code, signal, cause) {
    if (child && !live.delete(child)) return;
    if (role === "worker") worker = null;
    report({ event: "local_child_exit", role, code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
      signal: signal == null ? null : signals.has(signal) ? signal : "other", cause });
    if (stopping) { settle(); return; }
    if (role === "web") { stop(code || 1); return; }
    if (attempts === backoff.length) {
      exitCode = 1; onExitCode(exitCode);
      report({ event: "local_worker_unavailable", attempts });
      return;
    }
    const delayMs = backoff[attempts++];
    report({ event: "local_worker_restart", attempt: attempts, delayMs });
    retryTimer = setTimeout(() => { retryTimer = undefined; launch("worker", startWorker); }, delayMs);
  }
  function launch(role, start) {
    if (stopping || role === "worker" && worker) return;
    let child;
    try { child = start(); } catch { ended(role, null, null, null, "spawn_error"); return; }
    live.add(child);
    if (role === "worker") worker = child;
    child.once("exit", (code, signal) => ended(role, child, code, signal, "exit"));
    child.once("error", () => {
      if (child.pid === undefined) ended(role, child, null, null, "spawn_error");
      else { report({ event: "local_child_error", role }); stop(1); }
    });
  }
  launch("web", startWeb);
  launch("worker", startWorker);
  return { stop };
}
