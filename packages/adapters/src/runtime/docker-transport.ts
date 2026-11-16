import Dockerode from "dockerode";
import { assertLocalHostExecutionAllowed } from "@repo/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor, SshConfig } from "../types";
import type { Duplex } from "node:stream";
import { createCloudDockerTransport } from "./cloud/docker-transport";

import { createDockerSshBridge, type DockerSshBridge } from "./docker-ssh-agent";
import type { DockerRegistryAuth } from "./docker-auth";

export interface DockerConnectionOptions extends Pick<SshConfig, "useSystemSsh" | "sshTransport" | "sshJumpHost" | "sshArgs"> {
  /** Transport type */
  transport?: "socket" | "ssh" | "tcp" | "cloud";

  /** Authenticated connection to a customer's workspace Docker socket. */
  cloudConnection?: () => Promise<Duplex>;

  /**
   * Pooled command executor for SSH transport.  When provided, Docker
   * API calls reuse the executor's SSH connection (via streamlocal
   * channel multiplexing) instead of creating a fresh SSH connection
   * per HTTP request.
   */
  executor?: CommandExecutor;

  /**
   * Registry credentials for an image pull, supplied by the caller.
   *
   * INJECTED rather than looked up here, because the answer lives in the database — an
   * org's stored registry logins — and adapters must not import @repo/db. The API builds
   * this closure when it constructs the runtime (it already has the organization id), so
   * the credential policy stays in the API and this package keeps knowing only how to
   * talk to Docker.
   *
   * Returning undefined means "pull anonymously". `pullImage` falls back to the HOST's
   * `~/.docker/config.json` when this is absent entirely, which is what keeps a bare
   * install working for an operator who has already run `docker login`.
   */
  resolveRegistryAuth?: (ref: string) => Promise<DockerRegistryAuth | undefined>;

  /**
   * Explicit Docker socket path. Honored by BOTH transports: the socket path to
   * dial locally, and the remote daemon socket to forward to over SSH.
   */
  dockerSocketPath?: string;

  /** Host for SSH / TCP transports */
  host?: string;
  /** Port (SSH default 22, TCP default 2376) */
  port?: number;

  /** SSH username */
  username?: string;
  /** SSH password (for servers configured with password auth) */
  password?: string;
  /** Decrypted SSH private key (PEM string). */
  privateKey?: string;
  /** Passphrase for the SSH private key (if the key itself is encrypted) */
  privateKeyPassphrase?: string;
  /** SSH agent socket path (alternative to privateKey) */
  sshAgent?: string;
  /** Custom host key verifier for SSH connections. */
  hostVerifier?: (hostKey: Buffer) => boolean;

  /** TLS CA certificate (for TCP transport) */
  ca?: string | Buffer;
  /** TLS client certificate (for TCP transport) */
  cert?: string | Buffer;
  /** TLS client key (for TCP transport) */
  key?: string | Buffer;

  /** Docker API request timeout in ms */
  timeout?: number;
}

export interface DockerTransport {
  kind: "socket" | "ssh" | "tcp" | "cloud";
  description: string;
  unreachableHint: string;
  /** Resolve dockerode options, standing up any transport machinery (e.g. the SSH bridge). */
  establish: () => Promise<Dockerode.DockerOptions>;
  /** Direct duplex for upgraded Docker requests; keeps transport half-close semantics. */
  openStream?: () => Promise<Duplex>;
  /** Tear down machinery created by establish(). Idempotent; safe to call when never established. */
  close: () => Promise<void>;
  preflight: () => Promise<void>;
}

export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

/** Memo for the CLI-context lookup, keyed by config dir + context name. */
const contextSocketCache = new Map<string, string | null>();

/** Reset the CLI-context memo. Tests only — the daemon doesn't move at runtime. */
export function clearDockerContextCache(): void {
  contextSocketCache.clear();
}

/**
 * The socket the docker CLI's ACTIVE CONTEXT points at, or null.
 *
 * Contexts are how Colima / Rancher Desktop / Podman / rootless Docker actually
 * advertise themselves today: they register a context and switch to it, and set
 * no `DOCKER_HOST` at all. Reading only `DOCKER_HOST` meant `docker ps` worked
 * in the operator's shell while Workbox Cloud reported no daemon on the very same
 * box — a self-hosted install that could not see its own Docker.
 *
 * Read from disk rather than by shelling out to `docker context inspect`: this
 * runs on the sync path (callers `existsSync` the result), and the layout is
 * stable — `<config>/config.json`'s `currentContext`, then
 * `<config>/contexts/meta/<sha256(name)>/meta.json`'s docker endpoint.
 *
 * `default` is not stored on disk: it means "DOCKER_HOST or the default socket",
 * both already handled by the caller, so it resolves to null here.
 */
function resolveDockerContextSocket(env: NodeJS.ProcessEnv): string | null {
  const configDir = env.DOCKER_CONFIG?.trim() || join(homedir(), ".docker");
  // DOCKER_CONTEXT beats config.json's currentContext, same as the CLI.
  let name = env.DOCKER_CONTEXT?.trim();
  const cacheKey = `${configDir}\u0000${name ?? ""}`;
  const cached = contextSocketCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let socket: string | null = null;
  try {
    if (!name) {
      const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
        currentContext?: unknown;
      };
      name = typeof config.currentContext === "string" ? config.currentContext.trim() : "";
    }
    if (name && name !== "default") {
      const digest = createHash("sha256").update(name).digest("hex");
      const meta = JSON.parse(
        readFileSync(join(configDir, "contexts", "meta", digest, "meta.json"), "utf8"),
      ) as { Endpoints?: { docker?: { Host?: unknown } } };
      const host = meta.Endpoints?.docker?.Host;
      if (typeof host === "string" && host.startsWith("unix://")) {
        const path = host.slice("unix://".length).trim();
        // A context can also be ssh:// or tcp://; the socket transport can't dial
        // either, and TCP needs mutual TLS material it doesn't carry.
        if (path.startsWith("/")) socket = path;
      }
    }
  } catch {
    // No docker config, no such context, unreadable JSON — all mean "no context
    // to honor", never a hard failure.
  }
  contextSocketCache.set(cacheKey, socket);
  return socket;
}

/**
 * Which UNIX socket a LOCAL docker connection dials, in precedence order:
 *
 *   1. an explicit `dockerSocketPath`
 *   2. `DOCKER_HOST` — the docker CLI's own knob, either `unix:///path` or a
 *      bare absolute path. Every non-Docker-Desktop daemon on macOS (Colima,
 *      Rancher, Podman) and rootless Docker on Linux put their socket somewhere
 *      other than the default and advertise it through this variable; hardcoding
 *      the default made those daemons unreachable for local deploys.
 *   3. the docker CLI's active CONTEXT (see `resolveDockerContextSocket`) — the
 *      same daemons advertise themselves this way when the operator never
 *      exported `DOCKER_HOST`, which is the common case after `colima start`.
 *      Cached: it touches the filesystem, and the daemon doesn't move.
 *   4. `/var/run/docker.sock`
 *
 * A non-`unix://` DOCKER_HOST (e.g. `tcp://`) is ignored here — the socket
 * transport can't dial it, and TCP needs mutual TLS material (see below).
 */
export function resolveLocalDockerSocketPath(
  opts?: Pick<DockerConnectionOptions, "dockerSocketPath">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = opts?.dockerSocketPath?.trim();
  if (explicit) return explicit;

  const host = env.DOCKER_HOST?.trim();
  if (host) {
    if (host.startsWith("unix://")) {
      const path = host.slice("unix://".length).trim();
      if (path.startsWith("/")) return path;
    } else if (host.startsWith("/")) {
      return host;
    }
  }

  return resolveDockerContextSocket(env) ?? DEFAULT_DOCKER_SOCKET_PATH;
}

export function resolveDockerTransport(opts?: DockerConnectionOptions): DockerTransport {
  if (opts?.transport === "cloud") {
    if (!opts.cloudConnection || !opts.executor) {
      throw new Error("Cloud Docker requires an authenticated workspace connection and executor");
    }
    return createCloudDockerTransport(opts.cloudConnection);
  }
  if (!opts || !opts.transport || opts.transport === "socket") {
    assertLocalHostExecutionAllowed();
    const socketPath = resolveLocalDockerSocketPath(opts);
    return {
      kind: "socket",
      description: `local Docker daemon via socket (${socketPath})`,
      unreachableHint:
        socketPath === DEFAULT_DOCKER_SOCKET_PATH
          ? "Check that the local Docker daemon is running. If it isn't Docker Desktop (Colima, Rancher, Podman, rootless), select its `docker context` or set DOCKER_HOST to its socket."
          : `Check that the local Docker daemon is running and listening on ${socketPath} (from dockerSocketPath / DOCKER_HOST / the active docker context).`,
      establish: async () => {
        assertLocalHostExecutionAllowed();
        return { socketPath };
      },
      close: async () => {},
      preflight: async () => {},
    };
  }

  if (opts.transport === "ssh") {
    if (!opts.privateKey && !opts.sshAgent && !opts.password) {
      throw new Error("SSH transport requires one of privateKey, sshAgent, or password.");
    }

    let bridge: DockerSshBridge | null = null;

    return {
      kind: "ssh",
      description: `remote Docker daemon via SSH (${opts.host ?? "unknown-host"})`,
      unreachableHint:
        "Check that SSH credentials are correct, Docker is running on the server, and the SSH user can access the Docker daemon (in the `docker` group or root). The transport uses SSH socket forwarding where available and falls back to `docker system dial-stdio` over an exec channel otherwise.",
      establish: async () => {
        bridge = createDockerSshBridge(opts);
        const { host, port } = await bridge.start();
        return {
          protocol: "http",
          host,
          port,
          timeout: opts.timeout ?? 600_000,
        };
      },
      close: async () => {
        bridge?.close();
        bridge = null;
      },
      // Decide the upstream transport (streamlocal vs dial-stdio) up front so
      // the daemon `ping()` in assertReachable runs over the working one. The
      // ping itself is the real reachability check.
      preflight: async () => {
        await bridge?.probe();
      },
    };
  }

  if (!opts.ca || !opts.cert || !opts.key) {
    throw new Error(
      "TCP transport requires ca, cert, and key for mutual TLS. Plaintext TCP connections are not supported for security reasons.",
    );
  }

  return {
    kind: "tcp",
    description: `remote Docker daemon via TLS (${opts.host ?? "unknown-host"}:${opts.port ?? 2376})`,
    unreachableHint: "Check that the remote Docker daemon is reachable and the TLS certificates are valid.",
    establish: async () => ({
      protocol: "https",
      host: opts.host,
      port: opts.port ?? 2376,
      ca: opts.ca as string | undefined,
      cert: opts.cert as string | undefined,
      key: opts.key as string | undefined,
      timeout: opts.timeout ?? 30_000,
    }),
    close: async () => {},
    preflight: async () => {},
  };
}
