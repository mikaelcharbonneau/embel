import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { readManagedTurnHistory, extractManagedFinalOutput } from "../../src/server/ai/naming-brain/history";

const session = { id: "sess_fixture", agent: { id: "agent_fixture" }, status: "idle", metadata: {}, required_actions: [], usage: null, environment: { type: "none" } };
const turn = { id: "turn_fixture", object: "agent.session.turn", session_id: "sess_fixture", agent_id: "agent_fixture", subagent_id: null, status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null };
const item = { id: "item_fixture", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: "turn_fixture", content: [{ type: "output_text", text: "Synthetic retained JSON" }] };
const page = (data: unknown[], has_more = false) => ({ object: "list", data, has_more, last_id: (data.at(-1) as { id?: string } | undefined)?.id ?? "cursor_fixture" });
function protocol(fixtures: Record<string, unknown>) {
  return createNamingManagedProtocol({ apiKey: "synthetic", fetch: async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.pathname.replace("/v1/agents/sessions/sess_fixture", "") + (url.searchParams.get("after") ? `?after=${url.searchParams.get("after")}` : "");
    if (!(key in fixtures)) throw new Error("Missing synthetic route");
    return new Response(JSON.stringify(fixtures[key]), { headers: { "content-type": "application/json" } });
  } });
}

describe("Managed session persisted evidence", () => {
  it("recovers complete item pages without treating idle as a successful turn", async () => {
    const failed = { ...turn, status: "failed", error: { code: "session_budget_exceeded", message: "Fixture" } };
    const client = protocol({ "": session, "/turns/turn_fixture": failed, "/turns/turn_fixture/items": page([item], true), "/turns/turn_fixture/items?after=item_fixture": page([{ ...item, id: "item_second", phase: "commentary", content: [] }]) });
    const saved = await readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal);
    expect(saved.turn?.status).toBe("failed");
    expect(saved.items.map(row => row.id)).toEqual(["item_fixture", "item_second"]);
  });

  it("discovers exactly one root turn when its acknowledgement was missed", async () => {
    const client = protocol({ "": session, "/turns": page([turn]), "/turns/turn_fixture/items": page([item]) });
    const saved = await readManagedTurnHistory(client, "sess_fixture", null, new AbortController().signal);
    expect(saved.turn?.id).toBe("turn_fixture");
    expect(saved.items[0]).toEqual(item);
  });

  it("does not invent item identifiers for SDK-supported legacy user messages", async () => {
    const user = { ...item, id: null, role: "user", phase: null, content: [{ type: "input_text", text: "Frozen synthetic input" }] };
    const client = protocol({ "": session, "/turns/turn_fixture": turn, "/turns/turn_fixture/items": page([user, item]) });
    const saved = await readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal);
    expect(saved.items).toEqual([item]);
  });

  it("uses the server cursor when the page ends with a nullable legacy user item", async () => {
    const user = { ...item, id: null, role: "user", phase: null, content: [{ type: "input_text", text: "Frozen synthetic input" }] };
    const client = protocol({ "": session, "/turns/turn_fixture": turn, "/turns/turn_fixture/items": page([user], true), "/turns/turn_fixture/items?after=cursor_fixture": page([item]) });
    expect((await readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal)).items).toEqual([item]);
  });

  it.each([
    { "": { ...session, id: "sess_foreign" } },
    { "": session, "/turns/turn_fixture": { ...turn, session_id: "sess_foreign" } },
    { "": session, "/turns/turn_fixture": { ...turn, subagent_id: "unapproved_child" } },
    { "": session, "/turns/turn_fixture": turn, "/turns/turn_fixture/items": page([{ ...item, turn_id: "turn_foreign" }]) },
  ])("rejects a mismatched session/turn/item or native child", async fixtures => {
    await expect(readManagedTurnHistory(protocol(fixtures), "sess_fixture", "turn_fixture", new AbortController().signal)).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("does not guess which turn belongs to an ambiguous multi-turn session", async () => {
    const client = protocol({ "": session, "/turns": page([turn, { ...turn, id: "turn_other" }]) });
    await expect(readManagedTurnHistory(client, "sess_fixture", null, new AbortController().signal)).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("rejects a changed completed item across pages", async () => {
    const client = protocol({ "": session, "/turns/turn_fixture": turn, "/turns/turn_fixture/items": page([item], true), "/turns/turn_fixture/items?after=item_fixture": page([{ ...item, content: [{ type: "output_text", text: "Forged replacement" }] }]) });
    await expect(readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal)).rejects.toMatchObject({ code: "history_conflict" });
  });

  it("accepts a completed non-commentary root message even when its optional phase is null", async () => {
    const final = { ...item, phase: null, content: [{ type: "output_text", text: '{"role":"creator","candidates":[]}' }] };
    const client = protocol({ "": session, "/turns/turn_fixture": turn, "/turns/turn_fixture/items": page([{ ...item, id: "commentary", phase: "commentary" }, final]) });
    const history = await readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal);
    expect(extractManagedFinalOutput(history)).toMatchObject({ itemId: "item_fixture", text: '{"role":"creator","candidates":[]}', value: { role: "creator", candidates: [] } });
  });

  it("does not promote a completed item from a failed turn or ambiguous final messages", async () => {
    for (const [status, items] of [["failed", [item]], ["completed", [item, { ...item, id: "second_final" }]]] as const) {
      const client = protocol({ "": session, "/turns/turn_fixture": { ...turn, status }, "/turns/turn_fixture/items": page([...items]) });
      const history = await readManagedTurnHistory(client, "sess_fixture", "turn_fixture", new AbortController().signal);
      expect(() => extractManagedFinalOutput(history)).toThrow(status === "failed" ? "turn_not_completed" : "final_output_invalid");
    }
  });
});
