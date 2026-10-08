import { vi } from 'vitest';

/** Run the unchanged legacy behavioral suites against all five candidate SQL
 * increments, rather than merely testing the old suites on old migrations. */
vi.mock('./local-supabase', async importOriginal => {
 const original = await importOriginal<typeof import('./local-supabase')>();
 const { readFile } = await import('node:fs/promises');
 const candidates = await Promise.all(['logo-vector-proposals.sql', 'logo-vector-proposal-quotes.sql', 'logo-vector-proposal-admission.sql', 'logo-vector-proposal-observations.sql', 'logo-vector-proposal-completion.sql'].map(name => readFile(new URL('../../supabase/candidates/' + name, import.meta.url), 'utf8')));
 return {
  ...original,
  createTestDatabase: (options: Parameters<typeof original.createTestDatabase>[0] = {}) => original.createTestDatabase({ ...options, additionalMigrations: [...(options.additionalMigrations ?? []), ...candidates] }),
 };
});
await import('./logo-jobs.test');
await import('./logo-readiness.test');
await import('./logo-directions-subscription.test');
