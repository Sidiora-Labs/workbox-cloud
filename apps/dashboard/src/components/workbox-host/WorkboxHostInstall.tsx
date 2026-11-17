"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { InstallStepper, type StepItem } from "@/components/deploy/InstallStepper";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/PageContainer";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { getApiErrorMessage } from "@/lib/api/client";
import {
  workboxHostsApi,
  type WorkboxHost,
  type WorkboxHostPreflight,
} from "@/lib/api/workbox-hosts";

const pending = (host: WorkboxHost | null) =>
  !!host && ["queued", "installing", "removing"].includes(host.status);

export function WorkboxHostInstall() {
  const scope = useResourceScope();
  const router = useRouter();
  const params = useSearchParams();
  const requestedHost = params.get("hostId");
  const owner = useRef(scope);
  owner.current = scope;
  const revision = useRef(0);
  const submission = useRef(false);
  const [server, setServer] = useState<ServerOption | null>(null);
  const [serverReady, setServerReady] = useState(false);
  const [name, setName] = useState("Workbox host");
  const [rootfs, setRootfs] = useState<"minimal" | "agents">("agents");
  const [preflight, setPreflight] = useState<WorkboxHostPreflight | null>(null);
  const [checkedServer, setCheckedServer] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeName, setRemoveName] = useState("");
  const [host, setHost] = useState<WorkboxHost | null>(null);
  const [hosts, setHosts] = useState<WorkboxHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");

  const loadHosts = useCallback(async () => {
    const expectedScope = scope;
    try {
      const response = await workboxHostsApi.list();
      if (owner.current !== expectedScope) return;
      setHosts(response.data);
      setListError("");
    } catch (error) {
      if (owner.current === expectedScope) setListError(getApiErrorMessage(error));
    } finally {
      if (owner.current === expectedScope) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    revision.current++;
    submission.current = false;
    setServer(null);
    setServerReady(false);
    setPreflight(null);
    setCheckedServer("");
    setConfirmed(false);
    setRemoving(false);
    setRemoveName("");
    setHost(null);
    setHosts([]);
    setLoading(true);
    setBusy(false);
    setError("");
    void loadHosts();
  }, [loadHosts]);

  useEffect(() => {
    if (!requestedHost) return;
    let active = true;
    const expectedScope = scope;
    void workboxHostsApi.get(requestedHost).then(
      (response) => {
        if (active && owner.current === expectedScope) setHost(response.data);
      },
      (error) => {
        if (active && owner.current === expectedScope) setError(getApiErrorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [requestedHost, scope]);

  useEffect(() => {
    if (!pending(host)) return;
    const expectedScope = scope;
    const id = host!.id;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await workboxHostsApi.get(id);
        if (active && owner.current === expectedScope) {
          setHost(response.data);
          setError("");
          if (!pending(response.data)) void loadHosts();
        }
      } catch (error) {
        if (active && owner.current === expectedScope) setError(getApiErrorMessage(error));
      }
    }, 3_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [host, scope, loadHosts]);

  const run = async (work: () => Promise<void>) => {
    if (submission.current) return;
    submission.current = true;
    setBusy(true);
    setError("");
    const expectedScope = scope;
    const request = ++revision.current;
    try {
      await work();
    } catch (error) {
      if (owner.current === expectedScope && request === revision.current)
        setError(getApiErrorMessage(error));
    } finally {
      if (owner.current === expectedScope && request === revision.current) {
        submission.current = false;
        setBusy(false);
      }
    }
  };

  const checkServer = () =>
    run(async () => {
      if (!server || !serverReady) return;
      const expectedScope = scope;
      const serverId = server.id;
      const response = await workboxHostsApi.preflight(serverId);
      if (owner.current !== expectedScope) return;
      setPreflight(response.data);
      setCheckedServer(serverId);
      setConfirmed(false);
    });

  const install = () =>
    run(async () => {
      if (
        !server ||
        checkedServer !== server.id ||
        !preflight?.accepted ||
        !confirmed ||
        !name.trim()
      )
        return;
      const expectedScope = scope;
      const response = await workboxHostsApi.install({
        serverId: server.id,
        name: name.trim(),
        rootfs,
      });
      if (owner.current !== expectedScope) return;
      setHost(response.data);
      setConfirmed(false);
      router.replace(`/workbox-hosts/new?hostId=${encodeURIComponent(response.data.id)}`, {
        scroll: false,
      });
      void loadHosts();
    });

  const actOnHost = (action: "start" | "stop" | "retry" | "remove") =>
    run(async () => {
      if (!host) return;
      if (action === "remove" && removeName !== host.name) return;
      const expectedScope = scope;
      const response = await workboxHostsApi.action(host.id, action);
      if (owner.current !== expectedScope) return;
      setHost(response.data);
      setRemoving(false);
      setRemoveName("");
      void loadHosts();
    });

  const refreshHost = () =>
    run(async () => {
      if (!host) return;
      const expectedScope = scope;
      const response = await workboxHostsApi.get(host.id);
      if (owner.current === expectedScope) setHost(response.data);
    });

  const steps: StepItem[] = (host?.progress ?? []).map((step) => ({
    id: step.id,
    label: step.label,
    status: step.status === "completed" ? "done" : step.status,
    children: step.message ? (
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{step.message}</p>
    ) : undefined,
  }));
  const canInstall =
    !!server &&
    serverReady &&
    preflight?.accepted &&
    checkedServer === server.id &&
    confirmed &&
    !!name.trim();

  return (
    <PageContainer outerClassName="pb-20">
      <Link
        href="/apps/new"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon name="arrow-left" className="size-4" /> Apps
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-medium tracking-tight">Workbox host</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Prepare a connected server to run Workbox sandboxes. Installation sets up the daemon,
          runtime and filesystem, then saves a verified connection.
        </p>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {host ? (
            <section className="rounded-2xl bg-card p-5" aria-label="Workbox host installation">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{host.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {host.rootfs === "agents" ? "Agent environment" : "Minimal environment"} ·{" "}
                    {host.status}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={refreshHost} disabled={busy}>
                  <Icon name="refresh" className="size-4" /> Refresh
                </Button>
              </div>
              {steps.length ? (
                <div className="mt-5">
                  <InstallStepper steps={steps} />
                </div>
              ) : (
                <p role="status" className="mt-5 text-sm text-muted-foreground">
                  Preparing installation steps…
                </p>
              )}
              {host.error && (
                <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-destructive">
                  {host.error}
                </p>
              )}
              {host.status === "ready" && host.connectionId && (
                <div className="mt-5 rounded-xl bg-muted/40 p-4">
                  <p className="text-sm font-medium">Host verified and connected</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create sandboxes on this host from the same Workbox Cloud interface.
                  </p>
                  <Button asChild className="mt-4">
                    <Link
                      href={`/workloads/new?provider=workbox&connectionId=${encodeURIComponent(host.connectionId)}`}
                    >
                      Create sandbox <Icon name="arrow-right" className="size-4" />
                    </Link>
                  </Button>
                </div>
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                {host.status === "failed" && (
                  <Button onClick={() => actOnHost("retry")} disabled={busy}>
                    Retry installation
                  </Button>
                )}
                {host.status === "stopped" && (
                  <Button onClick={() => actOnHost("start")} disabled={busy}>
                    Start host
                  </Button>
                )}
                {host.status === "ready" && (
                  <Button variant="secondary" onClick={() => actOnHost("stop")} disabled={busy}>
                    Stop host
                  </Button>
                )}
                {["ready", "stopped", "failed"].includes(host.status) && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRemoving((value) => !value);
                      setRemoveName("");
                    }}
                    disabled={busy}
                  >
                    Remove host
                  </Button>
                )}
                {!pending(host) && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setHost(null);
                      setPreflight(null);
                      setCheckedServer("");
                      setConfirmed(false);
                      setError("");
                      router.replace("/workbox-hosts/new", { scroll: false });
                    }}
                    disabled={busy}
                  >
                    Prepare another server
                  </Button>
                )}
              </div>
              {removing && (
                <div className="mt-4 space-y-3 rounded-xl bg-muted/40 p-4">
                  <p className="text-sm">
                    Remove this Workbox service and its saved connection after its sandbox inventory
                    is empty. Existing sandbox data remains on the server.
                  </p>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium">Type {host.name} to confirm</span>
                    <Input
                      variant="filled"
                      aria-label={`Confirm removal of ${host.name}`}
                      value={removeName}
                      onChange={(event) => setRemoveName(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    onClick={() => actOnHost("remove")}
                    disabled={busy || removeName !== host.name}
                  >
                    Confirm removal
                  </Button>
                </div>
              )}
            </section>
          ) : (
            <>
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="text-base font-semibold">Destination</h2>
                <ServerSelector
                  key={scope}
                  value={server?.id ?? null}
                  onSelect={(selected) => {
                    setServer(selected);
                    setPreflight(null);
                    setCheckedServer("");
                    setConfirmed(false);
                    setError("");
                  }}
                  onReadyChange={setServerReady}
                  requiredCapability="ssh"
                  selfHostedOnly
                  disabled={busy}
                  compact
                  label="Workbox server"
                  emptyHint="Connect a Linux server with SSH access to prepare a Workbox host."
                />
                <p className="text-xs text-muted-foreground">
                  Compatibility is checked before anything is installed. This host will manage
                  sandbox files and processes on the selected server.
                </p>
                <Button
                  variant="secondary"
                  onClick={checkServer}
                  disabled={busy || !server || !serverReady}
                >
                  {busy ? "Checking server…" : "Check compatibility"}
                </Button>
                {preflight && checkedServer === server?.id && (
                  <div className="space-y-3 border-t border-border/50 pt-4" role="status">
                    <p className="text-sm font-medium">
                      {preflight.accepted
                        ? "Ready to prepare this server"
                        : "This server needs attention"}
                    </p>
                    <ul className="space-y-2">
                      {preflight.checks.map((check) => (
                        <li key={check.id} className="flex gap-2 text-sm">
                          <Icon
                            name={check.ok ? "check-circle" : "alert-circle"}
                            className={`mt-0.5 size-4 shrink-0 ${check.ok ? "text-muted-foreground" : "text-destructive"}`}
                          />
                          <div>
                            <span>{check.label}</span>
                            {check.detail && (
                              <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {preflight.blockers.map((blocker, index) => (
                      <p key={index} className="text-sm text-destructive">
                        {blocker}
                      </p>
                    ))}
                  </div>
                )}
              </section>
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="text-base font-semibold">Environment</h2>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Host name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    variant="filled"
                    disabled={busy}
                  />
                </label>
                <div className="space-y-1.5">
                  <label htmlFor="workbox-rootfs" className="text-sm font-medium">
                    Prepared environment
                  </label>
                  <CustomSelect
                    id="workbox-rootfs"
                    aria-label="Prepared environment"
                    value={rootfs}
                    onChange={(value) => setRootfs(value)}
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    disabled={busy}
                    options={[
                      {
                        value: "agents",
                        label: "Agents",
                        description: "Tools for coding agents and development tasks.",
                      },
                      {
                        value: "minimal",
                        label: "Minimal",
                        description: "A small base environment for custom workloads.",
                      },
                    ]}
                  />
                </div>
              </section>
            </>
          )}
          {error && (
            <div role="alert" className="rounded-xl bg-card p-4 text-sm text-destructive">
              {error}
              {host && (
                <button className="ms-2 underline" onClick={refreshHost} disabled={busy}>
                  Check status again
                </button>
              )}
            </div>
          )}
          {(loading || hosts.length > 0 || listError) && (
            <section className="rounded-2xl bg-card p-5" aria-label="Existing Workbox hosts">
              <h2 className="text-base font-semibold">Your Workbox hosts</h2>
              {loading ? (
                <div className="mt-4 h-16 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
              ) : listError ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {listError}{" "}
                  <button onClick={() => void loadHosts()} className="underline">
                    Retry
                  </button>
                </p>
              ) : (
                <div className="mt-3 divide-y divide-border/50">
                  {hosts
                    .filter((item) => item.status !== "removed")
                    .map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setHost(item);
                          setError("");
                          router.replace(
                            `/workbox-hosts/new?hostId=${encodeURIComponent(item.id)}`,
                            { scroll: false },
                          );
                        }}
                        className="flex w-full items-center justify-between gap-3 py-3 text-start hover:text-foreground disabled:opacity-50"
                        disabled={busy || pending(host)}
                      >
                        <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{item.status}</span>
                      </button>
                    ))}
                </div>
              )}
            </section>
          )}
        </div>
        <aside className="space-y-4 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
          <h2 className="text-base font-semibold">
            {host ? "Host details" : "Review and install"}
          </h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Destination</dt>
              <dd className="mt-1 break-words">
                {host
                  ? (hosts.find((item) => item.id === host.id)?.name ?? host.name)
                  : (server?.name ?? "Choose a connected server")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Environment</dt>
              <dd className="mt-1">
                {(host?.rootfs ?? rootfs) === "agents" ? "Agents" : "Minimal"}
              </dd>
            </div>
            {host?.version && (
              <div>
                <dt className="text-muted-foreground">Version</dt>
                <dd className="mt-1 break-all">{host.version}</dd>
              </div>
            )}
          </dl>
          {!host && (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Installation adds Workbox and required system packages, prepares its runtime and
                filesystem, and starts its service. Existing sandbox data is retained when retrying.
              </p>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy || !preflight?.accepted || checkedServer !== server?.id}
                  className="mt-0.5 size-4 accent-current"
                />
                <span>Install and configure Workbox on this server.</span>
              </label>
              <Button onClick={install} className="w-full" disabled={busy || !canInstall}>
                {busy ? "Preparing…" : "Prepare Workbox host"}
              </Button>
            </>
          )}
          <Link href="/servers" className="inline-flex text-xs text-muted-foreground underline">
            Manage connected servers
          </Link>
        </aside>
      </div>
    </PageContainer>
  );
}
