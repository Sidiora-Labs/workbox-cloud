# Unified provider deployments, sandboxes and Workbox

Updated 17 November 2026. Workbox Cloud provides one visible entry point for native application deployments and external provider workloads. The normative source is [the deployment specification](../../spec/workbox-cloud-deployments/spec.kvx); [the operator guide](../workloads.md) describes the launch and management workflow. This repository has no KVX renderer.

The reevaluation found a product gap: the external destination picker existed as a component, but no application page supplied its external options or launch callback. The dashboard API wrapper only listed saved targets. Connecting Railway, Vercel or Fly credentials therefore did not give an operator a way to create an external workload. Provider plan enforcement and binding newly created resource IDs also needed repair.

The initial remediation adds **Workloads** navigation, `/workloads/new` configuration and review, and `/workloads` management backed by persisted operations. The catalog expansion connects this operation layer to **Apps**, adds provider-specific installation recipes and installs a prepared Workbox host through the existing server execution path. Original requirements below describe the broader capability roadmap; a provider's native feature set does not imply that every feature is exposed by this release.

## Current provider facts

The provider model must follow the current product split:

| Provider resource | What it is | Lifecycle and state | Openship workload kind |
| --- | --- | --- | --- |
| Railway service | A container deployment target. Railway services can be persistent or scheduled and are sourced from GitHub, a local repository or an image. Configuration is staged and then deployed. | Revision/deployment attempts, logs, metrics, variables, domains and volumes. | `service` |
| Railway Sandbox | An isolated Linux VM scoped to one Railway environment. It is created on demand for commands, tests, builds or agent work, and can be checkpointed or forked. `ISOLATED` and `PRIVATE` networking, resources, idle timeout and creation-time domains are sandbox properties. | VM state, exec/SSH sessions, files, checkpoint/fork lineage, idle destruction and optional routes. Railway recommends a service for production traffic. | `railway-sandbox` |
| Vercel project deployment | A Vercel project/deployment used for web, serverless and related Vercel application delivery. | Deployment revision, build output, environment values applied on a new deployment, aliases/domains, logs and promotion/rollback. | `service` |
| Vercel Sandbox | A Firecracker microVM exposed through the Sandbox SDK/CLI. Current V2 uses a sandbox/session model, persistent sandboxes by default, automatic snapshots and resume, custom or managed OCI images, ports, tags, network policy, multi-agent isolation and system-privileged processes. | Long-lived sandbox identity plus resumable VM sessions, snapshots, retention, stop/resume and delete. | `vercel-sandbox` |
| Fly Machine | A Fly application VM managed through the Machines API. | Machine ID, app/organization/region, image, volumes, checks, env/secrets, process groups and health. | `fly-machine` |
| Fly Sprite | A separate Fly product/API for persistent Firecracker computers with filesystem, services, checkpoints, sleep/wake, network policy and URL state. | Sprite name, sessions, checkpoints, active/warm/cold state and public/private URL policy. | `fly-sprite` |
| Blaxel Sandbox | A provider sandbox with automatic standby. | Create, observe, commands and delete in this adapter; standby retains state and differs from TTL deletion. | `blaxel-sandbox` |
| Blaxel Application | A container application available in private preview. | Create, observe and delete; requires a workspace registry image and preview access. | `service` |
| Self-managed server | Existing Openship SSH/Docker/Bare/Compose/Kubernetes destination. | Existing server and cluster lifecycle, routing, TLS, deployment revisions and host health. | `self-managed-server` |
| Workbox host | A service or host that runs the Workbox daemon and exposes its API. It is not itself a sandbox. | Host preflight, daemon readiness, API endpoint and scoped key material. | `workbox-host` |
| Workbox sandbox | A child workload created through the Workbox REST/WebSocket/SDK surface. | Workbox desired/observed state, sessions, exec, files, events, asks, artifacts, checkpoints and reconcile. | `workbox-sandbox` |

The latest official documentation confirms that Railway services are container deployments and that Railway Sandboxes are separate isolated VMs with environment-scoped networking, checkpoints/forks, idle timeout, optional domains, file transfer, port forwarding and Docker available inside the sandbox image ([Railway services](https://docs.railway.com/services), [Railway Sandboxes](https://docs.railway.com/sandboxes), [Railway Docker in Sandboxes](https://railway.com/changelog/2026-06-12-docker-in-sandboxes)). Vercel documents Sandboxes separately from project deployments, with Firecracker isolation, persistent sandboxes by default, automatic resume, snapshots, custom images, privileged processes and network controls ([Vercel Sandbox](https://vercel.com/docs/sandbox), [persistent sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [Docker in Sandbox](https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox)).

## Invariants

- A provider connection is an organization-owned credential and account identity. A deployment target is a provider resource binding. A workload record states whether the target is a service, sandbox, machine or Workbox child. These are separate records and selectors.
- Two Vercel accounts or teams remain separate named connections even when they expose projects with the same name. A deploy never chooses the newest token, last-used account or an inferred team.
- Railway services and Railway Sandboxes use different adapters, APIs, lifecycle states and UI actions. A sandbox route is not a service domain, and a service deployment is not a sandbox VM.
- Vercel project deployments and Vercel Sandboxes use different adapters, APIs, persistence and rollback semantics. A Vercel Sandbox is not a Function, project deployment or ordinary service container.
- Fly Machines and Fly Sprites use distinct APIs and target kinds. A Workbox sandbox or checkpoint cannot become a Sprite by copying an identifier; promotion requires an explicit transfer operation and receipt.
- The existing self-managed server path remains authoritative for SSH host-key pinning, DNS/SSRF restrictions, Docker/Bare/Compose/Kubernetes runtime selection and destination ownership. External providers never fall back to the control plane's Docker socket or filesystem.
- Every external mutation persists intent, target snapshot, revision/resource identity and an idempotency key before the provider call. A timeout or lost response enters reconciliation; `UNKNOWN` is never reported as success.
- Provider credentials are encrypted at rest, resolved only by server-side adapters, masked in UI/logs/audit/events and scoped to the organization and selected target. Workbox keys are bound to sandbox IDs or labels where supported.
- Capability checks run before apply. Unsupported combinations are visible with a reason and remediation. A normal provider service cannot be treated as a privileged Workbox host merely because it can run an image.
- A Workbox host and a Workbox sandbox are distinct. The current connected-host setup and common-operation limits are documented in [connected Workbox hosts](../workbox-connected-hosts.md). Native Railway or Vercel sandboxes can implement normalized sandbox actions directly, but they retain native provider provenance and are not called Workbox unless the Workbox adapter is actually driving them.

## Target and operation model

Add a provider-neutral external deployment layer below shared platform operations and beside the existing host runtime adapters. It should expose:

`discover → capabilities → preflight → plan → apply → observe → logs → exec/session → files → snapshot/checkpoint → stop/resume → promote/rollback → destroy → reconcile`

A target contains:

- `provider`: `railway`, `vercel`, `fly`, `self-managed`, `workbox`, or `blaxel`;
- `connectionId` and a provider identity snapshot (account, team, workspace or organization);
- provider resource selectors (Railway project/environment/service or sandbox, Vercel project or sandbox name, Fly app/region/machine or Sprite, SSH server/cluster, Workbox base URL); and
- a capability/preflight result with an expiry and the exact provider API version or SDK pin used.

A durable operation contains the requested workload kind, immutable target snapshot, source or image digest, environment revision, idempotency key, provider request/resource identity, normalized status, provider status, logs/event cursor, and cleanup/reconciliation receipt. The normalized status must preserve `queued`, `provisioning`, `running`, `stopping`, `stopped`, `ready`, `failed`, `unsupported`, `action_required`, `unknown` and `reconciling` without collapsing provider-specific states.

## Provider slices

**Railway service.** Add a deploy adapter alongside the existing migration provider. It must stage and deploy source/image and variables, observe deployment attempts, stream logs, manage domains and volumes, restart and roll back by provider revision. It must not create or mutate a Railway Sandbox record.

**Railway Sandbox.** Add a separate adapter using the current Railway Sandbox SDK/API. The target binds one environment and records region, resource request, `networkIsolation`, `idleTimeoutMinutes`, environment values, checkpoint/fork lineage and creation-time domains. The UI exposes exec/SSH, files, sessions, checkpoint/fork, route and destroy actions; it warns about per-environment concurrency, idle destruction and the recommendation to use a service for production traffic.

**Vercel project deployment.** Add an account/team-bound project adapter. It must create or update a project, apply environment values according to Vercel's deployment semantics, create a deployment from source or prebuilt output, observe build/runtime status, stream logs and promote or roll back through provider-supported aliases or revisions. It must not use the Sandbox API.

**Vercel Sandbox.** Add an adapter for the current `@vercel/sandbox` SDK/API. It must preserve sandbox name and project scope, persistent versus non-persistent mode, session identity, automatic resume, snapshot retention, custom/managed image, ports, tags and network policy. The UI exposes sandbox/session/snapshot actions separately from project deployments. Account and plan limits are shown before creation.

**Fly Machine and Fly Sprite.** Add separate adapters, credential origins and capability profiles. Machines cover app image, region, volume, health and lifecycle. Sprites cover persistent filesystem, services, checkpoints, sleep/wake, network and URL state. A Workbox-to-Sprite or Workbox-to-Machine promotion is an explicit transfer workflow with source and destination receipts.

**Blaxel.** Use a workspace-scoped API key and pin Management API requests to `2026-04-28`. Sandboxes expose create, observe, command execution and delete; automatic standby preserves state and is separate from expiration. Applications use their own endpoint and disclose private-preview availability. Application images must already be in the workspace registry. See [Applications](https://docs.blaxel.ai/Applications/Overview), [Sandboxes](https://docs.blaxel.ai/Sandboxes/Overview), and [API authentication/versioning](https://docs.blaxel.ai/api-reference/introduction).

**Self-managed server.** Extend only the target registry and unified UI. Reuse the current server and cluster operations, SSH transport, Docker/Bare/Compose/Kubernetes runtimes, routing/TLS and host security. Do not duplicate the existing engine.

## Workbox integration

Workbox upstream at commit `9741e30334139bbe7e28cd5c034e345c616a470a` provides REST, WebSocket, SDK, MCP and CLI surfaces for sandboxes. Its own provider mapping describes twelve operations — capabilities, prepare, create, list, observe, attach, execute, inspect, stop, transfer, lifetime and destroy — and records partial or missing behavior for capabilities, lifetime, attach, transfer and output digests ([Workbox repository](https://github.com/Sidiora-Labs/workbox), [provider mapping](https://github.com/Sidiora-Labs/workbox/blob/main/docs/hyperfide-provider.md)).

The adapter will:

1. connect to a prepared Workbox host, or prepare a compatible connected Linux server through the managed host installation flow, and store only an encrypted API-key reference;
2. run Workbox doctor/readyz and project the host's rootfs, runtime, user namespace, cgroup v2, subordinate-ID, bubblewrap, overlayfs and nftables capabilities;
3. map Openship environment intent to Workbox rootfs/runtime/profile/limits/network/labels/secretRefs and idempotency keys;
4. create and observe child Workbox sandboxes, stream sessions/events, expose files, artifacts, asks and checkpoints, and preserve output gaps and reconciliation state; and
5. keep native Railway Sandbox, Vercel Sandbox and Fly Sprite resources distinct, even when a common environment profile supplies names, limits, secrets or checkpoint intent.

Workbox's server deployment guide requires privileged Linux host capabilities for its daemon container — subordinate UID mapping, cgroup v2, overlayfs, bubblewrap and nftables ([Workbox deployment requirements](https://github.com/Sidiora-Labs/workbox/blob/main/docs/guides/deploy.md)). The preflight therefore blocks a Workbox host on a target that cannot prove those capabilities. Railway and Vercel native Sandboxes can still be selected as their own sandbox workloads; that does not imply that a normal Railway or Vercel service can host a Workbox daemon.

The requested “sprite machine” option resolves to `fly-sprite` using Fly's separate Sprites API. Workbox currently has no sprite primitive, so a future Workbox sprite profile requires a new upstream contract or an explicit Openship adapter decision; it cannot be inferred from a Workbox sandbox ID.

## Interface implementation

The visible **Workloads** entry leads to the persisted workload list; **New workload** opens `/workloads/new`. The launch flow asks for infrastructure first:

- **Workbox Cloud & your servers** presents the existing destination picker first. Operators select a managed Cloud workspace or connected VPS/bare-metal server, then enter the source/catalog wizard with that saved default; the destination can still be changed before deployment.
- **Railway, Vercel, Fly.io or Blaxel** requires an explicit saved connection and workload kind. Discovery populates available projects, environments or applications; manual provider IDs are a fallback when discovery is unavailable.
- **Workbox environments** creates a child sandbox through a connected, compatible Workbox host. The **Workbox prepared host** catalog flow prepares a compatible connected Linux server first, subject to Workbox's Linux requirements.

Typed configuration is submitted to provider preflight and plan validation. The review displays blockers and warnings, selected connection, workload and persistence information without exposing environment values. Editing configuration invalidates the plan. Apply requires a current accepted plan and rechecks the selected connection.

The management screen restores resource-bearing operations after reload, exposes normalized/provider status and error messages, and sends refresh, command and confirmed deletion through the same authorized operation layer. Commands and destruction are available only where the adapter advertises those capabilities. Deletion intent is persisted before the provider call; ambiguous results remain visible for inspection. Refresh must not resume a stopped sandbox. Each operation retains its own returned provider resource identity so a later deployment cannot redirect its controls.

Logs, terminal sessions, files, snapshots, promotion, rollback and advanced networking remain provider-specific follow-on work wherever they are absent from the implemented adapter. They must not be inferred from the broader requirements or a provider's own console.

## Catalog expansion

The next catalog slice is tracked as requirements 12–13 and tasks 6.1–6.4 in the specification. Its implementation and qualification are in progress; the earlier staging receipts below cover the workload launcher, not these additions.

A catalog entry can offer native server installation and a set of provider-specific recipes. Each recipe records its provider and workload kind, trusted source or image, constrained operator inputs, capability requirements and provenance. The server resolves the recipe by catalog and recipe ID before constructing a deployment plan. A client cannot replace its source, topology or credential scope. The remote catalog must use the Workbox Cloud fork so upstream catalog refreshes cannot erase fork-specific recipes.

The install flow retains one app identity. It offers compatible destinations, requires the selected named account or server, collects the recipe's inputs, reviews the provider plan and creates a persisted installation. Provider installations appear in **Apps** and retain their exact operation/resource binding; the same observation and management operations are used in **Workloads**. A native project continues to use the existing service, environment, route, health and storage lifecycle.

The initial Railway recipes are PostgreSQL, Redis and n8n. They create dedicated projects using native template graphs, preserving service dependencies, variable references and volumes. The graph is checked against its reviewed hash; an upstream change blocks installation pending review. The Vercel recipes are Next.js Starter, Next.js Blog and Portfolio Starter. They create a scoped project and deployment from a pinned upstream revision; they do not copy a repository into the operator's Git account. Additional databases, object stores or OAuth credentials must be declared inputs or explicitly excluded from a recipe. A Docker image is not a portable substitute for all of these requirements.

The browser slice includes interactive Chromium, Firefox and Webtop plus Selenium browser automation. Each entry declares persistent profiles where applicable, shared memory, minimum resources, health checks and protected access. Browserless is not included in this slice: its commercial licensing conditions need a separate integration decision.

Workbox preparation is a dedicated host operation. It uses an organization-owned server and the existing authenticated execution and provisioning lock, checks the host, installs pinned daemon code and required assets, starts a managed service, verifies readiness and authenticated inventory, then registers the encrypted connection. The daemon uses the protected server transport rather than requiring a public unauthenticated listener. Progress and failures remain inspectable; a ready host offers child sandbox creation. This host operation must be qualified on an isolated compatible Linux system before being called operational.

Curated provider entries are selected for deployability and manageable dependencies. They are not presented as a measured popularity ranking. Source review, local container checks, provider API tests, authenticated UI journeys and live persistence/cleanup evidence remain separate.

## Phased implementation

1. **Vocabulary and contracts.** Add workload kinds, target records, provider capability descriptors and normalized operation schemas. Keep migration source adapters separate from deployment adapters.
2. **Connections and durable state.** Extend the existing credential registry with deploy/sandbox capabilities, provider identity verification, Vercel account/team selectors, Fly origins and Workbox endpoint/key references. Add target bindings, immutable snapshots, operation idempotency and reconciliation records.
3. **Provider adapters.** Implement Railway service and Sandbox, Vercel project and Sandbox, Fly Machine and Sprite, and the Workbox remote/host adapters. Each adapter must have bounded fetch, redaction, capability checks, inspect-after-timeout and provider-specific status mapping.
4. **Unified surfaces.** Update dashboard, desktop, CLI and SDK target selection, resource detail pages, logs/session streams, localized labels and provider icons. Preserve self-managed server behavior and existing migration flows.
5. **Qualification and documentation.** Add contract and fixture suites, real Docker and prepared Workbox-host tests, opt-in disposable live matrices, recovery/endurance cases and operator documentation. Publish evidence by class rather than one undifferentiated “integration complete” claim.

## Checkout implementation checkpoint

The 17 November remediation implementation covers the real dashboard launch/management path, credential-bound discovery, operation listing, accepted-plan enforcement, resource identity binding and Blaxel. Remediation tasks 5.1–5.3 in the specification are implemented and have the bounded staging evidence below. It also repairs current provider request shapes and passive observation semantics. The shared contracts, encrypted connection registry, HTTP/native operation boundary and existing SSH/Docker/Bare/Compose/Kubernetes paths remain the foundation.

Implementation status and validation must be read independently. On 17 November, the API and dashboard were deployed to `cloud.centra.ag` with digest-pinned images. Evidence is recorded under `artifacts/workloads-20261117/`:

| Lane | Observed result |
| --- | --- |
| Authenticated dashboard | All six infrastructure choices rendered; explicit connection selection worked. Blaxel review, creation, readiness, command execution and confirmed deletion passed through the UI. Mobile viewport had no horizontal overflow or JavaScript errors. |
| Railway native Sandbox | Created, observed ready, executed the expected command with exit 0, destroyed; independent provider lookup confirmed `DESTROYED`. |
| Vercel Sandbox | Created, executed the expected command with exit 0, deleted; independent provider lookup returned 404. |
| Blaxel Sandbox | Created, observed ready, executed the expected command with exit 0, deleted; provider retained a `TERMINATED`, disabled tombstone with deletion events. |
| Fly Machine | Deployed nginx with one shared CPU and 256 MB, observed running, destroyed through Workbox Cloud; the temporary empty app was removed and independently confirmed absent. Public ingress was not exercised. |
| Existing installation | Other running containers and agent storage were preserved. Nine cloud connections were active, the original three gateway profiles and three health agents were available, and edge health had no open outage. |

The first Railway test exposed an invalid test-harness observation payload and was cleaned up before a corrected successful run. The first Fly test failed before Machine creation; its temporary app was removed, then the documented shared-CPU configuration and canonical image passed. These attempts and their cleanup receipts are retained. This evidence does not qualify every provider operation, application source, region or account tier.

The older full-capability tasks in the KVX specification remain a roadmap. They are intentionally not all marked complete by this remediation. The catalog and Workbox host expansion has its own tasks and evidence; it is not covered by these earlier receipts. Provider-native sessions/files/checkpoints, application rollback and transfers also require their own implemented controls and evidence.

## Verification and limits

Component evidence must include provider-neutral adapter contracts, schema/auth tests, redaction tests, target isolation, capability rejection, idempotency, timeout reconciliation, status/log normalization and cleanup. Provider fixtures must cover both the service and sandbox paths for Railway and Vercel, both Fly resource kinds, Workbox REST/WS behavior and existing self-managed destinations.

Real-Docker tests can prove the Openship orchestration and a prepared Workbox host can prove Workbox sessions, checkpoints, secret references, output-gap handling and restart reconciliation. Neither proves a live Railway, Vercel or Fly account.

Opt-in live tests must create disposable projects/services/sandboxes/machines/sprites, use credentials supplied through environment references, fail when enabled but unavailable, record sanitized evidence and cleanup receipts, and verify account scope, resource limits, domains, snapshots, idle behavior and rollback. Browser/desktop journeys, DNS/HTTPS, billing, provider account limits, endurance and release qualification remain separate gates.

The current provider documentation is a moving target. Before implementation of each adapter, pin the SDK/API versions and rerun capability discovery against the live account. A successful API request, a provider dashboard record or a fixture replay is not evidence that the selected workload is ready, reachable, durable or safe to destroy.

## Open decisions

- Use Fly Sprites for the requested sprite workload; a future Workbox-native equivalent needs its own explicit contract.
- Qualify any future automatic Workbox host destination beyond connected Linux servers; a normal provider service must never bypass host capability checks.
- Decide how a common environment profile handles provider differences such as Railway idle timeout, Vercel snapshot retention and Fly Sprite sleep/wake.
- Expand the bounded live matrix to public ingress, application rollback, state retention and recovery, with explicit resource and spending limits.
