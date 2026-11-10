import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { loadLogoWorkspaceBaseline } from "../../src/components/identity/use-logo-workspace";
import { syntheticLogoWorkspace } from "../fixtures/logo-creation";

describe("existing-brand logo entry", () => {
  it("loads an owned empty workspace as an uninitialized editable baseline without reads for an invented snapshot or writes", async () => {
    const workspace = syntheticLogoWorkspace(),
      account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 };
    const memory = createLogoDraftMemory();
    memory.bind({ ownerId: account.userId, generation: 1 });
    const requests: { path: string; method: string }[] = [];
    const client = createAccountLogoClient(
      account,
      workspace.projectId,
      () => true,
      () => undefined,
      async (path, options) => {
        requests.push({ path: String(path), method: options?.method ?? "GET" });
        return Response.json(workspace);
      },
    );
    const baseline = await loadLogoWorkspaceBaseline({
      client,
      account,
      projectId: workspace.projectId,
      memory,
      signal: new AbortController().signal,
    });
    expect(baseline?.workspace).toEqual(workspace);
    expect(baseline?.referenceSnapshot).toBeNull();
    expect(baseline?.stagePayloads).toEqual({});
    expect(baseline?.brief).toEqual({ name: "", activity: "", audience: "", personality: "", logoTypes: [] });
    expect(requests).toEqual([{ path: `/api/projects/${workspace.projectId}/logo`, method: "GET" }]);
    expect(memory.get(workspace.projectId)).toBeNull();
  });
});

import { createHash } from "node:crypto";
import { AccountLogoInitializationRejectedError } from "../../src/components/identity/account-logo-client";
import { serializeLogoInitialization } from "../../src/features/logo-creation/model/existing-brand";
import { logoFixtureId as id } from "../fixtures/logo-creation";

describe("initialization rejection proof", () => {
  const workspace = syntheticLogoWorkspace(),
    account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 };
  const input = {
    requestKey: id(810),
    expected: workspace.heads,
    brief: {
      name: "Élan & Co",
      activity: "Design",
      audience: "Founders",
      personality: "",
      logoTypes: ["wordmark" as const],
    },
  };
  it.each(["owner", "project", "key", "hash", "body"])(
    "does not treat a mismatched %s as proof that the pending original was rejected",
    async (field) => {
      const proof = {
        status: "rejected",
        ownerId: account.userId,
        projectId: workspace.projectId,
        requestKey: input.requestKey,
        inputHash: createHash("sha256").update(serializeLogoInitialization(input)).digest("hex"),
      };
      if (field === "owner") proof.ownerId = id(999);
      if (field === "project") proof.projectId = id(999);
      if (field === "key") proof.requestKey = id(999);
      if (field === "hash") proof.inputHash = "b".repeat(64);
      if (field === "body")
        proof.inputHash = createHash("sha256")
          .update(serializeLogoInitialization({ ...input, brief: { ...input.brief, name: "Another body" } }))
          .digest("hex");
      const client = createAccountLogoClient(
        account,
        workspace.projectId,
        () => true,
        () => undefined,
        async () =>
          Response.json({ error: { code: "conflict", message: "Not exact" }, rejection: proof }, { status: 409 }),
      );
      const error = await client.initializeExistingBrandLogo(input).catch((value) => value);
      expect(error).toMatchObject({ status: 409 });
      expect(error).not.toBeInstanceOf(AccountLogoInitializationRejectedError);
    },
  );
  it("recognizes only an exact authenticated original-body proof", async () => {
    const rejection = {
      status: "rejected",
      ownerId: account.userId,
      projectId: workspace.projectId,
      requestKey: input.requestKey,
      inputHash: createHash("sha256").update(serializeLogoInitialization(input)).digest("hex"),
    };
    const client = createAccountLogoClient(
      account,
      workspace.projectId,
      () => true,
      () => undefined,
      async () => Response.json({ error: { code: "conflict", message: "Rejected" }, rejection }, { status: 409 }),
    );
    const error = await client.initializeExistingBrandLogo(input).catch((value) => value);
    expect(error).toBeInstanceOf(AccountLogoInitializationRejectedError);
    expect(error.rejection).toEqual(rejection);
  });
});
