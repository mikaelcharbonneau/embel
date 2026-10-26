import { writeFile } from "node:fs/promises";
import { benchmarkNamingRunIndexes, lookupBuffers, lookupNodes } from "../../tests/database/naming-run-lookup-benchmark";

// Offline only: this script creates PGlite in memory and has no URL/credentials
// option. The sole optional argument is a local JSON output path.
const args = process.argv.slice(2);
if (args.length > 1) throw new Error("Usage: node --import tsx scripts/benchmarks/naming-run-indexes.ts [output.json]");
const evidence = await benchmarkNamingRunIndexes();
if (args[0]) await writeFile(args[0], JSON.stringify(evidence, null, 2));
for (const [table, samples] of Object.entries(evidence.samples)) {
  console.info(JSON.stringify({ table, samples: samples.map(sample => ({ unrelatedRows: sample.unrelatedRowsPerTable,
    before: { buffers: lookupBuffers(sample.before.Plan), nodes: lookupNodes(sample.before.Plan).map(node => node["Node Type"]), milliseconds: sample.before["Execution Time"] },
    after: { buffers: lookupBuffers(sample.after.Plan), nodes: lookupNodes(sample.after.Plan).map(node => node["Node Type"]), milliseconds: sample.after["Execution Time"] } })) }));
}
