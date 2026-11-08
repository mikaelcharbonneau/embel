# Shared worker release preparation

This source prepares one outbound-only Vercel Daemon process with fixed
restricted slots: one Strategy, one Naming and one to six Logo slots. Six Logo
slots let one six-concept batch run at once; each Logo slot has its own database
role and its own Storage service user. Production configuration selects
the existing https://www.embel.xyz application and
https://fricsfwqibyhemknqgyf.supabase.co project. The existing API-text and Naming
worker project IDs are the only eligible production hosts; the operator must
explicitly choose the reviewed existing project. This does not create a project
or decide which existing worker is safe to replace.

The Containerfile uses Node 22.22.2, runs as node, contains no build arguments,
and installs nothing at startup. The package copies only the reviewed bundles,
source-checked control files and 33 fixed Linux runtime packages. These include
the six unchanged Sharp packages, VTracer and HarfBuzz WASM, Resvg and Canvas
native libraries, PDFKit/fontkit/PDF.js data and workers, and Geist fonts/license.
The full package-lock closure and 2,023 extracted file hashes are pinned in this
directory. Extraction reuses the unchanged SHA512/USTAR guards in
services/logo-worker/package-runtime.mjs without npm installation or lifecycle
hooks. No environment configuration,
database password, Storage password or provider key enters the release.

An existing provider key can be reused without retrieving or copying its value:
each explicitly approved provider binding may replace its literal apiKey input
with apiKeyEnvironment: "OPENAI_API_KEY". Only the verified existing Vercel
production project/process can resolve that exact reference. Its target,
project, deployment and immutable model/binding receipt must still match.
Local, cloud-agent, development and staging processes reject references before
reading a key. There are no arbitrary environment names, missing-key fallbacks
or changes to historical literal-key configuration. Resolved referenced keys
remain process-only and are omitted from JSON serialization.

The release must identify clean committed source. Running packages additionally
require main. Development builds from an uncommitted checkout are diagnostic
artifacts and cannot be treated as clean production releases. After review, the
local packaging command is:

    node scripts/package-shared-worker.mjs --project <reviewed-existing-worker-project-id> --mode stopped

Stopped mode leaves zero instances. Active mode changes the template to one
instance; packaging itself does not deploy or start it. Native archive downloads
occur only when this packaging command passes its clean-source checks; no
downloads are needed for the hermetic package tests.

To avoid embedding a not-yet-created deployment ID in Vercel project settings,
the explicit configuration may set both target.deploymentId and
queue.deploymentId to "platform". Startup materializes them from the actual
VERCEL_DEPLOYMENT_ID; it never sets Vercel metadata or permits unpinned Queue
routing. The installed Queue SDK also uses this platform variable. The database
must separately register that exact deployment before a slot can be claimed.
No startup role or grant manager installs that registration.

The bundled command below performs only sequential database role, TLS,
source-owned SQL catalog and capacity checks in read-only transactions, then
closes the pools:

    node dist/index.js --preflight

It does not claim, renew or fence slots, sign in to Storage, start Queue or
contact a provider. Its receipt deliberately says activationReady: false: the
existing SQL preflight cannot inspect slot deployment/policy bindings, and it
does not prove live integration access. An authorized read-only database
inspection must separately check those bindings. Never use the normal
controller loop as a readiness probe.

This command needs the real deployed runtime and credentials. Local tests do
not establish that Vercel offers an operator command-execution API in the same
deployment. If that execution path is unavailable, report it as an activation
workflow blocker; do not copy or invent deployment metadata to bypass the guard.

The version 2 shared build manifest binds the main bundle, all three fixed
compiled children (raster, text and render), and runtime pins. Children run from
dist with cleared credentials and bounded memory/deadlines. No checkout paths,
TypeScript loader or system font fallback are used. Legacy worker formats remain
separate.

An isolated release directory can run this credential-free native diagnostic
with the pinned Node 22.22.2:

    node dist/index.js --native-smoke

It verifies pinned runtime files and executes real vector conversion, HarfBuzz
text shaping, PNG/PDF rendering, independent PDF rasterization, guidelines and
archive inspection. It reports activationReady: false, including for a local
uncommitted diagnostic build. Production native qualification requires a clean
committed artifact and remains separate from SQL, Storage and provider
authorization. It never claims a slot, opens a database, signs in or calls AI.
