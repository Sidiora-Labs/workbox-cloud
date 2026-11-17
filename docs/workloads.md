# Deploy and manage workloads

Open **Workloads** in the Workbox Cloud navigation, then select **New workload**. The direct paths are `/workloads` and `/workloads/new` on your Workbox Cloud instance.

For a ready-to-install application, open **Apps → Install app**. The catalog offers each app’s supported server and provider destinations, including browser applications and prepared Workbox hosts. See the [catalog guide](app-catalog.md) for installation and management. Use **Workloads** for direct provider workload configuration.

## Choose infrastructure

Choose **Workbox Cloud & your servers** for the existing app deployment flow. Select a connected VPS, bare-metal server or managed Cloud workspace in the destination picker, then select **Choose source or app**. The library opens with that destination saved as the deployment default; select your source or catalog application. You can change the destination in the deployment wizard before deploying. The server's supported runtime determines the available Docker, direct host, Compose or cluster options. Use **Manage servers** to connect or inspect infrastructure.

Choose **Railway**, **Vercel**, **Fly.io**, **Blaxel** or **Workbox environments** for a provider workload. Select a named connection explicitly. If no connection is listed, use **Add a connection** to configure one in Settings, then return to the launch page. Different accounts or teams remain separate choices.

| Choice | Select and configure | Lifecycle to expect |
| --- | --- | --- |
| Railway application/service | Project, environment, new or existing service, image or Git source, variables | Provider service deployment; distinct from a sandbox VM |
| Railway Sandbox | Project, environment, region and supported sandbox settings; install tools or clone source using Run command after creation | Isolated VM with its own idle lifetime; use a service for ordinary production hosting |
| Vercel project | Existing project and optional Git repository/branch override | Vercel project build and deployment; container images are not a generic project source |
| Vercel Sandbox | Project, name, optional managed/custom image, ports, persistence and session timeout | Persistent sandbox identity with separate sessions; checking status does not resume it |
| Fly Machine | Existing or new Fly application, image, region and resources | Application machine with its own provider identity |
| Fly Sprite | Name and a connection containing a separate Sprites token | Persistent development computer; a Machines token alone does not enable Sprites |
| Blaxel Sandbox | Name, region, Blaxel image, memory and lifetime | Automatic standby preserves state; lifetime expiry deletes the sandbox |
| Blaxel application | Name, region and workspace registry image | Application hosting is in private preview; workspace access is required |
| Workbox Sandbox | Connected Workbox host, name and supported prepared rootfs/runtime settings | Child sandbox managed through that host's Workbox API |

Projects, environments and Fly applications are loaded from the selected connection where discovery is available. **Enter provider IDs manually** is a fallback; the provider still validates those IDs during review. An empty provider workload list means nothing has been launched through Workbox Cloud yet; connecting an account does not import or adopt every resource in that account.

## Review and launch

Enter the workload name and provider-specific settings. Where shown, environment variables use one `NAME=value` entry per line. Vercel project deployments use the environment configured on the selected Vercel project. Values are not displayed in the deployment review.

Select **Review deployment**. Workbox Cloud checks the selected connection and destination, then validates a deployment plan. Read any blockers, persistence or preview warnings. A blocked plan cannot be deployed. Editing the settings invalidates the previous review; plans also expire.

Select **Deploy workload** after reviewing an accepted plan. This can create or update resources and incur the provider's normal usage charges. The workload appears in **Workloads** with its operation state. A provisioning response is not a readiness result. Pending workloads are checked automatically; **Check status** observes a single workload, while **Refresh** checks listed provider workloads.

## Manage a workload

Use the infrastructure filters to find a native project or provider workload. Native cards open the existing project controls. Provider cards show the selected connection, workload kind, last observation, provider state and resource identifiers.

- **Check status** refreshes the provider observation.
- **Run command** appears when command execution is supported by that adapter. Output and the command's exit status are shown in the card.
- **Delete** appears when deletion is supported. Type the displayed workload name to confirm. Workbox Cloud records deletion intent before calling the provider; an ambiguous outcome remains visible for inspection. Deleting a sandbox may permanently remove its local files.

Refresh the list or reopen the page to restore persisted operations. A failed or unknown operation stays visible for inspection. Do not assume that a network error means the provider created nothing; inspect the resource and operation before launching a replacement.

## Workbox hosts and provider limits

**Workbox environments** creates child sandboxes through a connected daemon. To prepare one automatically, select **Workbox prepared host** in the app catalog and choose a compatible connected Linux server. You can also connect an existing daemon in Settings. Host preparation and child sandbox creation have separate progress and lifecycle controls; both require the Linux capabilities checked by Workbox. Native Railway/Vercel sandboxes and Fly Sprites keep their own identities and APIs. See [connected Workbox hosts](workbox-connected-hosts.md) for prepared filesystem/runtime requirements, profile settings and the exact supported operations.

The interface exposes the capabilities implemented by each adapter. A provider may also offer snapshots, files, sessions, volumes, custom domains, rollback or archive controls that are not yet available in this screen. Those features require separate implementation and validation.

Blaxel Applications are [private preview](https://docs.blaxel.ai/Applications/Overview). Blaxel [sandbox standby](https://docs.blaxel.ai/Sandboxes/Overview) and lifetime deletion are different states. Blaxel images must satisfy the selected workload's registry requirements; a Docker registry URL is not interchangeable with a prepared Blaxel image.

## Verification status

A verified connection proves that the supplied credentials can access the tested provider API. It does not prove a new workload can launch, become ready, serve traffic, retain data or be deleted. Consult the current test and deployment receipts for those separate checks. Local component tests, authenticated browser checks, live provider creation/cleanup, DNS and release qualification are reported separately in the [implementation plan](plans/workbox-cloud-deployments.md).
