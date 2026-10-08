import { createEntry, declareAccountCreated, type HandleNameSource, type HandlesState } from "./domain";

// Synthetic fixture only; never loaded by HandlesWorkspace or its public barrel.
export const fixtureHandleNames: HandleNameSource[] = [
  { id: "fixture-project", name: "Morrow", origin: "project", projectId: "fixture-brand", projectTitle: "Morrow · fixture" },
  { id: "fixture-name", name: "Daylight", origin: "names", projectId: null, projectTitle: null },
];
export const fixtureHandlesState: HandlesState = { version: 1, bundles: [{
  id: "fixture-bundle", title: "Morrow launch · fixture", list: "Launch shortlist", source: fixtureHandleNames[0]!, savedAt: "2026-10-05T12:00:00Z",
  entries: [
    { ...createEntry("instagram", "morrowhq"), favorite: true },
    { ...createEntry("tiktok", "getmorrow"), selected: true },
    declareAccountCreated(createEntry("youtube", "morrow"), "https://www.youtube.com/@morrow", "2026-10-05T12:00:00Z"),
  ],
}] };
