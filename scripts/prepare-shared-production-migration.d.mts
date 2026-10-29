export type SharedProductionPacketName =
  | "identity_transactions.sql"
  | "shared_worker_pool.sql"
  | "shared_account_http.sql"
  | "shared_worker_strategy.sql"
  | "shared_worker_naming.sql"
  | "shared_worker_logo.sql"
  | "shared_storage_authority.sql"
  | "shared_logo_http.sql"
  | "shared_logo_advanced.sql"
  | "shared_identity_generation.sql";

export const PRODUCTION_ORIGIN: "https://fricsfwqibyhemknqgyf.supabase.co";
export const PACKET_NAMES: SharedProductionPacketName[];
export const PACKET_SHA256: Readonly<Record<SharedProductionPacketName, string>>;
export const POST_INSTALL_PACKETS: readonly Readonly<{
  name: "shared_storage_download_metadata.sql" | "shared_logo_storage_member.sql";
  sha256: string;
}>[];
export const INVENTORY_EXPRESSION: string;
export const READ_ONLY_INVENTORY_SQL: string;
export const READ_ONLY_PREREQUISITE_SQL: string;

export function stripReviewedTransactionEnvelope(source: string, expectedSha: string): string;

export interface PreparedSharedProductionMigration {
  readonly sql: string;
  readonly sha256: string;
  readonly packets: SharedProductionPacketName[];
  readonly sourceHashes: Readonly<Record<SharedProductionPacketName, string>>;
  readonly postInstallPackets: typeof POST_INSTALL_PACKETS;
  readonly target: typeof PRODUCTION_ORIGIN;
  readonly requiresReviewedConnection: true;
}

/** Validates untrusted JSON metadata; unsupported/partial inventories throw. */
export function composeSharedProductionMigration(input: unknown): Readonly<PreparedSharedProductionMigration>;
