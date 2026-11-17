# Workbox connected hosts

Workbox Cloud creates child sandboxes through a connected Workbox daemon. You can automatically prepare a compatible connected server from **Apps → Install app → Workbox prepared host**, or connect an existing daemon URL and scoped API key in **Settings → Connections**. The host and the child sandbox have separate lifecycles.

## Automatically prepare a host

The prepared-host flow uses the existing server connection and authenticated SSH execution. Select a self-managed server, run **Check compatibility**, choose a host name and the **Agents** or **Minimal** environment, then review and start installation.

The current installer supports x86_64 Debian or Ubuntu with running systemd, root access or passwordless sudo, cgroup v2 CPU/memory/process controllers, enabled user namespaces and at least 8 GiB of free working space. The server needs access to package repositories, Node.js downloads, GitHub and the container registry used to build the root filesystem. Its dedicated Workbox Cloud paths and private API port must be available; the installer will not overwrite an unmanaged installation occupying them.

Preparation installs the host tools, a pinned Workbox revision, its Node runtime and dependencies, subordinate-ID and cgroup configuration, the selected root filesystem and sandbox runtime. It runs Workbox's host checks, starts the managed systemd service, and verifies readiness plus authenticated sandbox inventory before saving a usable connection. The UI shows each stage; a completed shell command is not itself the readiness result.

The managed daemon listens on `127.0.0.1:8791`. Workbox Cloud reaches it over the server's authenticated SSH transport; no public API port or separate TLS domain is required. The saved connection is bound to the selected server, and its API token is encrypted. Host installation requires administrative authority because it installs packages and configures Linux isolation.

Open the prepared-host screen to inspect its progress or failure, refresh its state, retry a failed installation on the same recorded host, and start or stop its managed service. A retry preserves validated filesystem assets and refuses conflicting ownership. **Remove host** normally requires a running, reachable daemon and an empty sandbox inventory. Delete its child sandboxes first, then remove the host. Recovery removal is also allowed when the owned systemd unit is already absent and the service is inactive; it still checks the recorded host identity and ownership. Removal disables and removes the managed systemd unit and marks the saved connection invalid. The host record, sandbox data, source, runtime and installed packages remain; removal does not purge those files. Do not treat retained files as a running or connected environment.

An SSH timeout or lost connection can leave the original package task running on the server. A host operation lock prevents overlapping retries, removal, service actions and child mutations while that task is active. Wait for the busy guard to clear before retrying; do not kill the package manager or start a second preparation. The original task can finish safely after the SSH request ends.

Once the host is **ready**, select **Create sandbox**. The selected host connection carries through to the workload launcher. A normal provider application container cannot substitute for this prepared Linux host; the capability checks still apply to any server underneath Railway, Fly.io or another provider.

## Connect an existing daemon

For a daemon prepared outside Workbox Cloud, use the [upstream deployment instructions](https://github.com/Sidiora-Labs/workbox/blob/main/docs/guides/deploy.md), then save its URL and API key in **Settings → Connections**. The remote endpoint must be reachable by the control plane and follow its URL and network checks.

Workbox needs Linux user namespaces, cgroup v2 delegation, subordinate IDs, bubblewrap, overlayfs, network tooling and prepared rootfs/runtime assets. Its API does not expose an installable rootfs or runtime catalog. The upstream defaults are `minimal` for rootfs and `current` for runtime. Choose `agents` only when that filesystem is installed. An OCI application image cannot be substituted for a rootfs name.

Preflight checks health/readiness and verifies that the stored key can read protected sandbox inventory. Inventory access alone does not prove the upstream `admin` scope required to create a sandbox. A key bound only to existing sandbox IDs cannot create a new child; the upstream API reports that permission error.

## Configure and manage child sandboxes

The launch form maps CPU and memory into the Workbox profile. API callers may also supply supported network settings. Unknown profile fields and invalid numeric settings fail plan validation. Environment variables become `profile.env`; host-managed secrets use secret references. `fromCheckpoint` restores a disk checkpoint only when the selected host can access it. Environment values remain in the protected operation request and are not public target selectors.

The connected-host adapter supports create, observe, execute, destroy and reconcile. Workbox's direct API also provides sessions, files and disk checkpoints; a direct API capability is not automatically a control in the Workbox Cloud workload manager. Child sandboxes do not acquire public service URLs, shared private networks or provider-controlled idle expiration through this adapter. Destroying a child removes its writable filesystem.

Workbox child sandboxes, Railway Sandboxes, Vercel Sandboxes and Fly Sprites retain their own resource identities and APIs. A host installation does not convert one resource kind into another.

The installer and adapter contract are pinned to Workbox commit `9741e30334139bbe7e28cd5c034e345c616a470a`:
[create schema](https://github.com/Sidiora-Labs/workbox/blob/9741e30334139bbe7e28cd5c034e345c616a470a/packages/server/src/server.js),
[provider mapping](https://github.com/Sidiora-Labs/workbox/blob/9741e30334139bbe7e28cd5c034e345c616a470a/docs/hyperfide-provider.md),
[configuration defaults](https://github.com/Sidiora-Labs/workbox/blob/9741e30334139bbe7e28cd5c034e345c616a470a/packages/core/src/config.js).
