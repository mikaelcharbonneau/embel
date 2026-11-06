import { build as esbuild } from "esbuild";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Package resolution, like Node's, walks every parent directory. A
 * package.json/node_modules in a developer's home folder would then be bundled
 * into a worker artifact (e.g. Next's optional `require("@opentelemetry/api")`),
 * changing its source graph from what CI and the hosted build produce. Bare
 * imports that resolve outside the project stay unbundled, exactly as an
 * unresolvable optional require does on a clean runner. */
function projectDependenciesOnly(root) {
  // A worktree may link node_modules elsewhere; its real location still counts.
  const allowed = [...new Set([root, realpathSync(root), ...[path.join(root, "node_modules")].flatMap(directory => {
    try { return [realpathSync(directory)]; } catch { return []; }
  })])];
  const inside = file => allowed.some(directory => {
    const relative = path.relative(directory, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  return { name: "project-dependencies-only", setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.projectDependenciesOnly) return undefined;
      const result = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir,
        pluginData: { projectDependenciesOnly: true } });
      if (result.errors.length || result.external || !result.path) return undefined;
      if (inside(result.path)) return undefined;
      return { path: args.path, external: true,
        warnings: [{ text: `"${args.path}" resolves outside the project and was left unbundled` }] };
    });
  } };
}

/** esbuild's build(), restricted to dependencies installed in the project. */
export function build(options) {
  if (typeof options?.absWorkingDir !== "string") throw Error("Project builds require an explicit absWorkingDir");
  return esbuild({ ...options, plugins: [projectDependenciesOnly(path.resolve(options.absWorkingDir)), ...(options.plugins ?? [])] });
}
