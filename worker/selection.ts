/** An explicit process selection never changes admission, provider or ownership policy. */
export function readWorkerSelection(arguments_: readonly string[]): "all" | "naming_only" {
  if (arguments_.length === 0) return "all";
  if (arguments_.length === 1 && arguments_[0] === "--naming-only") return "naming_only";
  throw new Error("Invalid worker arguments");
}
