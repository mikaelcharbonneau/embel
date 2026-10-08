// Pure shared validation for the candidate build preflight and server origin lookup.
// VERCEL_URL is trusted platform metadata; never derive this value from a request.
const productionAliases = new Set([
  'fluid-platform-preview.vercel.app',
  'fluid-platform-preview-mikael-charbonneaus-projects.vercel.app',
]);

export function getVercelPreviewOrigin(env) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview') {
    throw new Error('Invalid preview platform context.');
  }

  const hostname = env.VERCEL_URL;
  // One canonical lowercase DNS label. This rejects schemes, credentials, ports,
  // whitespace, paths, query strings, fragments, nested hosts and URL normalization.
  if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(hostname) ||
      hostname.startsWith('xn--') || hostname.includes('-git-') || productionAliases.has(hostname) ||
      hostname === env.VERCEL_BRANCH_URL || hostname === env.VERCEL_PROJECT_PRODUCTION_URL) {
    throw new Error('Invalid immutable preview hostname.');
  }

  const origin = new URL(`https://${hostname}`);
  if (origin.hostname !== hostname || origin.host !== hostname || origin.origin !== `https://${hostname}`) {
    throw new Error('Invalid immutable preview hostname.');
  }
  return origin.origin;
}
