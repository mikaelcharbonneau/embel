import "server-only";
import { createLogoDeliverablesService } from "@/features/identity-deliverables/server/persistence";
import { productionIdentityAssetStore } from "./identity-asset-store";
export const { getLogoDeliverables, getLogoExport } = createLogoDeliverablesService({ assets: productionIdentityAssetStore });
