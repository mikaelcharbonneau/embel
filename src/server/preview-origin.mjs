// Pure shared validation for the candidate build preflight and server origin lookup.
// VERCEL_URL is trusted platform metadata; never derive this value from a request.
const productionAliases = new Set([
  'fluid-platform-preview.vercel.app',
  'fluid-platform-preview-mikael-charbonneaus-projects.vercel.app',
  'fluid-platform-preview-embel.vercel.app',
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

// Production uses the explicitly configured canonical site, not a request Host
// or a deployment's temporary URL. Custom domains remain a configuration choice.
export function getVercelProductionOrigin(env) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production') {
    throw new Error('Invalid production platform context.');
  }
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN ||
        origin.username || origin.password || origin.port ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin.hostname)) {
      throw new Error('invalid');
    }
    return origin.origin;
  } catch {
    throw new Error('Invalid production application origin.');
  }
}
