import { expect, it } from "vitest";
import { createVisualDirectionMemory } from "@/features/identity-directions/components/visual-direction-memory";
import { visualOverview, visualOwner, visualProject } from "../fixtures/visual-direction";
it("retains private edits during same-owner rechecks and fences generations, owner replacement and late writes", () => {
  const memory = createVisualDirectionMemory(), account = { userId: visualOwner, generation: 1 }, base = visualOverview({ reviewed: true });
  const draft = { base, guidance: { ...base.current!.guidance, colors: "Deep blue" }, latest: null, mustReload: true };
  memory.bind(account); expect(memory.hasUnsaved()).toBe(false); memory.put(account, visualProject, draft); expect(memory.hasUnsaved()).toBe(true);
  memory.bind(null); expect(memory.get(account, visualProject)).toBeNull(); expect(memory.hasUnsaved()).toBe(true);
  const fresh = { ...account, generation: 2 }; memory.bind(fresh); expect(memory.get(fresh, visualProject)).toEqual(draft);
  memory.put(account, visualProject, null); expect(memory.hasUnsaved()).toBe(true);
  const other = { userId: visualProject, generation: 3 }; memory.bind(other); expect(memory.hasUnsaved()).toBe(false);
  memory.put(account, visualProject, draft); memory.put(other, visualProject, draft); expect(memory.hasUnsaved()).toBe(false);
});
