"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExternalOperation } from "@repo/contracts";
import { externalDeploymentsApi } from "@/lib/api/external-deployments";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { getApiErrorMessage } from "@/lib/api/client";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { ExternalWorkload } from "@/components/workloads/WorkloadsPage";
import { currentWorkloads } from "@/components/workloads/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";

export function InstalledProviderApps({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
}) {
  const scope = useResourceScope();
  return <ScopedInstalledProviderApps key={scope} onCountChange={onCountChange} />;
}

function ScopedInstalledProviderApps({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
}) {
  const [operations, setOperations] = useState<ExternalOperation[]>([]);
  const [connections, setConnections] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const active = useRef(true);
  const refresh = useCallback(async (observe = false) => {
    try {
      const [listed, accounts] = await Promise.all([
        externalDeploymentsApi.operations(),
        credentialsApi.list(),
      ]);
      if (!active.current) return;
      const installed = currentWorkloads(listed.data).filter((row) => !!row.target.catalog);
      setOperations(installed);
      setConnections(accounts.data);
      setError("");
      if (observe) {
        const observations = await Promise.allSettled(
          installed
            .filter(
              (row) =>
                row.providerResourceId && !(row.kind === "destroy" && row.status === "stopped"),
            )
            .map((row) => externalDeploymentsApi.observe(row)),
        );
        const failed = observations.find((result) => result.status === "rejected");
        if (active.current && failed?.status === "rejected")
          setError(getApiErrorMessage(failed.reason));
        const updated = await externalDeploymentsApi.operations();
        if (active.current)
          setOperations(currentWorkloads(updated.data).filter((row) => !!row.target.catalog));
      }
    } catch (cause) {
      if (active.current) setError(getApiErrorMessage(cause));
    } finally {
      if (active.current) setLoading(false);
    }
  }, []);
  const visible = operations.filter((row) => !(row.kind === "destroy" && row.status === "stopped"));
  useEffect(() => {
    if (!loading) onCountChange?.(visible.length);
  }, [loading, visible.length, onCountChange]);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh]);
  const pending = useMemo(
    () =>
      operations.some((row) =>
        ["queued", "provisioning", "reconciling", "stopping"].includes(row.status),
      ),
    [operations],
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void refresh(true), 8000);
    return () => clearTimeout(timer);
  }, [operations, pending, refresh]);
  if (!loading && !error && !visible.length) return null;
  return (
    <section aria-labelledby="installed-provider-apps" className="mt-8 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="installed-provider-apps" className="text-base font-semibold">
            Provider apps
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Catalog apps installed on connected cloud providers.
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void refresh(true)}>
          <Icon name="refresh" className="size-4" />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-card p-4 text-sm text-destructive">
          {error}{" "}
          <button className="underline" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      )}
      {loading ? (
        <div
          aria-label="Loading provider apps"
          className="h-32 rounded-2xl bg-card animate-pulse motion-reduce:animate-none"
        />
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((operation) => (
            <ExternalWorkload
              key={operation.targetId}
              operation={operation}
              connections={connections}
              refresh={() => refresh()}
            />
          ))}
        </div>
      )}
    </section>
  );
}
