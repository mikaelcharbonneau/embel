import { createRoot } from "react-dom/client";
import { useState } from "react";
import { HandlesWorkspace } from "@/features/handles-workspace/handles-workspace";
import { fixtureHandleNames } from "@/features/handles-workspace/fixtures";
import { emptyHandlesState, type HandlesState } from "@/features/handles-workspace/domain";

function Preview() {
  const [state, setState] = useState<HandlesState>(emptyHandlesState());
  return <><aside style={{ marginBottom: 20, fontSize: 12 }}>Handles isolated fixture. No accounts, platforms or backend connected.</aside><HandlesWorkspace value={state} onChange={setState} importedNames={fixtureHandleNames} storageNote="Fixture session only. No persistent storage." /><output id="fixture-state" hidden>{JSON.stringify(state)}</output></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
