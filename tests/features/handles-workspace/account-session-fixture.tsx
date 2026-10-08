import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { createStandaloneDraftMemory } from "@/components/tools/standalone-draft-memory";

export const ownerA = "00000000-0000-4000-8000-00000000000a";
export const ownerB = "00000000-0000-4000-8000-00000000000b";
type Session = { status: "ready"; userId: string; generation: number } | { status: "checking"; generation: number };
const FixtureContext = createContext<{
  session: Session; isCurrent: (account: { userId: string; generation: number }) => boolean;
  expire: (account: { userId: string; generation: number }) => void;
  memory: ReturnType<typeof createStandaloneDraftMemory>;
} | null>(null);

/** Synthetic auth boundary only; real shared hook/client/memory and editors are mounted. */
export function AccountFixtureProvider({ children }: { children: ReactNode }) {
  const initial: Session = { status: "ready", userId: ownerA, generation: 1 };
  const [session, setSession] = useState<Session>(initial);
  const current = useRef<Session>(initial);
  const [memory] = useState(() => { const result = createStandaloneDraftMemory(); result.bind(initial); return result; });
  const isCurrent = (account: { userId: string; generation: number }) => current.current.status === "ready" && current.current.userId === account.userId && current.current.generation === account.generation;
  function publish(owner: string | null) {
    const next: Session = owner ? { status: "ready", userId: owner, generation: current.current.generation + 1 } : { status: "checking", generation: current.current.generation + 1 };
    current.current = next;
    memory.bind(next.status === "ready" ? next : null);
    setSession(next);
  }
  return <FixtureContext.Provider value={{ session, memory, isCurrent, expire: account => { if (isCurrent(account)) publish(null); } }}>
    <nav aria-label="Synthetic account controls"><button type="button" onClick={() => publish(ownerA)}>Verify owner A</button><button type="button" onClick={() => publish(ownerB)}>Verify owner B</button><button type="button" onClick={() => publish(null)}>Hide account</button></nav>
    {children}
  </FixtureContext.Provider>;
}

export function useAccountSession() {
  const context = useContext(FixtureContext);
  if (!context) throw new Error("Synthetic account provider required");
  return context;
}
export function AccountStatus() { return <p role="status">Account content is hidden while verification is pending.</p>; }
