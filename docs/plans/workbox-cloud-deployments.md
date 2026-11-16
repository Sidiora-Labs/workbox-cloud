# Unified provider deployments, sandboxes and Workbox

Proposed scope: extend Openship's existing deployment engine so one explicit destination flow can operate service containers, provider-managed sandboxes, VM-like machines and Workbox workloads across Railway, multiple Vercel accounts, Fly.io and self-managed servers. The normative planning source is [spec/workbox-cloud-deployments/spec.kvx](../../spec/workbox-cloud-deployments/spec.kvx). This fork has no KVX renderer, so the KVX file is an authored source artifact and this document is the human-readable implementation plan.

The current checkout already provides the host deployment foundation: Docker, Bare, Compose, Kubernetes, SSH/self-managed servers, managed Cloud destinations, organization-scoped encrypted credentials, migration adapters for Railway and Vercel, dashboard destination selection, CLI deployment commands and SDK operations. Railway/Vercel support today is primarily migration-oriented; it does not yet provide a provider-neutral deploy adapter for their current sandbox APIs. The implementation must add that layer beside the existing host runtime adapters.

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
- A Workbox host and a Workbox sandbox are distinct. Native Railway or Vercel sandboxes can implement normalized sandbox actions directly, but they retain native provider provenance and are not called Workbox unless the Workbox adapter is actually driving them.

## Target and operation model

Add a provider-neutral external deployment layer below shared platform operations and beside the existing host runtime adapters. It should expose:

`discover → capabilities → preflight → plan → apply → observe → logs → exec/session → files → snapshot/checkpoint → stop/resume → promote/rollback → destroy → reconcile`

A target contains:

- `provider`: `railway`, `vercel`, `fly`, `self-managed`, or `workbox`;
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

**Self-managed server.** Extend only the target registry and unified UI. Reuse the current server and cluster operations, SSH transport, Docker/Bare/Compose/Kubernetes runtimes, routing/TLS and host security. Do not duplicate the existing engine.

## Workbox integration

Workbox upstream at commit `9741e30334139bbe7e28cd5c034e345c616a470a` provides REST, WebSocket, SDK, MCP and CLI surfaces for sandboxes. Its own provider mapping describes twelve operations — capabilities, prepare, create, list, observe, attach, execute, inspect, stop, transfer, lifetime and destroy — and records partial or missing behavior for capabilities, lifetime, attach, transfer and output digests ([Workbox repository](https://github.com/Sidiora-Labs/workbox), [provider mapping](https://github.com/Sidiora-Labs/workbox/blob/main/docs/hyperfide-provider.md)).

The adapter will:

1. deploy or connect to a Workbox host and store only an encrypted, scoped API-key reference;
2. run Workbox doctor/readyz and project the host's rootfs, runtime, user namespace, cgroup v2, subordinate-ID, bubblewrap, overlayfs and nftables capabilities;
3. map Openship environment intent to Workbox rootfs/runtime/profile/limits/network/labels/secretRefs and idempotency keys;
4. create and observe child Workbox sandboxes, stream sessions/events, expose files, artifacts, asks and checkpoints, and preserve output gaps and reconciliation state; and
5. keep native Railway Sandbox, Vercel Sandbox and Fly Sprite resources distinct, even when a common environment profile supplies names, limits, secrets or checkpoint intent.

Workbox's server deployment guide requires privileged Linux host capabilities for its daemon container — subordinate UID mapping, cgroup v2, overlayfs, bubblewrap and nftables ([Workbox deployment requirements](https://github.com/Sidiora-Labs/workbox/blob/main/docs/guides/deploy.md)). The preflight therefore blocks a Workbox host on a target that cannot prove those capabilities. Railway and Vercel native Sandboxes can still be selected as their own sandbox workloads; that does not imply that a normal Railway or Vercel service can host a Workbox daemon.

The requested “sprite machine” option resolves to `fly-sprite` using Fly's separate Sprites API. Workbox currently has no sprite primitive, so a future Workbox sprite profile requires a new upstream contract or an explicit Openship adapter decision; it cannot be inferred from a Workbox sandbox ID.

## Interface plan

The dashboard target step will replace the current four-target assumption with:

1. provider and account/workspace;
2. project/environment or resource namespace;
3. workload kind (service, sandbox, machine, Workbox host or Workbox sandbox);
4. provider capability and quota warnings;
5. resource-specific configuration; and
6. a review showing exact target IDs, source/image digest, environment revision, routes, persistence, idle policy and cost-bearing settings.

Service detail pages retain deployment revision, readiness, logs, domains and rollback. Sandbox detail pages show sessions, exec, files, snapshot/checkpoint lineage, idle state, network policy and destroy. Machine detail pages show region, health, volumes, lifecycle and provider URL. Workbox pages add scoped sandbox/session/event/artifact/ask views and a clear host-versus-child boundary.

CLI and SDK operations accept an explicit destination/target and connection ID. `--server` remains a compatibility alias for self-managed targets. HTTP, native SDK and CLI enter the same authorized platform operations and return normalized status, provider IDs, capabilities, URLs, operation IDs and reconciliation state.

## Phased implementation

1. **Vocabulary and contracts.** Add workload kinds, target records, provider capability descriptors and normalized operation schemas. Keep migration source adapters separate from deployment adapters.
2. **Connections and durable state.** Extend the existing credential registry with deploy/sandbox capabilities, provider identity verification, Vercel account/team selectors, Fly origins and Workbox endpoint/key references. Add target bindings, immutable snapshots, operation idempotency and reconciliation records.
3. **Provider adapters.** Implement Railway service and Sandbox, Vercel project and Sandbox, Fly Machine and Sprite, and the Workbox remote/host adapters. Each adapter must have bounded fetch, redaction, capability checks, inspect-after-timeout and provider-specific status mapping.
4. **Unified surfaces.** Update dashboard, desktop, CLI and SDK target selection, resource detail pages, logs/session streams, localized labels and provider icons. Preserve self-managed server behavior and existing migration flows.
5. **Qualification and documentation.** Add contract and fixture suites, real Docker and prepared Workbox-host tests, opt-in disposable live matrices, recovery/endurance cases and operator documentation. Publish evidence by class rather than one undifferentiated “integration complete” claim.

## Checkout implementation checkpoint

The implementation slices in this checkout now include the provider-neutral
contracts, encrypted connection capability metadata, durable target and
operation persistence, account-scoped Railway/Vercel/Fly/Workbox adapters,
Vercel Sandbox SDK creation/observation, Railway service-versus-Sandbox
separation, Workbox host readiness and child-sandbox operations, the shared
HTTP/native/SDK/CLI boundary, explicit target listing, and the dashboard
destination component. Existing SSH/Docker/Bare/Compose/Kubernetes
self-managed destinations remain on their original runtime path.

The remaining qualification work is deliberate: Railway Sandbox command,
session, file and checkpoint actions require an injected Railway SDK transport;
the current GraphQL fallback reports those capabilities as unsupported. No live
Railway, Vercel, Fly or Workbox account test has been run in this checkout, and
the generated fixture, browser, DNS, billing, endurance and release evidence
must not be inferred from the passing unit, type, build or documentation checks.

## Verification and limits

Component evidence must include provider-neutral adapter contracts, schema/auth tests, redaction tests, target isolation, capability rejection, idempotency, timeout reconciliation, status/log normalization and cleanup. Provider fixtures must cover both the service and sandbox paths for Railway and Vercel, both Fly resource kinds, Workbox REST/WS behavior and existing self-managed destinations.

Real-Docker tests can prove the Openship orchestration and a prepared Workbox host can prove Workbox sessions, checkpoints, secret references, output-gap handling and restart reconciliation. Neither proves a live Railway, Vercel or Fly account.

Opt-in live tests must create disposable projects/services/sandboxes/machines/sprites, use credentials supplied through environment references, fail when enabled but unavailable, record sanitized evidence and cleanup receipts, and verify account scope, resource limits, domains, snapshots, idle behavior and rollback. Browser/desktop journeys, DNS/HTTPS, billing, provider account limits, endurance and release qualification remain separate gates.

The current provider documentation is a moving target. Before implementation of each adapter, pin the SDK/API versions and rerun capability discovery against the live account. A successful API request, a provider dashboard record or a fixture replay is not evidence that the selected workload is ready, reachable, durable or safe to destroy.

## Open decisions

- Confirm whether “sprite machine” always means Fly Sprites or whether a future Workbox-native sprite profile is required.
- Decide whether a Workbox host may be provisioned on a Fly Machine after doctor/readyz qualification, or must remain self-managed when privileged host capabilities are unavailable.
- Decide how a common environment profile handles provider differences such as Railway idle timeout, Vercel snapshot retention and Fly Sprite sleep/wake.
- Set the first live qualification matrix and spending limits for disposable provider resources.
