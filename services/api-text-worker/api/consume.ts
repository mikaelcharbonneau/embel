import { QueueClient } from "@vercel/queue";
import { runApiTextDelivery } from "../../../worker/api-text-runtime";
import { readOpenAIStrategyConfiguration } from "../../../src/server/ai/config";
import { readWorkerIdentity } from "../../../worker/hosting/config";
import { handleApiTextQueueRequest } from "../../../worker/hosting/consumer";
import { workerDatabase } from "../runtime";
import { apiTextBackgroundRecoveryEnabled } from "../../../worker/api-text-background-config";
import { multiAccountApiTextEnabled } from "../../../worker/api-text-multi-account";

// The queue/v2beta trigger removes this function's public route. No HTTP fallback.
const queue = new QueueClient({ region: "iad1", telemetry: { isEnabled: false } });
const handler = { fetch: (request: Request) => handleApiTextQueueRequest(request, { queue,
  deliver: (message, signal) => {
    const { deploymentId } = readWorkerIdentity();
    return runApiTextDelivery({ message, database: workerDatabase(),
      configuration: readOpenAIStrategyConfiguration(), deploymentId, signal, multiAccount: multiAccountApiTextEnabled(), backgroundRecovery: apiTextBackgroundRecoveryEnabled() });
  },
}) };
export default handler;
