import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withWorkflow } from "workflow/next";

// Files loaded by isolated logo children and native filesystem-backed engines.
// Geist is deliberately not external: app/layout.tsx uses its next/font entry.
const logoRuntimeFiles = [
  "package.json",
  "tsconfig.json",
  "src/domain/asset-library.ts",
  "src/domain/assets.ts",
  "src/domain/conversation.ts",
  "src/domain/logo-directions.ts",
  "src/domain/logo-image-limits.ts",
  "src/domain/logo-vector.ts",
  "src/domain/naming.ts",
  "src/domain/projects.ts",
  "src/features/identity-deliverables/server/render-process.mjs",
  "src/features/identity-directions/model/font-rights.ts",
  "src/features/logo-vector/model/errors.ts",
  "src/features/logo-vector/model/geometry.ts",
  "src/features/logo-vector/model/limits.ts",
  "src/features/logo-vector/model/svg.ts",
  "src/server/image-process/engine.ts",
  "src/server/image-process/process.ts",
  "src/server/image-process/raster.ts",
  "node_modules/@esbuild/*/**/*",
  "node_modules/@img/colour/**/*",
  "node_modules/@img/sharp-*/**/*",
  "node_modules/@napi-rs/canvas-*/**/*",
  "node_modules/@napi-rs/canvas/**/*",
  "node_modules/@noble/ciphers/**/*",
  "node_modules/@noble/hashes/**/*",
  "node_modules/@resvg/resvg-js-*/**/*",
  "node_modules/@resvg/resvg-js/**/*",
  "node_modules/@swc/helpers/**/*",
  "node_modules/@visioncortex/vtracer/**/*",
  "node_modules/base64-js/**/*",
  "node_modules/brotli/**/*",
  "node_modules/clone/**/*",
  "node_modules/detect-libc/**/*",
  "node_modules/dfa/**/*",
  "node_modules/esbuild/**/*",
  "node_modules/fast-deep-equal/**/*",
  "node_modules/fflate/**/*",
  "node_modules/fontkit/**/*",
  "node_modules/harfbuzzjs/**/*",
  "node_modules/linebreak/**/*",
  "node_modules/pako/**/*",
  "node_modules/pdfjs-dist/**/*",
  "node_modules/pdfkit/**/*",
  "node_modules/png-js/**/*",
  "node_modules/restructure/**/*",
  "node_modules/saxes/**/*",
  "node_modules/semver/**/*",
  "node_modules/sharp/**/*",
  "node_modules/svg-pathdata/**/*",
  "node_modules/tiny-inflate/**/*",
  "node_modules/tslib/**/*",
  "node_modules/tsx/**/*",
  "node_modules/unicode-properties/**/*",
  "node_modules/unicode-trie/**/*",
  "node_modules/xmlchars/**/*",
  "node_modules/zod/**/*",
  "node_modules/geist/package.json",
  "node_modules/geist/LICENSE.txt",
  "node_modules/geist/dist/sans.js",
  "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf",
  "node_modules/geist/dist/fonts/geist-sans/Geist-Italic*.ttf",
  "node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.ttf",
  "node_modules/geist/dist/fonts/geist-mono/GeistMono-Italic*.ttf"
];

const nextConfig: NextConfig = {
  // The development badge otherwise covers the floating composer's grip on phones.
  devIndicators: false,
  // Confirmation callbacks carry a one-time sign-in code in the query string.
  logging: { incomingRequests: { ignore: [/^\/auth\/callback(?:[/?]|$)/] } },
  serverExternalPackages: ["@resvg/resvg-js","@napi-rs/canvas","@visioncortex/vtracer","fontkit","harfbuzzjs","pdfjs-dist","pdfkit","sharp"],
  outputFileTracingIncludes: {
    "/*": ["scripts/certs/supabase-prod-ca-2021.crt"],
    "/api/home/**": logoRuntimeFiles,
    "/api/projects/*/logo{,/**}": logoRuntimeFiles,
    "/api/projects/*/identity{,/**}": logoRuntimeFiles,
    "/api/assets/*/logo-export": logoRuntimeFiles,
    // Logo image steps of the generation engine check images in the isolated raster child.
    "/.well-known/workflow/**": logoRuntimeFiles,
  },
  turbopack: { root: process.cwd() },
  // Skew Protection gives each Vercel build a new deployment id, and next/font
  // writes it into the font CSS (?dpl=) and the font class name. Next's webpack
  // cache key ignores that id (vercel/next.js#100642), so a restored build cache
  // paired stale font CSS with fresh server HTML and pages fell back to Times.
  webpack(config, { config: next }) {
    if (next.deploymentId && config.cache && typeof config.cache === "object") {
      config.cache.version = `${config.cache.version ?? ""}|${next.deploymentId}`;
    }
    return config;
  },
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      // Same-origin capability only. Voice still requires explicit Start and the browser permission prompt.
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), on-device-speech-recognition=(self), geolocation=()" }
    ] }];
  }
};
/** The app's own settings, before Workflow adds its build transforms (read by tests). */
export const appConfig = nextConfig;
// Transforms "use workflow" and "use step" (docs/generation-engine.md).
// BotID adds the rewrites that serve its challenge script from this origin.
export default withWorkflow(withBotId(nextConfig));
