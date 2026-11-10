import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { appConfig } from "../../next.config";

// The web app starts two isolated helper processes from source files at run
// time (image checks and brand-board rendering). Vercel only ships the
// files listed for them in next.config.ts, so a helper that imports an unlisted
// file crashes on Vercel while working locally. That broke every image check from
// October 18 to November 10, 2026 (src/domain/logo-image-limits.ts was missing).
const HELPERS = ["src/server/image-process/process.ts", "src/features/identity-deliverables/server/render-process.mjs"];
// Every route group that may start a helper, including the engine's workflow steps.
const ROUTES = [
  "/api/home/**",
  "/api/projects/*/logo{,/**}",
  "/api/projects/*/identity{,/**}",
  "/api/assets/*/logo-export",
  "/.well-known/workflow/**",
];

async function localInputs(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
    tsconfig: "tsconfig.json",
    define: { __EMBEL_LOGO_RENDER_ENTRYPOINT__: "undefined" },
  });
  return Object.keys(result.metafile.inputs)
    .filter((path) => !path.startsWith("node_modules/"))
    .sort();
}

describe("files shipped for the isolated logo helpers", () => {
  const includes = appConfig.outputFileTracingIncludes ?? {};

  it.each(HELPERS)(
    "ships every repository file %s imports",
    async (entry) => {
      const needed = await localInputs(entry);
      expect(needed.length).toBeGreaterThan(0);
      for (const route of ROUTES) {
        const shipped = new Set(includes[route] ?? []);
        expect(
          needed.filter((path) => !shipped.has(path)),
          `${route} is missing files for ${entry}`,
        ).toEqual([]);
      }
    },
    60_000,
  );
});
