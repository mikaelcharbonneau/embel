import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { emptyHandlesState, type HandlesState } from "@/features/handles-workspace/domain";
import type { HandleCheckAdapter } from "@/features/handles-workspace/adapters";

let round = 0;
const adapter: HandleCheckAdapter = {
  availability: "ready", label: "Synthetic results fixture, no provider",
  async check(entry) {
    const now = new Date().toISOString();
    const outcome = round > 0 ? "profile_missing" : entry.handle === "morrowhq" ? "confirmed_available" : entry.platform === "instagram" ? "taken" : "profile_missing";
    return { ...entry, outcome, authority: outcome === "profile_missing" ? "public_profile" : "authorized_service", source: "Synthetic results fixture", sourceUrl: "https://example.test/fixture", method: "Synthetic browser check", checkedAt: now, observedAt: now, detail: "Fixture only, no network call" };
  },
};
function Preview() {
  const [state, setState] = useState<HandlesState>(emptyHandlesState());
  return <><button type="button" onClick={() => { round++; }}>Next fixture round</button><HandlesWorkspace adapter={adapter} value={state} onChange={setState} storageNote="Synthetic results fixture only" /><output id="fixture-state" hidden>{JSON.stringify(state)}</output></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
