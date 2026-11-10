import type { LogoConceptSlot } from "../../domain/logo-jobs";
import type { LogoType } from "../../domain/logo-workspace";

export const LOGO_TYPE_LABELS: Record<LogoType, string> = {
  wordmark: "Wordmark",
  lettermark_monogram: "Lettermark or monogram",
  pictorial: "Pictorial mark",
  abstract: "Abstract mark",
  combination: "Combination mark",
  emblem: "Emblem",
  mascot: "Mascot",
};
export const CONCEPT_ORDINALS = [0, 1, 2, 3, 4, 5] as const;

/** Display projection only. Ownership, bytes and publication are verified by the shared client. */
export function acceptedConceptAttempt(slot: LogoConceptSlot) {
  const preview = slot.acceptedPreview;
  // Live batch records can omit the convenience acceptedPreview projection.
  // Only acknowledged successful, paid and committed attempts may be shown.
  const successful = slot.attempts.filter(
    (attempt) =>
      attempt.state === "succeeded" &&
      attempt.billing.status === "recorded" &&
      attempt.preview?.publicationState === "committed",
  );
  if (!preview) return successful.at(-1) ?? null;
  if (preview.publicationState !== "committed") return null;
  return (
    successful.find(
      (attempt) =>
        attempt.preview?.id === preview.id &&
        attempt.preview.publicationState === "committed" &&
        attempt.preview.reference.versionId === preview.reference.versionId &&
        attempt.preview.reference.contentHash === preview.reference.contentHash,
    ) ?? null
  );
}
