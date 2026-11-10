> Archived November 10, 2026: describes the system before the generation engine.

# One source repository, separate environments

GitHub is Embel's common reference for application code, dependency versions,
development commands, nonsecret service identifiers and database changes.
[The service map](../../config/service-map.json) records the existing hosted targets.
The same committed revision can be checked out on a laptop or in Codex Cloud.
Neither development location owns a separate edition of the application.

| Information | Authoritative location | How it reaches another environment |
| --- | --- | --- |
| Application and worker code | GitHub repository | Commit/push, then fetch/pull |
| Dependency versions and setup commands | Repository lockfile and scripts | `npm ci` and development setup |
| Database structure and executable SQL authority | Versioned migrations and guarded installation packets | The appropriate development installer or coordinated production rollout |
| Production accounts, projects, jobs and uploaded files | Production Supabase database and private Storage | A deliberate export/import or restore; never Git pull |
| Development accounts, jobs and uploaded files | That checkout's Docker volumes | Retained locally across shutdown/restart; separate from production |
| Provider credentials and passwords | Private environment configuration or a secret store | Authenticated secret retrieval or secure configuration |

## What connecting services to GitHub does

A Vercel Git integration can build and deploy a revision when its configured
branch changes. A database workflow can apply selected versioned migrations to
its configured database. These integrations respond to changes pushed to GitHub;
cloning or pulling the repository does not deploy the website or update the
production database.

Embel already has GitHub CI for setup tests, application checks and worker builds.
The service map identifies deployment targets; it does not create a Git
integration, grant credentials or establish that automatic deployment is enabled.
Live Vercel Git integration and GitHub deployment-secret configuration have not
been verified by this development setup. Production database changes continue
through the [coordinated installation procedure](production-deployment.md), since
the shared workers verify exact SQL authority and compatible runtime artifacts.
The candidates directory is not an automatically applicable migration queue.

## Secrets have their own source

GitHub Actions secrets can supply credentials to CI jobs. They are not files in
the repository and do not arrive with a clone. A private repository is also not
a substitute for a secret store: committing an API key would put it in the Git
history and every authorized clone.

For development, the service map selects the existing Vercel web project's
**Development** environment as an optional common source for the dedicated
`EMBEL_DEVELOPMENT_PROVIDER_API_KEY`. Both a laptop and Codex Cloud can retrieve
the same development binding with authenticated access. This does not copy
production credentials or select the production database. The remote binding
must first be configured; recording its name in Git does not create it.

Each checkout generates its own restricted database passwords and storage
identity. Those values belong to that checkout's isolated local services and do
not need to be synchronized between machines. Generated configuration lives in
ignored `.embel-dev/`; provider keys stay out of browser configuration.

See [development setup](development-environment.md) for executable commands and
[the handoff workflow](local-cloud-sync.md) for switching computers or cloud
environments. Working in a different location changes where development runs,
not which Git repository holds the source.
