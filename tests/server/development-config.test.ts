import { describe, expect, it } from "vitest";
import { readDevelopmentConfiguration } from "../../src/server/development/config";

const environment = {
  NODE_ENV: "development", EMBEL_DEVELOPMENT_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", APP_ORIGIN: "http://127.0.0.1:3105",
};

describe("isolated development target", () => {
  it("requires explicit local development and distinct services", () => {
    expect(readDevelopmentConfiguration(environment)).toEqual({ supabaseUrl: environment.NEXT_PUBLIC_SUPABASE_URL, origin: environment.APP_ORIGIN });
    expect(readDevelopmentConfiguration({ ...environment, EMBEL_DEVELOPMENT_ENABLED: undefined })).toBeNull();
    expect(readDevelopmentConfiguration({ ...environment, NODE_ENV: "production" })).toBeNull();
    expect(readDevelopmentConfiguration({ ...environment, APP_ORIGIN: environment.NEXT_PUBLIC_SUPABASE_URL })).toBeNull();
  });

  it.each(["VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_GIT_COMMIT_SHA"])("rejects hosted marker %s even if false", name => {
    expect(readDevelopmentConfiguration({ ...environment, [name]: "false" })).toBeNull();
  });

  it.each([
    "https://fricsfwqibyhemknqgyf.supabase.co", "http://localhost:54321", "http://127.1:54321",
    "http://127.0.0.1:54321/path", "http://127.0.0.1:54321?target=hosted", "http://127.0.0.1:54321#fragment",
    "http://user:password@127.0.0.1:54321", "http://127.0.0.1", "http://127.0.0.1:1023", "https://127.0.0.1:54321",
  ])("rejects unsupported target %s", target => {
    expect(readDevelopmentConfiguration({ ...environment, NEXT_PUBLIC_SUPABASE_URL: target })).toBeNull();
    expect(readDevelopmentConfiguration({ ...environment, APP_ORIGIN: target })).toBeNull();
  });
});
