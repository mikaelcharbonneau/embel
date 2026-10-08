import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { unavailableHandleAdapter, type HandleCheckAdapter } from "@/features/handles-workspace/adapters";
import type { HandleEvidence } from "@/features/handles-workspace/domain";

type Request = { adapter: string; platform: string; signal?: AbortSignal; resolve: () => void };
const requests: Request[] = [];
declare global {
  interface Window { handlesRace: { snapshot: () => Array<{ adapter: string; platform: string; aborted: boolean }>; settle: (adapter: string) => Promise<void> } }
}
window.handlesRace = {
  snapshot: () => requests.map(request => ({ adapter: request.adapter, platform: request.platform, aborted: request.signal?.aborted ?? false })),
  async settle(adapter) {
    requests.find(request => request.adapter === adapter)?.resolve();
    // Flush the resolved adapter and the component's bounded continuation without arbitrary delays.
    await new Promise(resolve => setTimeout(resolve, 0));
  },
};
function fixtureAdapter(label: string): HandleCheckAdapter {
  let first = true;
  return { availability: "ready", label: `Synthetic adapter ${label}`, check(entry, signal) {
    const evidence = (): HandleEvidence => ({ ...entry, outcome: "confirmed_available", authority: "platform_api", source: `Synthetic source ${label}`, sourceUrl: null, method: "Delayed synthetic fixture response", checkedAt: new Date().toISOString(), observedAt: new Date().toISOString(), detail: "Synthetic fixture only; no platform was contacted." });
    if (first) {
      first = false;
      // Deliberately ignore abort so the workspace must fence the eventual response itself.
      return new Promise(resolve => requests.push({ adapter: label, platform: entry.platform, signal, resolve: () => resolve(evidence()) }));
    }
    requests.push({ adapter: label, platform: entry.platform, signal, resolve: () => undefined });
    return Promise.resolve(evidence());
  } };
}
const adapterA = fixtureAdapter("A"), adapterB = fixtureAdapter("B");
const adapterT: HandleCheckAdapter = { availability: "ready", label: "Synthetic deadline fixture", check(entry, signal) {
  if (entry.platform === "instagram") return Promise.resolve({ ...entry, outcome: "confirmed_available", authority: "platform_api", source: "Synthetic source T", sourceUrl: null, method: "Immediate synthetic fixture", checkedAt: new Date().toISOString(), observedAt: new Date().toISOString(), detail: "Fixture only" });
  return new Promise(resolve => requests.push({ adapter: "T", platform: entry.platform, signal, resolve: () => resolve({ ...entry, outcome: "confirmed_available", authority: "platform_api", source: "Synthetic source T", sourceUrl: null, method: "Late ignored abort fixture", checkedAt: new Date().toISOString(), observedAt: new Date().toISOString(), detail: "Fixture only" }) }));
} };
function Preview() {
  const [adapter, setAdapter] = useState(adapterA);
  return <><p>Adapter race regression fixture. No provider requests.</p><div><button onClick={() => setAdapter(unavailableHandleAdapter)}>Disconnect fixture adapter</button><button onClick={() => setAdapter(adapterB)}>Replace fixture adapter</button><button onClick={() => setAdapter(adapterT)}>Deadline fixture adapter</button></div><HandlesWorkspace adapter={adapter} /></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
