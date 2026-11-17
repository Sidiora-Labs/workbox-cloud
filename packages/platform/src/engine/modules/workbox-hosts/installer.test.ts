import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "@repo/adapters";
import {
  hostSteps,
  assertWorkboxHostIdle,
  runManagedWorkboxCommand,
  installWorkboxHost,
  privateRequest,
  probeWorkboxHost,
  WORKBOX_REVISION,
  WORKBOX_PORT,
  WORKBOX_CONFIG,
  WORKBOX_HOME,
} from "./installer";
const fake = (override: Partial<CommandExecutor> = {}) =>
  ({
    exec: async (command: string) =>
      command === "id -u"
        ? "0"
        : command === "cat /etc/machine-id"
          ? "0123456789abcdef0123456789abcdef"
          : command.includes("doctor --json")
            ? '{"ok":true}'
            : "",
    exists: async () => false,
    readFile: async () =>
      JSON.stringify({
        status: 200,
        headers: {},
        body: Buffer.from('{"sandboxes":[]}').toString("base64"),
      }),
    writeFile: async () => {},
    execWithInput: async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: 200,
        headers: {},
        body: Buffer.from('{"sandboxes":[]}').toString("base64"),
      }),
    }),
    ...override,
  }) as CommandExecutor;
describe("managed Workbox installer", () => {
  it("rejects incompatible cgroup hosts before installation", async () => {
    const result = await probeWorkboxHost(
      fake({
        exec: async (command) => {
          if (command === "id -u") return "0";
          if (command === "cat /etc/machine-id") return "0123456789abcdef0123456789abcdef";
          if (command.includes("cgroup.controllers")) throw Error("missing");
          return "";
        },
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.checks.find((c) => c.id === "cgroup")?.ok).toBe(false);
  });
  it("rejects unmanaged installation paths rather than adopting them", async () => {
    const result = await probeWorkboxHost(
      fake({ exists: async () => true, readFile: async () => '{"id":"foreign"}' }),
    );
    expect(result.accepted).toBe(false);
    expect(result.checks.find((c) => c.id === "ownership")?.ok).toBe(false);
  });
  it("pins source, builds rootfs and runtime, and never writes raw key to host configuration or command argv", async () => {
    const commands: string[] = [];
    const files: { path: string; content: string }[] = [];
    const stages: string[] = [];
    const token = "private-workbox-credential";
    const executor = fake({
      exec: async (command) => {
        commands.push(command);
        return command === "id -u" ? "0" : command.includes("doctor --json") ? '{"ok":true}' : "";
      },
      writeFile: async (path, content) => {
        files.push({ path, content });
      },
    });
    await installWorkboxHost(
      executor,
      {
        id: "wbhost_1",
        organizationId: "org_1",
        identity: "0123456789abcdef0123456789abcdef",
        rootfs: "agents",
        token,
      },
      async (id) => {
        stages.push(id);
      },
    );
    expect(commands.join("\n")).toContain(WORKBOX_REVISION);
    expect(commands.join("\n")).toContain("rootfs build minimal");
    expect(commands.join("\n")).toContain("rootfs build agents");
    expect(commands.join("\n")).toContain("runtime.ensureFresh()");
    expect(commands.join("\n")).toContain("install -d -m 755");
    expect(commands.join("\n")).not.toContain(token);
    expect(JSON.stringify(files)).not.toContain(token);
    expect(files.find((f) => f.path.endsWith("serve.json"))?.content).toContain("tokenSha256");
    expect(stages).toEqual(
      hostSteps()
        .filter((s) => s.id !== "connection")
        .map((s) => s.id),
    );
  });
  it("sends auth and body on private stdin and refuses non-loopback destinations", async () => {
    let argv = "";
    let payload = "";
    const executor = fake({
      execWithInput: async (command, body) => {
        argv = command;
        for await (const chunk of body) payload += chunk;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            status: 200,
            headers: {},
            body: Buffer.from("{}").toString("base64"),
          }),
        };
      },
    });
    await privateRequest(executor, "/v1/sandboxes", {
      method: "POST",
      headers: { Authorization: "Bearer private-key" },
      body: '{"name":"demo"}',
    });
    expect(argv).not.toContain("private-key");
    expect(payload).toContain("private-key");
    expect(payload).toContain(`127.0.0.1:${WORKBOX_PORT}`);
    await expect(privateRequest(executor, "https://attacker.example/", {})).rejects.toThrow(
      "Invalid private Workbox",
    );
  });
  it("does not start daemon when doctor reports isolation failure", async () => {
    const commands: string[] = [];
    const executor = fake({
      exec: async (command) => {
        commands.push(command);
        return command === "id -u" ? "0" : command.includes("doctor --json") ? '{"ok":false}' : "";
      },
    });
    await expect(
      installWorkboxHost(
        executor,
        { id: "x", organizationId: "org", identity: "id", rootfs: "minimal", token: "secret" },
        async () => {},
      ),
    ).rejects.toThrow("doctor");
    expect(commands.some((c) => c.includes("enable --now"))).toBe(false);
  });
  it("elevates private requests on supported non-root SSH connections", async () => {
    let command = "";
    const executor = fake({
      exec: async (cmd) => (cmd === "id -u" ? "1000" : ""),
      execWithInput: async (cmd) => {
        command = cmd;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            status: 200,
            headers: {},
            body: Buffer.from("{}").toString("base64"),
          }),
        };
      },
    });
    await privateRequest(executor, "/readyz", {});
    expect(command).toContain("sudo -n");
  });

  it("reuses only a matching prepared rootfs on retry", async () => {
    const commands: string[] = [];
    const executor = fake({
      exists: async (path) => path.endsWith("/manifest.json"),
      readFile: async (path) =>
        path.endsWith("/manifest.json")
          ? JSON.stringify({ uid: { base: 300000 }, source: { dockerfileSha256: "abcd" } })
          : JSON.stringify({
              status: 200,
              headers: {},
              body: Buffer.from('{"sandboxes":[]}').toString("base64"),
            }),
      exec: async (command) => {
        commands.push(command);
        return command === "id -u"
          ? "0"
          : command.startsWith("sha256sum")
            ? "abcd  Dockerfile"
            : command.includes("doctor --json")
              ? '{"ok":true}'
              : "";
      },
    });
    await installWorkboxHost(
      executor,
      { id: "retry", organizationId: "org", identity: "id", rootfs: "minimal", token: "secret" },
      async () => {},
    );
    expect(commands.some((command) => command.includes("rootfs build"))).toBe(false);
    const mismatch = fake({
      exists: async (path) => path.endsWith("/manifest.json"),
      readFile: async () => JSON.stringify({ uid: { base: 100000 } }),
    });
    await expect(
      installWorkboxHost(
        mismatch,
        { id: "retry", organizationId: "org", identity: "id", rootfs: "minimal", token: "secret" },
        async () => {},
      ),
    ).rejects.toThrow("does not match");
  });
  it("preserves an existing Docker CE daemon and does not install competing docker.io", async () => {
    const commands: string[] = [];
    const executor = fake({
      exec: async (command) => {
        commands.push(command);
        return command === "id -u" ? "0" : command.includes("doctor --json") ? '{"ok":true}' : "";
      },
    });
    await installWorkboxHost(
      executor,
      {
        id: "host",
        organizationId: "org",
        identity: "identity",
        rootfs: "minimal",
        token: "secret",
      },
      async () => {},
    );
    expect(commands.find((command) => command.includes("apt-get install"))).not.toContain(
      "docker.io",
    );
    expect(commands.join("\n")).not.toContain("systemctl start docker");
    expect(commands.some((command) => command.includes("docker info >/dev/null"))).toBe(true);
  });
  it("rejects ARM hosts because the pinned upstream sandbox runtime is x64-only", async () => {
    const result = await probeWorkboxHost(
      fake({
        exec: async (command) => {
          if (command === "id -u") return "0";
          if (command === "cat /etc/machine-id") return "0123456789abcdef0123456789abcdef";
          if (command.includes("uname -m")) throw Error("arm64");
          return "";
        },
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.checks.find((check) => check.id === "linux")?.ok).toBe(false);
  });
  it("transports responses beyond the stdout tail in root-only files and cleans up on success or failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbox-response-"));
    const body = JSON.stringify({ output: "x".repeat(128 * 1024) });
    const server = createServer((_req, response) => response.end(body));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const rewrite = (command: string) =>
      command
        .replaceAll(`${WORKBOX_HOME}/node/bin/node`, process.execPath)
        .replaceAll(WORKBOX_CONFIG, directory);
    const run = (command: string, input = "") =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn("sh", ["-c", rewrite(command)]);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout = (stdout + chunk).slice(-16 * 1024);
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-16 * 1024);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(input);
      });
    let responseMode = 0;
    const executor = fake({
      exec: async (command) => (command === "id -u" ? "0" : (await run(command)).stdout),
      execWithInput: async (command, stream) => {
        let payload = "";
        for await (const chunk of stream) payload += chunk;
        const request = JSON.parse(payload);
        request.url = `http://127.0.0.1:${address.port}/`;
        return run(command, JSON.stringify(request));
      },
      readFile: async (path) => {
        const local = path.replace(WORKBOX_CONFIG, directory);
        responseMode = (await stat(local)).mode & 0o777;
        return readFile(local, "utf8");
      },
    });
    try {
      const response = await privateRequest(executor, "/v1/sandboxes", {});
      expect(await response.text()).toBe(body);
      expect(responseMode).toBe(0o600);
      expect(await readdir(directory)).toEqual([]);
      await expect(privateRequest(executor, "/v1/sandboxes", { maxBodyBytes: 32 })).rejects.toThrow(
        "Private Workbox API request failed",
      );
      expect(await readdir(directory)).toEqual([]);
      await expect(
        privateRequest({ ...executor, readFile: async () => "invalid" }, "/v1/sandboxes", {}),
      ).rejects.toThrow("Invalid private Workbox response");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps remote descendants locked after the caller disconnects until they finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbox-lock-"));
    const rewrite = (command: string) => command.replaceAll(WORKBOX_CONFIG, directory);
    let disconnected: ReturnType<typeof spawn> | undefined;
    const exec = (command: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn("sh", ["-c", rewrite(command)]);
        if (command.includes("/entered")) disconnected = child;
        let stdout = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(Error(`exit ${code}`))));
      });
    const root = fake({ exec });
    // The caller stops awaiting this remote-style process; it still owns the file lock.
    const running = runManagedWorkboxCommand(
      root,
      "touch " + directory + "/entered; sleep 1",
      1_000,
    );
    const completion = running.catch((error) => error);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await stat(join(directory, "entered"));
          break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      disconnected!.kill("SIGTERM");
      expect(await completion).toBeInstanceOf(Error);
      await expect(assertWorkboxHostIdle(root)).rejects.toThrow("still running");
      await expect(
        runManagedWorkboxCommand(root, "touch " + directory + "/overlap"),
      ).rejects.toThrow();
      await expect(stat(join(directory, "overlap"))).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await expect(assertWorkboxHostIdle(root)).resolves.toBeUndefined();
      await expect(runManagedWorkboxCommand(root, "true")).resolves.toBe("");
    } finally {
      await completion;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps the lock private without leaking its restrictive umask into asset creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbox-mask-"));
    const root = fake({
      exec: (command) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn("sh", [
            "-c",
            "umask 022; " + command.replaceAll(WORKBOX_CONFIG, directory),
          ]);
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve("") : reject(Error(`exit ${code}`))));
        }),
    });
    try {
      await runManagedWorkboxCommand(root, `mkdir '${directory}/asset'`);
      expect((await stat(join(directory, "provision.lock"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "asset"))).mode & 0o777).toBe(0o755);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
