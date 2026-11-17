## Chromium for automated browser tests

This installs Selenium Standalone Chromium for WebDriver clients. It creates a fresh browser session for each test; it is not a persistent interactive desktop. A Caddy gateway protects every exposed API route with generated HTTP Basic credentials.

## Connect and manage

The endpoint starts private. Use it from the project network or a local tunnel, or choose a HTTPS domain for remote test clients. Pass the endpoint, username and password shown under Connection to your WebDriver client. Always call `driver.quit()` after a test.

One concurrent session and a five-minute idle timeout are the defaults. Change these limits in Workbox Cloud settings and redeploy. VNC, noVNC and Chrome DevTools forwarding are disabled. This template exposes WebDriver commands; it does not advertise a Playwright/CDP endpoint. The template requests 2 GiB shared memory and at least two CPU cores and 3 GiB server memory; increase resources before increasing concurrency. No profile volume is mounted, so browser sessions do not survive recreation.

## Sources

The official Selenium image is pinned to `4.52.0-20261101` and its multi-architecture digest. The container project and Caddy gateway are Apache-2.0; bundled browser components retain their licenses. This template currently supports connected self-managed Docker hosts.

[Selenium Docker documentation](https://github.com/SeleniumHQ/docker-selenium) · [Pinned release](https://github.com/SeleniumHQ/docker-selenium/releases/tag/4.52.0-20261101) · [Container license](https://github.com/SeleniumHQ/docker-selenium/blob/trunk/LICENSE.md)
