import { describe, expect, it, vi } from "vitest";
const factories = vi.hoisted(() => ({ concept: vi.fn(), refine: vi.fn(), vector: vi.fn(), directions: vi.fn(), exports: vi.fn() }));
vi.mock("../../worker/handlers/logo-concepts", () => ({ createLogoConceptHandler: factories.concept }));
vi.mock("../../worker/handlers/logo-refinements", () => ({ createLogoRefinementHandler: factories.refine }));
vi.mock("../../worker/logo-vector/handler", () => ({ createLogoVectorHandler: factories.vector }));
vi.mock("../../worker/handlers/logo-directions", () => ({ createLogoDirectionsHandler: factories.directions }));
vi.mock("../../worker/handlers/logo-exports", () => ({ createLogoExportsHandler: factories.exports }));
import { createLogoOperationComposition, type LogoOperationCompositionInput } from "../../worker/logo-operation-composition";
const empty = (): LogoOperationCompositionInput => ({ concepts: null, refinements: null, vector: null, directions: null, exports: null, unavailableReasons: {} });
describe("explicit logo worker composition", () => {
  it("keeps every absent adapter unavailable without creating handlers or dispatching work", () => {
    vi.clearAllMocks();
    const result = createLogoOperationComposition(empty());
    expect(result.handlers.size).toBe(0);
    expect(Object.values(result.capabilities)).toHaveLength(5);
    expect(Object.values(result.capabilities).every(value => value.status === "unavailable")).toBe(true);
    for (const factory of Object.values(factories)) expect(factory).not.toHaveBeenCalled();
  });
  it("registers only its exact injected operation and does not execute any steps", () => {
    vi.clearAllMocks();
    const steps = vi.fn(), dependencies = {} as NonNullable<LogoOperationCompositionInput["vector"]>;
    const handler = { steps }; factories.vector.mockReturnValueOnce(handler);
    const result = createLogoOperationComposition({ ...empty(), vector: dependencies });
    expect([...result.handlers.keys()]).toEqual(["identity.logo_vectorize"]);
    expect(result.handlers.get("identity.logo_vectorize")).toBe(handler);
    expect(result.capabilities["identity.logo_vectorize"]).toEqual({ status: "available" });
    expect(factories.vector).toHaveBeenCalledWith(dependencies); expect(steps).not.toHaveBeenCalled();
    expect(factories.concept).not.toHaveBeenCalled(); expect(factories.refine).not.toHaveBeenCalled();
  });
  it("fails closed on unsupported export runtime without leaking errors or substituting a provider", () => {
    vi.clearAllMocks(); factories.exports.mockImplementationOnce(() => { throw new Error("private details"); });
    const result = createLogoOperationComposition({ ...empty(), exports: {} as NonNullable<LogoOperationCompositionInput["exports"]> });
    expect(result.handlers.size).toBe(0);
    expect(result.capabilities["identity.logo_export"].status).toBe("unavailable");
    expect(JSON.stringify(result.capabilities)).not.toContain("private details");
    expect(factories.concept).not.toHaveBeenCalled();
  });
  it("retains explicit missing-configuration reasons without enabling capabilities", () => {
    const result = createLogoOperationComposition({ ...empty(), unavailableReasons: { "identity.logo_concept": "Image access is not configured." } });
    expect(result.capabilities["identity.logo_concept"]).toEqual({ status: "unavailable", reason: "Image access is not configured." });
  });
});
