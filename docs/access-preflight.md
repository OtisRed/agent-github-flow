# Read-only access preflight

`project-access-preflight.yml` and `app-access-preflight.yml` are separate reusable workflows that check access before a project adopts the shared flow. It does not change repository contents, comments, issues, Project cards, or release state. A successful run is not proof that write permissions, rotation, reconciliation, or production deployment work.

Each caller supplies a fixed environment name. The Project workflow also takes the personal Project owner and number. The App workflow takes the repository owner and name, GitHub App ID and expected app slug. The named environment belongs to the calling repository. Before adding real secrets, configure and verify its branch protections, ensure the allowed branch and workflow are trusted, and pin the reviewed shared workflow to its full commit SHA. Do not use test-branch code as a production release.

Map only `PROJECT_ACCESS_TOKEN` in the Project caller and only `APP_PRIVATE_KEY` in the App caller. GitHub environment secrets cannot be selected directly on a caller job that invokes a reusable workflow; the called jobs specify the environment. Each relevant name must be mapped even if its value is supplied by the called job's environment. Do not use `secrets: inherit`. A `required` declaration does not prove that a value exists: the Project job rejects a missing PAT at runtime and the App token action rejects a missing private key.

The Project job reads the specified personal Project number with the user PAT. The App job creates a short-lived installation token scoped to the named repository and `contents: read`, checks its app slug and single-repository scope, and reads repository metadata. The official token action revokes its token after the job. The configured App installation may have broader permissions than this test token: this check proves neither write permissions nor the absence of broader installation access.

The earlier per-project model is superseded by the agreed central controller:
the Project PAT and App private key belong in the central controller's protected
environment; each sender has only its relay credential. The reusable workflows
above remain generic and their presence does not establish that this target
architecture is deployed. Never place token values, private keys, or copied
secrets in the repository, logs, issues, or chat. Keep the existing workflow
owner active until a separate, verified handover. These probes are not rotation.

`central-access-probe.yml` prepares two independent, read-only runtime probes
using the central `flow-controller` environment on `main`. It uses environment
secrets `PROJECT_ACCESS_TOKEN` and `APP_PRIVATE_KEY`, and individually masked
target secrets `FLOW_PROBE_PROJECT_OWNER`, `FLOW_PROBE_PROJECT_NUMBER`,
`FLOW_PROBE_REPO_OWNER`, `FLOW_PROBE_REPO_NAME`. The environment variables
`FLOW_APP_ID` and `FLOW_APP_SLUG` identify the expected App. Targets are not
workflow inputs, so they are not exposed in the dispatch form or run title.
Even on success the two jobs prove only the specific reads with those runtime
credentials: not write permissions, relay transmission, route uniqueness or
controller readiness. Review the code and protect `main` and the environment
before supplying any values; do not assume it is present on `main` from its
presence on `smoke`.
