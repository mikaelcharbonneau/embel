"use client";

import { useEffect } from "react";
import { inspirationBrands, inspirationLikeCount } from "@/domain/inspiration";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { useInspiration } from "./use-inspiration";

const brandIds = new Set(inspirationBrands.map((brand) => brand.id));

/** Reads a project's saved Inspiration likes (whole brands and their parts) for the folded Inspiration entry in the
 * chat, while the gallery itself is not on screen. Renders nothing. Images of your own are counted by the gallery. */
export function InspirationLikeCount({
  account,
  projectId,
  onCount,
}: {
  account: VerifiedAccount;
  projectId: string;
  onCount: (count: number) => void;
}) {
  const { overview } = useInspiration(account, projectId);
  const count = overview
    ? overview.choices
        .filter((choice) => brandIds.has(choice.referenceId))
        .reduce((total, choice) => total + inspirationLikeCount(choice), 0)
    : null;
  useEffect(() => {
    if (count !== null) onCount(count);
  }, [count, onCount]);
  return null;
}
