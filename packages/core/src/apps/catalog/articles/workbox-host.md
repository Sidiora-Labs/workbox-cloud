## A server ready for Workbox sandboxes

Choose a connected x86_64 Debian or Ubuntu server with systemd, cgroup v2 and root or passwordless sudo access. Preparation checks host capabilities and free storage before changing the server. The host is a Linux VPS or physical machine; an ordinary service container does not meet these requirements.

The installer downloads a pinned Workbox revision, installs its tools, builds a sandbox filesystem and runtime, and verifies the daemon. Choose the minimal filesystem or the agents filesystem during setup. Progress and failed steps remain visible, so interrupted preparation can be retried against the same owned installation.

The daemon listens only on the server's loopback interface. Workbox Cloud registers its generated API key encrypted and uses the existing SSH connection to reach the private API. No public API port or separate TLS domain is required.

Once the host is ready, select **Create sandbox** to launch a Workbox child through the unified workload interface. The host and its sandboxes have separate lifecycles. Stop or start the host from its management screen; remove its sandboxes before removing the daemon. Removal disables the managed service and connection while retaining host files and package installations.

Source: [Sidiora-Labs Workbox deployment guide](https://github.com/Sidiora-Labs/workbox/blob/9741e30334139bbe7e28cd5c034e345c616a470a/docs/guides/deploy.md).
