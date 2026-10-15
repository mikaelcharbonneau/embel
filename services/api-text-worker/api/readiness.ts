import { readOpenAIStrategyConfiguration } from "../../../src/server/ai/config";
import { verifyPublisher } from "../../../worker/hosting/auth";
import { readWorkerIdentity } from "../../../worker/hosting/config";
import { handleApiTextReadiness, readApiTextWorkerReadiness } from "../../../worker/hosting/readiness";
import { workerDatabase } from "../runtime";
import { multiAccountApiTextEnabled } from "../../../worker/api-text-multi-account";

const handler = { fetch(request: Request) {
  return handleApiTextReadiness(request, {
    verify: async authorization => {
      readWorkerIdentity();
      await verifyPublisher(authorization, { issuer: process.env.FLUID_WEB_OIDC_ISSUER ?? "", audience: process.env.FLUID_WEB_OIDC_AUDIENCE ?? "" });
    },
    inspect: signal => readApiTextWorkerReadiness({ ...readWorkerIdentity(),
      configuration: readOpenAIStrategyConfiguration(), database: workerDatabase, signal, multiAccount: multiAccountApiTextEnabled() }),
  });
} };
export default handler;
