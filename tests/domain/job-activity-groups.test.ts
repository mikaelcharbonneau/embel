import { describe, expect, it } from "vitest";
import {
  activityTimeAgo,
  groupJobActivity,
  jobActionLabel,
  jobActivityDetail,
  jobActivitySummary,
  splitJobActivity,
  type JobActivityEntry,
  type JobActivityGroup,
} from "@/domain/job-activity";
import { operationSchema } from "@/domain/providers";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const kestrel = "cccccccc-cccc-4ccc-8ccc-000000000001";
const maison = "cccccccc-cccc-4ccc-8ccc-000000000002";
let serial = 0;
function job(
  state: JobActivityEntry["state"],
  operation: JobActivityEntry["operation"],
  createdAt: string,
  projectId = kestrel,
): JobActivityEntry {
  const finished = ["succeeded", "failed", "partial", "cancelled"].includes(state);
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(++serial).padStart(12, "0")}`,
    ownerId: owner,
    projectId,
    projectTitle: projectId === kestrel ? "Kestrel Analytics" : "Maison Aurélie",
    operation,
    state,
    progress: 0,
    createdAt,
    finishedAt: finished ? createdAt : null,
  };
}
const at = (minute: number, second = 0) =>
  `2026-11-13T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
const six = (state: JobActivityEntry["state"] = "succeeded", minute = 0) =>
  Array.from({ length: 6 }, (_, index) => job(state, "identity.logo_concept", at(minute, index)));
const titles = (groups: JobActivityGroup[]) => groups.map((group) => `${group.projectTitle} · ${group.label}`);

describe("groupJobActivity", () => {
  it("turns one click's six concept requests into one action", () => {
    const groups = groupJobActivity({ active: [], recent: six() });
    expect(titles(groups)).toEqual(["Kestrel Analytics · Six logo concepts"]);
    expect(groups[0]!.jobs).toHaveLength(6);
    expect(groups[0]!.status).toBe("done");
    expect(groups[0]!.href).toBe(`/brands/account/${kestrel}/logo`);
  });

  it("keeps different projects, different kinds of work and later clicks apart", () => {
    const groups = groupJobActivity({
      active: [],
      recent: [
        ...six("succeeded", 0),
        job("succeeded", "identity.logo_concept", at(5)),
        job("succeeded", "identity.logo_concept", at(0, 30), maison),
        job("succeeded", "naming.generate", at(0, 40)),
      ],
    });
    expect(titles(groups)).toEqual([
      "Kestrel Analytics · One logo concept",
      "Kestrel Analytics · Names",
      "Maison Aurélie · One logo concept",
      "Kestrel Analytics · Six logo concepts",
    ]);
  });

  it("measures the two-minute window from an action's first request", () => {
    const groups = groupJobActivity({
      active: [],
      recent: [
        job("succeeded", "identity.image", at(0)),
        job("succeeded", "identity.image", at(1, 30)),
        job("succeeded", "identity.image", at(2, 30)),
      ],
    });
    expect(groups.map((group) => group.jobs.length)).toEqual([1, 2]);
  });

  it("counts a request once when it appears in both lists, keeping the active observation", () => {
    const running = job("running", "identity.logo_refine", at(3));
    const groups = groupJobActivity({ active: [running], recent: [{ ...running, state: "queued" }] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.status).toBe("running");
    expect(groups[0]!.label).toBe("Logo change");
  });

  it("marks an action failed if any request failed, running if any is still working", () => {
    const mixed = [...six("succeeded").slice(0, 5), job("failed", "identity.logo_concept", at(0, 9))];
    expect(groupJobActivity({ active: [], recent: mixed })[0]!.status).toBe("failed");
    const working = [job("running", "identity.image", at(1)), job("succeeded", "identity.image", at(1, 1))];
    expect(groupJobActivity({ active: [working[0]!], recent: [working[1]!] })[0]!.status).toBe("running");
    const unconfirmed = job("needs_reconciliation", "naming.generate", at(2));
    expect(groupJobActivity({ active: [unconfirmed], recent: [] })[0]!.status).toBe("unconfirmed");
    const stopped = [job("cancelled", "identity.image", at(4)), job("succeeded", "identity.image", at(4, 1))];
    expect(groupJobActivity({ active: [], recent: stopped })[0]!.status).toBe("stopped");
    expect(groupJobActivity({ active: [], recent: [job("partial", "strategy.audience", at(5))] })[0]!.status).toBe(
      "partial",
    );
  });

  it("drops the count of an action the list's limit may have cut off", () => {
    const recent = [
      ...Array.from({ length: 18 }, (_, index) => job("succeeded", "strategy.audience", at(10 + index))),
      job("succeeded", "identity.logo_concept", at(0, 4)),
      job("succeeded", "identity.logo_concept", at(0, 5)),
    ];
    const groups = groupJobActivity({ active: [], recent });
    const concepts = groups.find((group) => group.operation === "identity.logo_concept")!;
    expect(concepts.complete).toBe(false);
    expect(concepts.label).toBe("Logo concepts");
  });

  it("puts running and failed actions first, newest first", () => {
    const groups = groupJobActivity({
      active: [job("running", "identity.logo_refine", at(30))],
      recent: [
        job("failed", "identity.image", at(20), maison),
        ...six("succeeded", 25),
        job("succeeded", "naming.generate", at(5), maison),
      ],
    });
    const { attention, finished } = splitJobActivity(groups);
    expect(titles(attention)).toEqual([
      "Kestrel Analytics · Logo change",
      "Maison Aurélie · Three creative directions",
    ]);
    expect(titles(finished)).toEqual(["Kestrel Analytics · Six logo concepts", "Maison Aurélie · Names"]);
  });
});

describe("plain words", () => {
  it("names every kind of work without the engine's names", () => {
    for (const operation of operationSchema.options) {
      expect(jobActionLabel(operation)).not.toMatch(/\.|_|identity|generation|refinement/i);
      expect(jobActionLabel(operation, 3)).toMatch(/^[A-Z]/);
    }
    expect(jobActionLabel("identity.logo_concept", 6)).toBe("Six logo concepts");
    expect(jobActionLabel("identity.image", 3)).toBe("Three creative directions");
    // One directions request makes three boards: the label never counts requests for it.
    expect(jobActionLabel("identity.logo_directions", 1)).toBe("Three creative directions");
    expect(jobActionLabel("identity.logo_refine", 1)).toBe("Logo change");
    expect(jobActionLabel("identity.logo_refine", 2)).toBe("Two logo changes");
    expect(jobActionLabel("naming.generate", 2)).toBe("Names");
    expect(jobActionLabel("strategy.competitors")).toBe("Competitors");
  });

  it.each([
    [[], "Nothing is running and nothing failed."],
    [["running"], "One thing is running and nothing failed."],
    [["running", "stopping", "done"], "Two things are running and nothing failed."],
    [["failed"], "Nothing is running and one failed."],
    [["running", "failed"], "One thing is running and one failed."],
    [["running", "running", "running", "failed", "failed"], "Three things are running and two failed."],
    [["unconfirmed"], "Nothing is running and nothing failed. One result couldn’t be confirmed."],
    [["failed", "unconfirmed", "unconfirmed"], "Nothing is running and one failed. Two results couldn’t be confirmed."],
  ] as const)("summarises %j truthfully", (statuses, sentence) => {
    expect(jobActivitySummary(statuses.map((status) => ({ status }) as JobActivityGroup))).toBe(sentence);
  });

  it("says when it happened and what went wrong", () => {
    const now = Date.parse(at(13));
    const [running] = groupJobActivity({ active: [job("running", "identity.logo_refine", at(12))], recent: [] });
    expect(jobActivityDetail(running!, now)).toBe("Started 1 minute ago");
    const [queued] = groupJobActivity({ active: [job("queued", "naming.generate", at(13))], recent: [] });
    expect(jobActivityDetail(queued!, now)).toBe("Waiting to start, just now");
    const [failed] = groupJobActivity({ active: [], recent: [job("failed", "identity.image", at(1))] });
    expect(jobActivityDetail(failed!, now)).toBe("Couldn’t be made, 12 minutes ago");
    const [some] = groupJobActivity({
      active: [],
      recent: [job("failed", "identity.image", at(1)), job("succeeded", "identity.image", at(0, 58))],
    });
    expect(jobActivityDetail(some!, now)).toBe("Some couldn’t be made, 12 minutes ago");
    const [done] = groupJobActivity({ active: [], recent: six("succeeded", 0) });
    expect(jobActivityDetail(done!, now)).toBe("12 minutes ago");
  });

  it("writes relative times people read", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(activityTimeAgo("2026-11-13T11:59:30Z", now)).toBe("just now");
    expect(activityTimeAgo("2026-11-13T11:00:00Z", now)).toBe("1 hour ago");
    expect(activityTimeAgo("2026-11-13T09:00:00Z", now)).toBe("3 hours ago");
    expect(activityTimeAgo("2026-11-12T11:00:00Z", now)).toBe("yesterday");
    expect(activityTimeAgo("2026-11-10T11:00:00Z", now)).toBe("3 days ago");
    expect(activityTimeAgo("2026-10-01T11:00:00Z", now)).toBe("Oct 1, 2026");
  });
});
