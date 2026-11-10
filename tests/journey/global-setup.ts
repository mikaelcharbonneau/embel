import { createJourneyAccount, prepareJourneyDatabase } from "./prepare.mjs";

// Runs once before the journey: database switches and a fresh account, handed to the
// test through the environment (the password exists only in this run's memory).
export default async function globalSetup() {
  await prepareJourneyDatabase();
  const account = await createJourneyAccount();
  process.env.EMBEL_JOURNEY_EMAIL = account.email;
  process.env.EMBEL_JOURNEY_PASSWORD = account.password;
  process.env.EMBEL_JOURNEY_USER_ID = account.userId;
}
