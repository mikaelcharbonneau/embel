import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(script: string, options: import("node:worker_threads").WorkerOptions) {
        super(
          `if ('EMBEL_SYNTHETIC_PARSER_SECRET' in process.env || 'NODE_OPTIONS' in process.env || process.execArgv.length) throw Error('Unexpected parser authority');\n` +
            script,
          options,
        );
      }
    },
  };
});
import { inspectFontBytes } from "../../src/features/identity-directions/server/font-inspection";
import { listFreeFontCatalog, readFreeCatalogFont } from "../../src/features/identity-directions/server/fonts";

describe("actual font-parser worker authority boundary", () => {
  it("inspects a real font without inheriting parent secrets, loader flags or NODE_OPTIONS", async () => {
    vi.stubEnv("EMBEL_SYNTHETIC_PARSER_SECRET", "synthetic-inert-value");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    try {
      const catalog = await listFreeFontCatalog(),
        font = await readFreeCatalogFont(catalog[0]!.id);
      const result = await inspectFontBytes(font.bytes, font.mimeType);
      expect(result.family).toBe(font.family);
      expect(result.codePoints).toContain(65);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
