"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ExternalOperation, ExternalLogEntry } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { useDashboardHome } from "@/hooks/useDashboardHome";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { externalDeploymentsApi } from "@/lib/api/external-deployments";
import { getApiErrorMessage } from "@/lib/api/client";
import { currentWorkloads, kindLabel, providers } from "./model";
import { AppLogo } from "@/components/AppLogo";

export function ExternalWorkload({
  operation,
  connections,
  refresh,
}: {
  operation: ExternalOperation;
  connections: Credential[];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<ExternalLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [logsTruncated, setLogsTruncated] = useState(false);
  const capability = operation.target.capability;
  const canExec = capability?.supported.includes("exec") ?? false;
  const canDestroy = capability?.supported.includes("destroy") ?? false;
  const canLogs = capability?.supported.includes("logs") ?? false;
  const name = operation.target.resource.name ?? operation.providerResourceId ?? operation.targetId;
  const provider =
    providers.find((row) => row.id === operation.target.provider)?.name ??
    operation.target.provider;
  const connection =
    connections.find((row) => row.id === operation.target.connectionId)?.name ??
    operation.target.connectionId;
  const publicUrl = [
    operation.target.resource.url,
    operation.target.resource.publicUrl,
    operation.message,
  ].find((value) => value && /^https?:\/\/[^\s]+$/.test(value));
  const deleting = operation.kind === "destroy";
  const stopped = deleting && operation.status === "stopped";
  async function refreshLogs() {
    setLogsLoading(true);
    setLogsError("");
    try {
      const result = await externalDeploymentsApi.logs(operation.id);
      setLogs(result.data.entries);
      setLogsTruncated(result.data.truncated);
    } catch (cause) {
      setLogsError(getApiErrorMessage(cause));
    } finally {
      setLogsLoading(false);
    }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article id={`workload-${operation.targetId}`} className="scroll-mt-6 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 break-words text-base font-semibold">
            {operation.target.catalog && (
              <AppLogo appId={operation.target.catalog.templateId} className="size-6 shrink-0" />
            )}
            {name}
          </h3>
          {operation.target.catalog && (
            <p className="mt-1 text-xs text-muted-foreground">{operation.target.catalog.name}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {provider} · {kindLabel(operation.target.provider, operation.workloadKind)}
          </p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{connection}</p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
          {stopped ? "Deleted" : operation.status.replaceAll("_", " ")}
        </span>
      </div>
      <dl className="mt-4 grid gap-2 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Last checked: </dt>
          <dd className="inline">{new Date(operation.updatedAt).toLocaleString()}</dd>
        </div>
        {operation.providerStatus && (
          <div>
            <dt className="inline">Provider state: </dt>
            <dd className="inline">{operation.providerStatus}</dd>
          </div>
        )}
        {operation.target.resource.region && (
          <div>
            <dt className="inline">Region: </dt>
            <dd className="inline">{operation.target.resource.region}</dd>
          </div>
        )}
      </dl>
      {operation.message && (
        <p className="mt-3 break-words text-sm text-muted-foreground">{operation.message}</p>
      )}
      {operation.errorCode && (
        <p className="mt-2 text-xs text-destructive">{operation.errorCode}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {canLogs && (
          <Button
            size="sm"
            variant="secondary"
            disabled={logsLoading}
            onClick={() => {
              setLogsOpen((value) => !value);
              if (!logsOpen) void refreshLogs();
            }}
          >
            Logs
          </Button>
        )}
        {publicUrl && !stopped && (
          <Button size="sm" variant="secondary" asChild>
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              Open workload
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || stopped}
          onClick={() => run(() => externalDeploymentsApi.observe(operation))}
        >
          <Icon name="refresh" className="size-3.5" />
          Check status
        </Button>
        {canExec && !deleting && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setCommandOpen(!commandOpen)}
          >
            Run command
          </Button>
        )}
        {canDestroy && !deleting && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setDestroyOpen(!destroyOpen)}
          >
            Delete
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {commandOpen && (
        <form
          className="mt-4 space-y-3 rounded-xl bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await externalDeploymentsApi.exec(operation.id, [
                "sh",
                "-lc",
                command,
              ]);
              setOutput(
                `${result.data.stdout}${result.data.stderr}${result.data.exitCode === null ? "\nExit status unavailable" : `\nExit ${result.data.exitCode}`}`,
              );
            });
          }}
        >
          <label className="block space-y-2">
            <span className="text-sm font-medium">Sandbox command</span>
            <Textarea
              variant="filled"
              aria-label="Sandbox command"
              className="border-0 bg-background font-mono"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="pwd"
            />
          </label>
          <Button size="sm" type="submit" disabled={busy || !command.trim()}>
            Run
          </Button>
          {output && (
            <pre
              aria-live="polite"
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 text-xs"
            >
              {output}
            </pre>
          )}
        </form>
      )}
      {logsOpen && (
        <section aria-label="Workload logs" className="mt-4 space-y-3 rounded-xl bg-card p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Recent logs</h4>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refreshLogs()}
              disabled={logsLoading}
            >
              {logsLoading ? "Loading…" : "Refresh logs"}
            </Button>
          </div>
          {logsError && (
            <p role="alert" className="text-sm text-destructive">
              {logsError}
            </p>
          )}
          {!logsLoading && !logsError && !logs.length && (
            <p className="text-sm text-muted-foreground">No logs returned yet.</p>
          )}
          {logs.length > 0 && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 text-xs">
              {logs.map((row) => `${row.timestamp} [${row.stream}] ${row.message}`).join("\n")}
            </pre>
          )}
          {logsTruncated && (
            <p className="text-xs text-muted-foreground">
              Showing a bounded recent excerpt. Refresh to fetch current logs.
            </p>
          )}
        </section>
      )}
      {destroyOpen && (
        <div className="mt-4 space-y-3 rounded-xl bg-card p-4">
          <p className="text-sm">
            Delete <strong>{name}</strong> and its provider resource? This may permanently remove
            sandbox files.
          </p>
          <label className="block space-y-2 text-sm">
            Type {name} to confirm
            <Input
              aria-label={`Confirm deletion of ${name}`}
              variant="filled"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || confirmation !== name}
            onClick={() =>
              run(async () => {
                await externalDeploymentsApi.destroy(operation.id);
                setDestroyOpen(false);
              })
            }
          >
            Delete workload
          </Button>
        </div>
      )}
      <details className="mt-4 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Resource details</summary>
        <dl className="mt-2 space-y-1 break-all">
          <div>
            <dt className="inline">Resource: </dt>
            <dd className="inline">{operation.providerResourceId ?? "Not yet assigned"}</dd>
          </div>
          <div>
            <dt className="inline">Operation: </dt>
            <dd className="inline">{operation.id}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

export function WorkloadsPage() {
  const scopeKey = useResourceScope();
  const requestRevision = useRef(0);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [operations, setOperations] = useState<ExternalOperation[]>([]);
  const [connections, setConnections] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const { projects, loading: projectsLoading } = useDashboardHome();
  const refresh = useCallback(
    async (observe = false) => {
      const revision = ++requestRevision.current;
      try {
        const [workloads, credentials] = await Promise.all([
          externalDeploymentsApi.operations(),
          credentialsApi.list(),
        ]);
        if (currentScope.current !== scopeKey || revision !== requestRevision.current) return;
        setOperations(workloads.data);
        setConnections(credentials.data);
        setError("");
        if (observe) {
          const results = await Promise.allSettled(
            currentWorkloads(workloads.data)
              .filter(
                (row) =>
                  row.providerResourceId && (row.kind !== "destroy" || row.status === "stopping"),
              )
              .map((row) => externalDeploymentsApi.observe(row)),
          );
          if (currentScope.current !== scopeKey || revision !== requestRevision.current) return;
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") setError(getApiErrorMessage(failed.reason));
          const latest = await externalDeploymentsApi.operations();
          if (currentScope.current === scopeKey && revision === requestRevision.current)
            setOperations(latest.data);
        }
      } catch (error) {
        if (currentScope.current === scopeKey && revision === requestRevision.current)
          setError(getApiErrorMessage(error));
      } finally {
        if (currentScope.current === scopeKey && revision === requestRevision.current)
          setLoading(false);
      }
    },
    [scopeKey],
  );
  useEffect(() => {
    setOperations([]);
    setConnections([]);
    setLoading(true);
    void refresh();
    return () => {
      requestRevision.current++;
    };
  }, [refresh]);
  const external = useMemo(() => currentWorkloads(operations), [operations]);
  const pending = external.some((row) =>
    ["queued", "provisioning", "reconciling", "stopping"].includes(row.status),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      void refresh(true);
    }, 8_000);
    return () => clearTimeout(timer);
  }, [pending, operations, refresh]);
  const visible = external.filter((row) => filter === "all" || row.target.provider === filter);
  const native = filter === "all" || filter === "native";
  return (
    <PageContainer outerClassName="pb-20">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Workloads</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Applications, services, sandboxes and machines across your infrastructure.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void refresh(true);
            }}
            disabled={loading}
          >
            <Icon name="refresh" className="size-4" />
            Refresh
          </Button>
          <Button asChild>
            <Link href="/workloads/new">
              <Icon name="plus" className="size-4" />
              New workload
            </Link>
          </Button>
        </div>
      </header>
      <nav aria-label="Filter workloads by infrastructure" className="mb-6 flex flex-wrap gap-2">
        {[{ id: "all", name: "All infrastructure" }, ...providers].map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setFilter(row.id)}
            aria-pressed={filter === row.id}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${filter === row.id ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-muted"}`}
          >
            {row.name}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="mb-5 rounded-xl bg-card p-4 text-sm text-destructive">
          {error}{" "}
          <button onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}
      {native && (
        <section className="mb-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Workbox Cloud & your servers</h2>
            <Link href="/servers" className="text-xs text-muted-foreground underline">
              Manage infrastructure
            </Link>
          </div>
          {projectsLoading ? (
            <div className="h-28 animate-pulse rounded-2xl bg-card motion-reduce:animate-none" />
          ) : projects.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="rounded-2xl bg-card p-5 hover:bg-muted"
                >
                  <h3 className="font-semibold">{project.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {project.deployTarget === "cloud"
                      ? "Workbox Cloud"
                      : (project.serverName ?? "Connected server")}{" "}
                    · {project.isApp ? "App" : "Project"}
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground">
                    Open project and deployment controls →
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">
              No native projects yet.{" "}
              <Link href="/library" className="underline">
                Choose a source or catalog app
              </Link>{" "}
              to deploy to a connected server or Cloud workspace.
            </div>
          )}
        </section>
      )}
      <section>
        <h2 className="mb-3 text-base font-semibold">Provider workloads</h2>
        {loading && !visible.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-40 animate-pulse rounded-2xl bg-card motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : visible.length ? (
          <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((row) => (
              <ExternalWorkload
                key={row.targetId}
                operation={row}
                connections={connections}
                refresh={refresh}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl bg-card p-6">
            <p className="text-sm text-muted-foreground">
              No provider workloads have been launched here yet. Connected accounts become available
              when you create a workload.
            </p>
            <Button asChild size="sm" className="mt-4">
              <Link href="/workloads/new">Create a workload</Link>
            </Button>
          </div>
        )}
      </section>
      <p className="mt-6 text-xs text-muted-foreground">
        Provider requests accepted for provisioning are shown separately from verified running
        state. Use Check status to refresh provider observations.
      </p>
    </PageContainer>
  );
}
