"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ExternalPlan, ExternalWorkloadKind } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CustomSelect } from "@/components/ui/CustomSelect";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { settingsApi } from "@/lib/api/settings";
import { OptionCard } from "@/components/shared/OptionCard";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { externalDeploymentsApi, type ProviderDiscovery } from "@/lib/api/external-deployments";
import { getApiErrorMessage } from "@/lib/api/client";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import {
  providers,
  kinds,
  initialDraft,
  launchInput,
  type LaunchDraft,
  type WorkloadProvider,
} from "./model";

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
function NativeDestination() {
  const router = useRouter();
  const [server, setServer] = useState<ServerOption | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function proceed() {
    setBusy(true);
    setError("");
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: server?.raw.managed || !server ? "cloud" : "server",
        defaultServerId: server?.id ?? null,
      });
      router.push("/library");
    } catch (error) {
      setError(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <h2 className="font-semibold">Deploy to Workbox Cloud or your own server</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Choose your destination, then select a repository, source folder or catalog application. The
        existing deployment wizard keeps Docker and direct-host runtime choices available for
        compatible servers.
      </p>
      <ServerSelector
        onSelect={setServer}
        onReadyChange={setReady}
        forDeployment
        compact
        disabled={busy}
      />
      <div className="flex flex-wrap gap-3">
        <Button onClick={proceed} disabled={busy || !ready}>
          <Icon name="git-branch" className="size-4" />
          {busy ? "Saving destination…" : "Choose source or app"}
        </Button>
        <Button asChild variant="secondary">
          <Link href="/servers">Manage servers</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Your destination becomes the default in the deployment wizard, where you can change it
        before deploying. For child sandboxes, choose Workbox environments above and connect a
        compatible Workbox host.
      </p>
    </section>
  );
}
const selectStyle = { variant: "filled" as const, triggerClassName: "bg-muted/60 hover:bg-muted" };

export function WorkloadLaunch() {
  const scopeKey = useResourceScope();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedProvider = searchParams.get("provider");
  const requestedConnection = searchParams.get("connectionId");
  const initialProvider = providers.some((item) => item.id === requestedProvider)
    ? (requestedProvider as WorkloadProvider)
    : "native";
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [provider, setProvider] = useState<WorkloadProvider>(initialProvider);
  const [kind, setKind] = useState<ExternalWorkloadKind>(
    initialProvider === "native" ? "service" : kinds[initialProvider][0]!.id,
  );
  const [connections, setConnections] = useState<Credential[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [draft, setDraft] = useState<LaunchDraft>(initialDraft);
  const [discovery, setDiscovery] = useState<ProviderDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [manual, setManual] = useState(false);
  const [plan, setPlan] = useState<ExternalPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const applyKey = useRef("");
  const initialConnectionApplied = useRef(false);
  const connection = connections.find((row) => row.id === connectionId);
  const available = connections.filter((row) => row.provider === provider);
  const project = discovery?.projects.find((row) => row.id === draft.projectId);
  const sandbox = kind !== "service" && kind !== "fly-machine";
  const choice = provider === "native" ? undefined : kinds[provider].find((row) => row.id === kind);
  const change = (patch: Partial<LaunchDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setPlan(null);
    setError("");
  };

  useEffect(() => {
    let cancelled = false;
    credentialsApi
      .list()
      .then((response) => {
        if (!cancelled) {
          setConnections(response.data);
          if (
            !initialConnectionApplied.current &&
            requestedConnection &&
            response.data.some(
              (item) => item.id === requestedConnection && item.provider === initialProvider,
            )
          ) {
            setConnectionId(requestedConnection);
            initialConnectionApplied.current = true;
          }
        }
      })
      .catch((error) => {
        if (!cancelled) setError(getApiErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setConnectionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, requestedConnection, initialProvider]);

  useEffect(() => {
    setConnectionId("");
    setConnections([]);
    setPlan(null);
    setDraft(initialDraft);
    setConnectionsLoading(true);
    setBusy(false);
  }, [scopeKey]);

  useEffect(() => {
    setDiscoveryError("");
    if (!connectionId) {
      setDiscovery(null);
      setDiscoveryLoading(false);
      return;
    }
    let cancelled = false;
    setDiscoveryLoading(true);
    externalDeploymentsApi
      .discover(connectionId, draft.projectId || undefined)
      .then((response) => {
        if (!cancelled) setDiscovery(response.data);
      })
      .catch((error) => {
        if (!cancelled) setDiscoveryError(getApiErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setDiscoveryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, draft.projectId]);

  function chooseProvider(next: WorkloadProvider) {
    setProvider(next);
    setConnectionId("");
    setDraft(initialDraft);
    setPlan(null);
    setManual(false);
    setError("");
    if (next !== "native") setKind(kinds[next][0]!.id);
  }
  async function review() {
    if (!connection || provider === "native") return;
    setBusy(true);
    setError("");
    setPlan(null);
    try {
      const input = launchInput(provider, kind, connection, draft, `review:${crypto.randomUUID()}`);
      const checked = (await externalDeploymentsApi.preflight(input.target)).data;
      if (currentScope.current !== scopeKey) return;
      if (!checked.accepted) {
        setPlan(checked);
        return;
      }
      const reviewed = (await externalDeploymentsApi.plan(input)).data;
      if (currentScope.current !== scopeKey) return;
      setPlan(reviewed);
      applyKey.current = `launch:${crypto.randomUUID()}`;
    } catch (error) {
      if (currentScope.current === scopeKey) setError(getApiErrorMessage(error));
    } finally {
      if (currentScope.current === scopeKey) setBusy(false);
    }
  }
  async function launch() {
    if (!plan?.accepted) return;
    setBusy(true);
    setError("");
    try {
      if (new Date(plan.expiresAt).getTime() <= Date.now()) {
        setPlan(null);
        throw new Error("This review has expired. Review the deployment again before launching.");
      }
      await externalDeploymentsApi.apply(plan.planId, applyKey.current);
      if (currentScope.current === scopeKey) router.push("/workloads");
    } catch (error) {
      if (currentScope.current === scopeKey) setError(getApiErrorMessage(error));
    } finally {
      if (currentScope.current === scopeKey) setBusy(false);
    }
  }
  const input = (
    field: keyof LaunchDraft,
    label: string,
    placeholder?: string,
    hint?: string,
    type = "text",
  ) => (
    <Field label={label} hint={hint}>
      <Input
        variant="filled"
        type={type}
        value={String(draft[field])}
        placeholder={placeholder}
        onChange={(event) => change({ [field]: event.target.value })}
        disabled={busy}
      />
    </Field>
  );
  const select = (
    label: string,
    value: string,
    options: Array<{ value: string; label: string }>,
    onChange: (value: string) => void,
    placeholder?: string,
  ) => (
    <Field label={label}>
      <CustomSelect
        {...selectStyle}
        aria-label={label}
        value={value}
        options={options}
        onChange={onChange}
        placeholder={placeholder ?? `Select ${label.toLowerCase()}`}
        disabled={busy}
      />
    </Field>
  );
  const supportsImage =
    kind !== "fly-sprite" &&
    kind !== "workbox-sandbox" &&
    kind !== "railway-sandbox" &&
    !(provider === "vercel" && kind === "service");

  return (
    <PageContainer outerClassName="pb-20">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href="/workloads" className="text-sm text-muted-foreground hover:text-foreground">
            ← Workloads
          </Link>
          <h1 className="mt-3 text-2xl font-medium tracking-tight">New workload</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose where it runs, configure it, then review before deploying.
          </p>
        </div>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          <section className="rounded-2xl bg-card p-5">
            <h2 className="mb-4 text-base font-semibold">Infrastructure</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {providers.map((row) => (
                <OptionCard
                  key={row.id}
                  value={row.id}
                  selected={provider === row.id}
                  onSelect={() => chooseProvider(row.id)}
                  disabled={busy}
                  icon={
                    <Icon
                      name={
                        row.id === "native" ? "server" : row.id === "workbox" ? "terminal" : "cloud"
                      }
                      className="size-5"
                    />
                  }
                  label={row.name}
                  description={row.description}
                />
              ))}
            </div>
          </section>
          {provider === "native" ? (
            <NativeDestination key={scopeKey} />
          ) : (
            <>
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="text-base font-semibold">Connection and workload</h2>
                {connectionsLoading ? (
                  <div className="h-11 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
                ) : available.length ? (
                  select(
                    "Provider connection",
                    connectionId,
                    available.map((row) => ({
                      value: row.id,
                      label: `${row.name}${row.status !== "active" ? " · check connection" : ""}`,
                    })),
                    (value) => {
                      setConnectionId(value);
                      setPlan(null);
                      setDraft(initialDraft);
                      setDiscovery(null);
                    },
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No {providers.find((row) => row.id === provider)?.name} connections yet.{" "}
                    <Link
                      href="/settings?tab=connections"
                      className="font-medium text-foreground underline"
                    >
                      Add a connection
                    </Link>
                    , then return here.
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {kinds[provider].map((row) => (
                    <OptionCard
                      key={row.id}
                      value={row.id}
                      selected={kind === row.id}
                      onSelect={() => {
                        setKind(row.id);
                        setPlan(null);
                        setDraft({
                          ...initialDraft,
                          projectId: draft.projectId,
                          environmentId: draft.environmentId,
                        });
                      }}
                      disabled={busy}
                      icon={
                        <Icon
                          name={row.id === "service" ? "server" : "terminal"}
                          className="size-5"
                        />
                      }
                      label={row.name}
                      description={row.description}
                    />
                  ))}
                </div>
                {connection && (
                  <p className="text-xs text-muted-foreground">
                    Account scope:{" "}
                    {connection.publicFields.teamId ??
                      connection.publicFields.workspaceId ??
                      connection.publicFields.organizationId ??
                      connection.publicFields.accountId ??
                      connection.publicFields.baseUrl ??
                      connection.name}
                  </p>
                )}
              </section>
              {connection && (
                <section className="space-y-4 rounded-2xl bg-card p-5">
                  <h2 className="text-base font-semibold">
                    Configure {sandbox ? "sandbox" : "application"}
                  </h2>
                  {input("name", "Workload name", "my-workload")}
                  {discoveryLoading && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading available destinations…
                    </p>
                  )}
                  {discoveryError && (
                    <p role="alert" className="text-sm text-warning">
                      Could not load destinations: {discoveryError}. You can enter the provider IDs
                      below.
                    </p>
                  )}
                  {discovery?.warnings.map((warning, index) => (
                    <p key={index} className="text-xs text-muted-foreground">
                      {warning}
                    </p>
                  ))}
                  {(provider === "railway" || provider === "vercel") && (
                    <>
                      {discovery?.projects.length && !manual
                        ? select(
                            "Project",
                            draft.projectId,
                            discovery.projects.map((row) => ({ value: row.id, label: row.name })),
                            (value) =>
                              change({ projectId: value, environmentId: "", serviceId: "" }),
                          )
                        : input(
                            "projectId",
                            "Project ID",
                            undefined,
                            "Use the project ID from the selected provider account.",
                          )}
                      {provider === "railway" &&
                        (project?.environments.length && !manual
                          ? select(
                              "Environment",
                              draft.environmentId,
                              project.environments.map((row) => ({
                                value: row.id,
                                label: row.name,
                              })),
                              (value) => change({ environmentId: value }),
                            )
                          : input("environmentId", "Environment ID"))}
                      {provider === "railway" &&
                        kind === "service" &&
                        (project?.services?.length && !manual
                          ? select(
                              "Service",
                              draft.serviceId,
                              [
                                { value: "", label: "Create a new service" },
                                ...project.services.map((row) => ({
                                  value: row.id,
                                  label: row.name,
                                })),
                              ],
                              (value) => change({ serviceId: value }),
                            )
                          : input(
                              "serviceId",
                              "Existing service ID (optional)",
                              undefined,
                              "Leave blank to create a service with the workload name.",
                            ))}
                      <button
                        type="button"
                        onClick={() => setManual(!manual)}
                        className="text-xs text-muted-foreground underline"
                      >
                        {manual ? "Use discovered destinations" : "Enter provider IDs manually"}
                      </button>
                    </>
                  )}
                  {provider === "fly" && kind === "fly-machine" && (
                    <>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.createApp}
                          onChange={(event) =>
                            change({ createApp: event.target.checked, appName: "" })
                          }
                        />
                        Create a new Fly application
                      </label>
                      {discovery?.apps.length && !draft.createApp
                        ? select(
                            "Fly application",
                            draft.appName,
                            discovery.apps.map((row) => ({ value: row.name, label: row.name })),
                            (value) => change({ appName: value }),
                          )
                        : input(
                            "appName",
                            "Fly application name",
                            "my-app",
                            "The application belongs to the selected Fly organization.",
                          )}
                    </>
                  )}
                  {supportsImage &&
                    input(
                      "image",
                      provider === "blaxel" ? "Container image" : "Container image (optional)",
                      provider === "blaxel" && sandbox
                        ? "blaxel/base-image:latest"
                        : "registry.example.com/team/app:tag",
                      provider === "vercel"
                        ? "Use a Vercel Container Registry image, or leave blank for the managed runtime."
                        : provider === "blaxel"
                          ? "Use an image available in the Blaxel registry."
                          : undefined,
                    )}
                  {((provider === "railway" && kind === "service") || provider === "vercel") && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {input(
                        "repo",
                        "Git repository (optional)",
                        "owner/repository",
                        provider === "vercel"
                          ? kind === "service"
                            ? "Leave blank to deploy the project's linked repository."
                            : "Leave blank to start an empty sandbox."
                          : undefined,
                      )}
                      {input("branch", "Branch", "main")}
                    </div>
                  )}
                  {provider !== "workbox" && !(provider === "vercel" && kind === "service") && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {!(provider === "railway" && kind === "service") &&
                        input(
                          "region",
                          "Region",
                          provider === "blaxel" ? "us-pdx-1" : "Provider default",
                        )}
                      {kind !== "fly-sprite" &&
                        input(
                          "ports",
                          "Application ports",
                          "3000",
                          "Separate multiple sandbox ports with commas.",
                        )}
                    </div>
                  )}
                  {provider === "workbox" && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {input(
                        "rootfs",
                        "Prepared root filesystem",
                        "Host default",
                        "A rootfs already installed on this Workbox host.",
                      )}
                      {input("runtime", "Runtime", "Host default")}
                    </div>
                  )}
                  {(provider === "blaxel" ||
                    kind === "fly-machine" ||
                    kind === "workbox-sandbox") && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {input(
                        "memoryMb",
                        "Memory (MB)",
                        provider === "blaxel" ? (sandbox ? "4096" : "2048") : "256",
                        undefined,
                        "number",
                      )}
                      {provider !== "blaxel" && input("vcpus", "vCPUs", "1", undefined, "number")}
                    </div>
                  )}
                  {kind === "railway-sandbox" && (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {input("cpu", "vCPUs", "Provider default", undefined, "number")}
                        {input("memoryGB", "Memory (GB)", "Provider default", undefined, "number")}
                      </div>
                      {select(
                        "Network isolation",
                        draft.networkIsolation,
                        [
                          { value: "PRIVATE", label: "Private network · public routes allowed" },
                          { value: "ISOLATED", label: "Isolated network" },
                        ],
                        (value) => change({ networkIsolation: value }),
                      )}
                      <p className="text-xs text-muted-foreground">
                        Create the sandbox, then use Run command to clone a repository or install
                        tools.
                      </p>
                    </>
                  )}
                  {provider === "blaxel" &&
                    sandbox &&
                    input(
                      "ttl",
                      "Sandbox lifetime",
                      "1h",
                      "For example 30m or 1h; minimum 5 minutes.",
                    )}
                  {(kind === "railway-sandbox" || kind === "vercel-sandbox") &&
                    input(
                      "timeoutMinutes",
                      kind === "railway-sandbox"
                        ? "Idle timeout (minutes)"
                        : "Session timeout (minutes)",
                      "30",
                      undefined,
                      "number",
                    )}
                  {kind === "vercel-sandbox" && (
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.persistent}
                        onChange={(event) => change({ persistent: event.target.checked })}
                      />
                      Preserve sandbox state between sessions
                    </label>
                  )}
                  {kind !== "fly-sprite" && !(provider === "vercel" && kind === "service") && (
                    <Field
                      label="Environment variables"
                      hint="One NAME=value per line. Values stay hidden in the deployment review."
                    >
                      <Textarea
                        variant="filled"
                        className="min-h-28 border-0 bg-background font-mono text-sm"
                        value={draft.variables}
                        onChange={(event) => change({ variables: event.target.value })}
                        placeholder="NODE_ENV=production"
                      />
                    </Field>
                  )}
                  {provider === "vercel" && kind === "service" && (
                    <p className="text-xs text-muted-foreground">
                      This deployment uses the environment configured in the selected Vercel
                      project.
                    </p>
                  )}
                  {kind === "fly-sprite" && (
                    <p className="text-sm text-muted-foreground">
                      Sprites use their own persistent filesystem and runtime. Configure it after
                      creation using Run command. A Fly Machines token alone does not enable
                      Sprites.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </fieldset>
        <aside className="space-y-4 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
          <h2 className="font-semibold">Review and deploy</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Infrastructure</dt>
              <dd className="mt-1 font-medium">
                {providers.find((row) => row.id === provider)?.name}
              </dd>
            </div>
            {choice && (
              <div>
                <dt className="text-muted-foreground">Workload</dt>
                <dd className="mt-1 font-medium">{choice.name}</dd>
              </div>
            )}
            {connection && (
              <div>
                <dt className="text-muted-foreground">Connection</dt>
                <dd className="mt-1 break-words font-medium">{connection.name}</dd>
              </div>
            )}
            {draft.name && (
              <div>
                <dt className="text-muted-foreground">Name</dt>
                <dd className="mt-1 break-words font-medium">{draft.name}</dd>
              </div>
            )}
            {draft.projectId && (
              <div>
                <dt className="text-muted-foreground">Project</dt>
                <dd className="mt-1 break-words">{project?.name ?? draft.projectId}</dd>
              </div>
            )}
            {draft.environmentId && (
              <div>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="mt-1 break-words">
                  {project?.environments.find((row) => row.id === draft.environmentId)?.name ??
                    draft.environmentId}
                </dd>
              </div>
            )}
            {draft.appName && (
              <div>
                <dt className="text-muted-foreground">Fly application</dt>
                <dd className="mt-1 break-words">{draft.appName}</dd>
              </div>
            )}
            {draft.region && (
              <div>
                <dt className="text-muted-foreground">Region</dt>
                <dd className="mt-1">{draft.region}</dd>
              </div>
            )}
            {draft.image && (
              <div>
                <dt className="text-muted-foreground">Image</dt>
                <dd className="mt-1 break-all font-mono text-xs">{draft.image}</dd>
              </div>
            )}
            {draft.repo && (
              <div>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="mt-1 break-words">
                  {draft.repo} · {draft.branch}
                </dd>
              </div>
            )}
            {draft.variables && (
              <div>
                <dt className="text-muted-foreground">Environment variables</dt>
                <dd className="mt-1">Values hidden</dd>
              </div>
            )}
          </dl>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {plan && (
            <div role="status" className="space-y-3 text-sm">
              <p className="font-medium">
                {plan.accepted ? "Ready for your review" : "Deployment blocked"}
              </p>
              {[...new Set(plan.blockers)].map((item, index) => (
                <p key={index} className="text-destructive">
                  {item}
                </p>
              ))}
              {[...new Set(plan.warnings)].map((item, index) => (
                <p key={index} className="text-warning">
                  {item}
                </p>
              ))}
              {plan.accepted && (
                <>
                  <p className="text-xs text-muted-foreground">
                    This creates or updates the selected provider workload. Provider usage charges
                    may apply. Review expires {new Date(plan.expiresAt).toLocaleTimeString()}.
                  </p>
                  <Button onClick={launch} disabled={busy} className="w-full">
                    {busy ? "Deploying…" : "Deploy workload"}
                  </Button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline"
                    onClick={() => setPlan(null)}
                    disabled={busy}
                  >
                    Edit configuration
                  </button>
                </>
              )}
            </div>
          )}
          {provider !== "native" && !plan?.accepted && (
            <Button className="w-full" onClick={review} disabled={busy || !connection}>
              {busy ? "Checking destination…" : "Review deployment"}
            </Button>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Service deployments, sandbox sessions and persistent machines have different lifecycles.
            Available operations are checked for the selected connection before deployment.
          </p>
        </aside>
      </div>
    </PageContainer>
  );
}
