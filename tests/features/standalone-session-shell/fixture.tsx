import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { StandaloneProjectPicker, type StandaloneProjectSelection } from "@/components/tools/standalone-project-picker";
import { ToolWorkspace, type ToolName } from "@/components/workspace/tool-workspace";
import { emptyDomainDraft } from "@/features/domain-workspace/draft";

type Harness = {
  refresh: () => void;
  expire: () => void;
  seed: (text: string, pending?: boolean) => boolean;
  remember: () => void;
  lateSet: () => { accepted: boolean; current: boolean };
  beforeUnload: () => boolean;
  snapshot: () => { status: string; generation: number; owner: string | null; dirty: boolean; visible: unknown };
};
declare global { interface Window { standaloneShellFixture: Harness } }

function Fixture() {
  const account = useAccountSession();
  const { session, standaloneDrafts } = account;
  const [result, setResult] = useState("");
  const [tool, setTool] = useState<ToolName>((new URL(location.href).searchParams.get("tool") as ToolName) ?? "domains");
  const [project, setProject] = useState<StandaloneProjectSelection | null>(null);
  const remembered = useRef<VerifiedAccount | null>(null);
  const [originalMemory] = useState(standaloneDrafts);
  const dirty = useSyncExternalStore(standaloneDrafts.subscribe, standaloneDrafts.hasUnsaved, () => false);
  const record = useSyncExternalStore(standaloneDrafts.subscribe, () => session.status === "ready" ? standaloneDrafts.get(session, "domains") : null, () => null);
  const fixture = new URL(location.href).searchParams.get("fixture") ?? "session";

  useEffect(() => {
    const draft = (text: string, pending = false) => {
      const payload = emptyDomainDraft(text);
      return { workspace: null, payload, imports: [], dirty: !pending, conflict: false,
        pending: pending ? { requestKey: "eeeeeeee-1111-4111-8111-111111111111", expectedRevision: 0, payload, imports: [] } : null };
    };
    window.standaloneShellFixture = {
      refresh: account.refresh,
      expire: () => { if (session.status === "ready") account.expire(session); },
      seed: (text, pending) => session.status === "ready" && standaloneDrafts.set(session, "domains", draft(text, pending)),
      remember: () => { remembered.current = session.status === "ready" ? session : null; },
      lateSet: () => ({ accepted: remembered.current ? standaloneDrafts.set(remembered.current, "domains", draft("late private result")) : false,
        current: remembered.current ? account.isCurrent(remembered.current) : false }),
      beforeUnload: () => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      },
      snapshot: () => ({ status: session.status, generation: session.generation, owner: session.status === "ready" ? session.userId : null,
        dirty: standaloneDrafts.hasUnsaved(), visible: session.status === "ready" ? standaloneDrafts.get(session, "domains") : null }),
    };
  }, [account, session, standaloneDrafts]);

  return <>
    <aside aria-label="Synthetic fixture controls" style={{ padding: 8, borderBottom: "1px solid #ccc" }}>
      <output id="session-status">{session.status}</output><output id="generation">{session.generation}</output>
      <output id="unsaved">{String(dirty)}</output><output id="same-memory">{String(originalMemory === standaloneDrafts)}</output>
      <output id="visible-draft">{record ? JSON.stringify(record.payload) : "hidden"}</output>
      <button onClick={account.refresh}>Fixture check account</button>
      <button onClick={() => void account.signOut().then(value => setResult(JSON.stringify(value)))}>Fixture sign out</button>
      <button onClick={() => void account.signOut(true).then(value => setResult(JSON.stringify(value)))}>Fixture discard and sign out</button>
      <button onClick={() => void account.signIn(async () => { throw new Error("Synthetic sign-in failure"); }).then(value => setResult(JSON.stringify(value)))}>Fixture failed sign in</button>
      <output id="signout-result">{result}</output>
      {fixture === "tools" && (["domains", "handles", "trademarks", "names", "ideas", "assets", "settings"] as const).map(value => <button key={value} onClick={() => setTool(value)}>Fixture open {value}</button>)}
    </aside>
    {fixture === "picker" && <><StandaloneProjectPicker selectedProjectId={project?.id} onSelect={setProject} /><output id="selected-project">{project?.id ?? "none"}</output></>}
    {fixture === "tools" && <ToolWorkspace tool={tool} />}
  </>;
}

createRoot(document.getElementById("root")!).render(<AccountSessionProvider><Fixture /></AccountSessionProvider>);
