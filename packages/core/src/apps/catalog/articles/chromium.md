## Chromium on your own server

Chromium runs on your server and streams its window to your browser. This is an interactive workspace for a person. Use Selenium Chromium from the catalog for automated WebDriver tests.

## Access and storage

Installation generates a password for the Caddy access gateway. The endpoint starts private; open it through a local tunnel, or explicitly choose a HTTPS domain. Only the gateway receives a route. Shared-session links, desktop sudo and terminal launchers are disabled. This remains a network-connected browser, so use a dedicated server when separating trusted and untrusted activity.

The project volume preserves `/config`, including profiles, settings and local files. Back it up before deleting storage. The template requests 1 GiB of container shared memory and a server with at least two CPU cores and 3 GiB RAM. It currently supports connected self-managed Docker hosts.

## Sources

The image is published by LinuxServer.io and pinned to a reviewed release and digest. Container packaging is GPL-3.0; bundled applications retain their own licenses. Workbox Cloud adds the access gateway and installation metadata. The Caddy gateway is Apache-2.0.

[Image documentation](https://docs.linuxserver.io/images/docker-chromium/) · [Source and license](https://github.com/linuxserver/docker-chromium) · [Security guidance](https://docs.linuxserver.io/selkies/user-guide/security/)
