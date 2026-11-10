import { expect, it } from "vitest";
import { inferNamingLanguage, explicitNamingLanguage } from "@/domain/naming-language";
import { initialInferredNamingPreferences } from "@/domain/naming-language";
import { contextSnapshotSchema } from "@/domain/projects";
it("infers English and French without a separate question", () => {
  expect(inferNamingLanguage(["I want to create a brand for our new business"], "fr")).toBe("en");
  expect(inferNamingLanguage(["Je souhaite créer une marque pour aider les petites entreprises"], "en")).toBe("fr");
});
it("uses the latest explicit naming language over conversational inference", () => {
  expect(
    inferNamingLanguage(["Je souhaite créer une marque pour aider les entreprises. I want English names."], "fr"),
  ).toBe("en");
  expect(inferNamingLanguage(["Names in English", "Finalement, des noms en français"], "en")).toBe("fr");
  expect(explicitNamingLanguage("I do not want English names")).toBeNull();
});
it("keeps deterministic project context for mixed or insufficient input", () => {
  expect(inferNamingLanguage(["Gelato"], "it")).toBe("it");
  expect(inferNamingLanguage(["our brand for les petites entreprises avec nous"], "fr-CA")).toBe("fr-CA");
});
it("defaults new preferences from the brief and preserves explicit guidance", () => {
  const context = contextSnapshotSchema.parse({
    description: "Je souhaite créer une entreprise pour aider les familles",
    intake: { namingNotes: "Please suggest names in English" },
  });
  expect(initialInferredNamingPreferences(context).creativeLocale).toBe("en");
  expect(
    initialInferredNamingPreferences({ ...context, intake: { ...context.intake, namingNotes: "" } }).creativeLocale,
  ).toBe("fr");
});
it("honors French adjective requests and does not treat negated preferences as instructions", () => {
  expect(explicitNamingLanguage("Je veux des noms anglais")).toBe("en");
  expect(explicitNamingLanguage("Je souhaite des noms français")).toBe("fr");
  expect(explicitNamingLanguage("I do not want names in French")).toBeNull();
  expect(explicitNamingLanguage("Je ne veux pas de noms anglais")).toBeNull();
  expect(explicitNamingLanguage("Not names in French; names in English please")).toBe("en");
});
