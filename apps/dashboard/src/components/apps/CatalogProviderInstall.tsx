"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AppTemplate } from "@repo/core";
import type { ExternalPlan, ExternalTargetInput } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { appsApi } from "@/lib/api/apps";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { externalDeploymentsApi, type ProviderDiscovery } from "@/lib/api/external-deployments";
import { getApiErrorMessage } from "@/lib/api/client";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { AppLogo } from "@/components/AppLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { PageContainer } from "@/components/ui/PageContainer";
import { AppDeploymentChoices, catalogProviderName } from "./AppDeploymentChoices";

type Recipe = NonNullable<AppTemplate["deploymentRecipes"]>[number];
const selectStyle = { variant: "filled" as const, triggerClassName: "bg-muted/60 hover:bg-muted" };
const defaults = (recipe: Recipe) =>
  Object.fromEntries((recipe.inputs ?? []).map((field) => [field.key, field.default ?? ""]));

export function CatalogProviderInstall({ appId, recipeId }: { appId: string; recipeId: string }) {
  const scope = useResourceScope();
  return (
    <ScopedCatalogProviderInstall
      key={`${scope}:${appId}:${recipeId}`}
      appId={appId}
      recipeId={recipeId}
    />
  );
}

function ScopedCatalogProviderInstall({ appId, recipeId }: { appId: string; recipeId: string }) {
  const router = useRouter();
  const scope = useResourceScope();
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [template, setTemplate] = useState<AppTemplate | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [discovery, setDiscovery] = useState<ProviderDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [selectors, setSelectors] = useState({
    name: "",
    projectId: "",
    environmentId: "",
    appName: "",
    region: "",
  });
  const [config, setConfig] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<ExternalPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const applyKey = useRef("");
  const recipe = template?.deploymentRecipes?.find((item) => item.id === recipeId);
  const createsProject = recipe?.resource?.createProject === "true";
  const connection = credentials.find(
    (item) => item.id === connectionId && item.provider === recipe?.provider,
  );
  const project = discovery?.projects.find((item) => item.id === selectors.projectId);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([appsApi.template(appId), credentialsApi.list()])
      .then(([app, accounts]) => {
        if (!active) return;
        setTemplate(app.data);
        setCredentials(accounts.data);
        const selected = app.data.deploymentRecipes?.find((item) => item.id === recipeId);
        if (selected) setConfig(defaults(selected));
        setSelectors((previous) => ({ ...previous, name: app.data.id }));
      })
      .catch((cause) => {
        if (active) setError(getApiErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [appId, recipeId, revision]);

  useEffect(() => {
    if (!connectionId || createsProject) {
      setDiscovery(null);
      setDiscoveryLoading(false);
      return;
    }
    let active = true;
    setDiscoveryLoading(true);
    setDiscoveryError("");
    externalDeploymentsApi
      .discover(connectionId, selectors.projectId || undefined)
      .then((result) => {
        if (active) setDiscovery(result.data);
      })
      .catch((cause) => {
        if (active) setDiscoveryError(getApiErrorMessage(cause));
      })
      .finally(() => {
        if (active) setDiscoveryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connectionId, selectors.projectId, createsProject]);

  function change(patch: Partial<typeof selectors>) {
    setSelectors((previous) => ({ ...previous, ...patch }));
    setPlan(null);
    setError("");
  }
  async function review() {
    if (!recipe || !connection) return;
    setBusy(true);
    setPlan(null);
    setError("");
    try {
      if (!selectors.name.trim()) throw new Error("Enter a workload name.");
      const missing = recipe.inputs?.find((field) => field.required && !config[field.key]?.trim());
      if (missing) throw new Error(`Enter ${missing.label.toLowerCase()}.`);
      const providerIdentity = Object.fromEntries(
        Object.entries(connection.publicFields).filter(([key]) =>
          ["accountId", "teamId", "workspaceId", "organizationId"].includes(key),
        ),
      );
      const resource: Record<string, string> = { name: selectors.name.trim() };
      if (!createsProject && (recipe.provider === "railway" || recipe.provider === "vercel")) {
        if (!selectors.projectId) throw new Error("Choose a provider project.");
        resource.projectId = selectors.projectId;
      }
      if (!createsProject && recipe.provider === "railway") {
        if (!selectors.environmentId) throw new Error("Choose a Railway environment.");
        resource.environmentId = selectors.environmentId;
      }
      if (recipe.provider === "fly") {
        resource.appName = selectors.name.trim();
        resource.createApp = "true";
      }
      if (selectors.region.trim()) resource.region = selectors.region.trim();
      const target = {
        provider: recipe.provider,
        workloadKind: recipe.workloadKind,
        connectionId,
        providerIdentity,
        resource,
      } as ExternalTargetInput;
      const result = await externalDeploymentsApi.plan({
        target,
        idempotencyKey: `catalog-review:${crypto.randomUUID()}`,
        catalog: { templateId: appId, recipeId, config },
      });
      if (!mounted.current || activeScope.current !== scope) return;
      setPlan(result.data);
      applyKey.current = `catalog-apply:${crypto.randomUUID()}`;
    } catch (cause) {
      if (mounted.current && activeScope.current === scope) setError(getApiErrorMessage(cause));
    } finally {
      if (mounted.current && activeScope.current === scope) setBusy(false);
    }
  }
  async function deploy() {
    if (!plan?.accepted) return;
    setBusy(true);
    setError("");
    try {
      if (new Date(plan.expiresAt).getTime() <= Date.now()) {
        setPlan(null);
        throw new Error("This review expired. Review the installation again.");
      }
      const result = await externalDeploymentsApi.apply(plan.planId, applyKey.current);
      if (mounted.current && activeScope.current === scope)
        router.push(`/apps#workload-${encodeURIComponent(result.data.targetId)}`);
    } catch (cause) {
      if (mounted.current && activeScope.current === scope) setError(getApiErrorMessage(cause));
    } finally {
      if (mounted.current && activeScope.current === scope) setBusy(false);
    }
  }
  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options?: Array<{ value: string; label: string }>,
    placeholder?: string,
  ) => (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {options ? (
        <CustomSelect
          {...selectStyle}
          aria-label={label}
          value={value}
          options={options}
          onChange={onChange}
          placeholder={placeholder ?? `Select ${label.toLowerCase()}`}
          disabled={busy}
        />
      ) : (
        <Input
          variant="filled"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={busy}
        />
      )}
    </label>
  );

  return (
    <PageContainer outerClassName="pb-20">
      <Link
        href="/apps/new"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon name="arrow-left" className="size-4" />
        App catalog
      </Link>
      {loading ? (
        <div
          className="mt-6 space-y-4 animate-pulse motion-reduce:animate-none"
          aria-label="Loading installation"
        >
          <div className="h-16 w-2/3 rounded-xl bg-muted" />
          <div className="h-80 rounded-2xl bg-card" />
        </div>
      ) : !template || !recipe ? (
        <div className="mt-6 rounded-2xl bg-card p-5">
          <h1 className="text-xl font-semibold">Installation unavailable</h1>
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error || "This app does not offer the selected destination."}
          </p>
          <Button
            onClick={() => setRevision((value) => value + 1)}
            variant="secondary"
            className="mt-4"
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <header className="mt-5 flex items-center gap-4">
            <div className="rounded-2xl bg-card p-3">
              <AppLogo appId={template.id} className="size-8" />
            </div>
            <div>
              <h1 className="text-2xl font-medium">Install {template.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
            </div>
          </header>
          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-5">
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="font-semibold">Destination</h2>
                <p className="text-sm text-muted-foreground">
                  {recipe.label} · {catalogProviderName(recipe.provider)}
                </p>
                {field(
                  "Provider connection",
                  connectionId,
                  (value) => {
                    setConnectionId(value);
                    change({ projectId: "", environmentId: "" });
                  },
                  credentials
                    .filter((item) => item.provider === recipe.provider)
                    .map((item) => ({
                      value: item.id,
                      label: `${item.name}${item.status !== "active" ? " · check connection" : ""}`,
                    })),
                )}
                {!credentials.some((item) => item.provider === recipe.provider) && (
                  <p className="text-sm text-muted-foreground">
                    Connect {catalogProviderName(recipe.provider)} to continue.{" "}
                    <Link className="underline" href="/settings?tab=connections" target="_blank">
                      Add connection
                    </Link>
                    <button
                      className="ms-2 underline"
                      onClick={() => setRevision((value) => value + 1)}
                    >
                      Refresh connections
                    </button>
                  </p>
                )}
                {connection && (
                  <p className="break-all text-xs text-muted-foreground">
                    Account:{" "}
                    {connection.publicFields.teamId ??
                      connection.publicFields.workspaceId ??
                      connection.publicFields.organizationId ??
                      connection.name}
                  </p>
                )}
                {discoveryLoading && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading destinations…
                  </p>
                )}
                {discoveryError && (
                  <p role="alert" className="text-sm text-warning">
                    {discoveryError} Enter the destination IDs below.
                  </p>
                )}
                {createsProject && (
                  <p className="rounded-xl bg-muted/40 p-3 text-sm">
                    Creates a new project in this account. Its app resources stay grouped together
                    and are removed when you delete this installation.
                  </p>
                )}
                {connection &&
                  !createsProject &&
                  (recipe.provider === "railway" || recipe.provider === "vercel") &&
                  field(
                    "Project",
                    selectors.projectId,
                    (value) => change({ projectId: value, environmentId: "" }),
                    discovery?.projects.length
                      ? discovery.projects.map((item) => ({ value: item.id, label: item.name }))
                      : undefined,
                    "Project ID",
                  )}
                {connection &&
                  !createsProject &&
                  recipe.provider === "railway" &&
                  field(
                    "Environment",
                    selectors.environmentId,
                    (value) => change({ environmentId: value }),
                    project?.environments.length
                      ? project.environments.map((item) => ({ value: item.id, label: item.name }))
                      : undefined,
                    "Environment ID",
                  )}
                {recipe.notes && <p className="text-sm text-muted-foreground">{recipe.notes}</p>}
              </section>
              <section className="space-y-4 rounded-2xl bg-card p-5">
                <h2 className="font-semibold">Configure {template.name}</h2>
                {field(
                  createsProject
                    ? "Project name"
                    : recipe.provider === "fly"
                      ? "Application name"
                      : "Workload name",
                  selectors.name,
                  (value) => change({ name: value }),
                  undefined,
                  template.id,
                )}
                {(recipe.provider === "fly" || recipe.provider === "blaxel") &&
                  field(
                    "Region",
                    selectors.region,
                    (value) => change({ region: value }),
                    undefined,
                    recipe.resource?.region ?? "Provider default",
                  )}
                {(recipe.inputs ?? []).map((item) => (
                  <label key={item.key} className="block space-y-1.5">
                    <span className="text-sm font-medium">
                      {item.label}
                      {item.required ? " *" : ""}
                    </span>
                    {item.type === "select" ? (
                      <CustomSelect
                        {...selectStyle}
                        aria-label={item.label}
                        value={config[item.key] ?? ""}
                        options={[...(item.options ?? [])]}
                        onChange={(value) => {
                          setConfig((previous) => ({ ...previous, [item.key]: value }));
                          setPlan(null);
                        }}
                        disabled={busy}
                      />
                    ) : (
                      <Input
                        aria-label={item.label}
                        variant="filled"
                        type={
                          item.type === "password"
                            ? "password"
                            : item.type === "number"
                              ? "number"
                              : "text"
                        }
                        value={config[item.key] ?? ""}
                        onChange={(event) => {
                          setConfig((previous) => ({
                            ...previous,
                            [item.key]: event.target.value,
                          }));
                          setPlan(null);
                        }}
                        autoComplete={item.type === "password" ? "new-password" : "off"}
                        disabled={busy}
                      />
                    )}
                  </label>
                ))}
              </section>
              {template.provenance && (
                <p className="text-xs text-muted-foreground">
                  Template source:{" "}
                  <a
                    href={template.provenance.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {template.provenance.source}
                  </a>
                  {template.provenance.reviewedAt
                    ? ` · reviewed ${template.provenance.reviewedAt}`
                    : ""}
                </p>
              )}
            </div>
            <aside className="space-y-4 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
              <h2 className="font-semibold">Review and install</h2>
              <AppDeploymentChoices template={template} selected={recipe.id} />
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">App</dt>
                  <dd>{template.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Connection</dt>
                  <dd className="break-words">{connection?.name ?? "Choose a connection"}</dd>
                </div>
              </dl>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {plan && (
                <div role="status" className="space-y-3 text-sm">
                  <p className="font-medium">
                    {plan.accepted ? "Ready for your review" : "Installation blocked"}
                  </p>
                  {[...new Set(plan.blockers)].map((item) => (
                    <p key={item} className="text-destructive">
                      {item}
                    </p>
                  ))}
                  {[...new Set(plan.warnings)].map((item) => (
                    <p key={item} className="text-warning">
                      {item}
                    </p>
                  ))}
                </div>
              )}
              {plan?.accepted ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    The selected provider will host this app. Provider charges may apply. Secrets
                    are hidden from this review.
                  </p>
                  <Button onClick={deploy} disabled={busy} className="w-full">
                    {busy ? "Installing…" : "Install app"}
                  </Button>
                  <button
                    className="text-xs underline text-muted-foreground"
                    onClick={() => setPlan(null)}
                    disabled={busy}
                  >
                    Edit configuration
                  </button>
                </>
              ) : (
                <Button
                  onClick={review}
                  disabled={busy || !connection || discoveryLoading}
                  className="w-full"
                >
                  {busy ? "Checking installation…" : "Review installation"}
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Installation creates a managed workload in Apps. You can check its status, open it,
                and use supported controls there.
              </p>
            </aside>
          </div>
        </>
      )}
    </PageContainer>
  );
}
