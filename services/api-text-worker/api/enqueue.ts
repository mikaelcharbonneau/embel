import { verifyPublisher } from "../../../worker/hosting/auth";
import { handleEnqueue } from "../../../worker/hosting/http";
import { publishAdmittedDispatch } from "../../../worker/hosting/publication";
import { readWorkerIdentity } from "../../../worker/hosting/config";
import { publicationDependencies } from "../runtime";

const handler = { fetch(request: Request) {
  return handleEnqueue(request, {
    verify: async authorization => {
      readWorkerIdentity();
      await verifyPublisher(authorization, { issuer: process.env.FLUID_WEB_OIDC_ISSUER ?? "", audience: process.env.FLUID_WEB_OIDC_AUDIENCE ?? "" });
    },
    publish: (message, signal) => publishAdmittedDispatch(message, publicationDependencies(signal)),
  });
} };
export default handler;
