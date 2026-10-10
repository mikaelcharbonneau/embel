import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TrademarkWorkspace } from "../../../src/features/trademark-workspace/trademark-workspace";
import { createTrademarkDraft, serializeTrademarkDraftPreview } from "../../../src/features/trademark-workspace/domain";
import "../../../src/styles/globals.css";
import "../../../src/styles/trademarks-guided.css";
import "./fixture.css";

function Fixture() {
  const [draft, setDraft] = useState(createTrademarkDraft());
  const [output, setOutput] = useState("");
  const failure = new URLSearchParams(location.search).has("fail");
  return <main><p style={{ padding: 16 }}>Synthetic trademark fixture. No persistence or research.</p><TrademarkWorkspace draft={draft} onChange={setDraft} onExportPreview={location.search.includes("disconnected") ? undefined : (preview) => { if (failure) throw new Error("Fixture failure"); setOutput(serializeTrademarkDraftPreview(preview)); }} onCreateBrand={(seed) => setOutput(JSON.stringify(seed))} /><output hidden aria-label="Fixture callback output" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{output}</output></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
