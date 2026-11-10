import type { IdentitySelectionWithSystem } from "@/domain/project-identity";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import { logoCandidateKey } from "@/components/logo-creation/candidate-review";

/** A saved choice can be in an earlier set and still be the current kit. */
export function hasCurrentBrandAssets(
  choice: IdentitySelectionWithSystem | null | undefined,
  logo: LogoRasterSource | null,
) {
  return Boolean(
    logo &&
    choice?.sourceLogoCurrent &&
    choice.sourceLogo &&
    logoCandidateKey(choice.sourceLogo.source) === logoCandidateKey(logo) &&
    choice.freshness.status === "current" &&
    choice.system.source.kind === "generated" &&
    choice.system.applicationDesign,
  );
}
