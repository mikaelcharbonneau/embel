import { handleRepair } from "../../../../worker/hosting/http";
import { repairApiTextDispatches } from "../../../../worker/hosting/publication";
import { publicationDependencies } from "../../runtime";

const handler = { fetch(request: Request) {
  return handleRepair(request, {
    secret: process.env.CRON_SECRET,
    repair: signal => repairApiTextDispatches(publicationDependencies(signal)),
  });
} };
export default handler;
