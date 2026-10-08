import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AccountFixtureProvider, useAccountSession } from "./account-session-fixture";
import { HandlesAccountEditor } from "@/components/tools/handles-account-editor";
import { TrademarkAccountEditor } from "@/components/tools/trademark-account-editor";

function Workspace() {
  const { memory } = useAccountSession();
  const [tool, setTool] = useState<"handles" | "trademarks">("handles");
  const project = { importProjectId: "00000000-0000-4000-8000-000000000010", importProjectTitle: "Fixture project" };
  return <><nav aria-label="Synthetic tools"><button type="button" onClick={() => setTool("handles")}>Handles fixture</button><button type="button" onClick={() => setTool("trademarks")}>Trademarks fixture</button></nav>{tool === "handles" ? <HandlesAccountEditor memory={memory} {...project} /> : <TrademarkAccountEditor memory={memory} {...project} />}</>;
}
createRoot(document.getElementById("root")!).render(<AccountFixtureProvider><Workspace /></AccountFixtureProvider>);
