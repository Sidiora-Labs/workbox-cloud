"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { OptionCard } from "@/components/shared/OptionCard";

/** Provider resource kinds exposed by the external destination registry. */
export type ExternalWorkloadKind =
  | "service"
  | "railway-sandbox"
  | "vercel-sandbox"
  | "fly-machine"
  | "fly-sprite"
  | "workbox-host"
  | "workbox-sandbox";

export interface ExternalDestinationOption {
  id: string;
  /** Durable provider connection selected for this target. */
  connectionId?: string;
  /** Provider resource ID, when the UI option represents a discovered resource. */
  providerResourceId?: string;
  provider: "railway" | "vercel" | "fly" | "workbox";
  workloadKind: ExternalWorkloadKind;
  name: string;
  /** Account, team, workspace, project or environment shown below the target. */
  scope?: string;
  description?: string;
  /** Capability/preflight warning returned by the API. */
  warning?: string;
  disabled?: boolean;
  disabledReason?: string;
  icon?: IconName;
  /** Optional provider logo or custom mark supplied by the caller. */
  logo?: ReactNode;
}

export interface ExternalDestinationValue {
  targetId: string;
  provider: ExternalDestinationOption["provider"];
  workloadKind: ExternalWorkloadKind;
  connectionId?: string;
  providerResourceId?: string;
}

const WORKLOAD_LABELS: Record<ExternalWorkloadKind, string> = {
  service: "Service container",
  "railway-sandbox": "Railway Sandbox",
  "vercel-sandbox": "Vercel Sandbox",
  "fly-machine": "Fly Machine",
  "fly-sprite": "Fly Sprite",
  "workbox-host": "Workbox host",
  "workbox-sandbox": "Workbox sandbox",
};

const PROVIDER_LABELS: Record<ExternalDestinationOption["provider"], string> = {
  railway: "Railway",
  vercel: "Vercel",
  fly: "Fly.io",
  workbox: "Workbox",
};

const DEFAULT_ICONS: Record<ExternalWorkloadKind, IconName> = {
  service: "server",
  "railway-sandbox": "layers",
  "vercel-sandbox": "layers",
  "fly-machine": "cloud",
  "fly-sprite": "cpu",
  "workbox-host": "terminal",
  "workbox-sandbox": "terminal",
};

/**
 * Provider-aware destination cards used by deployment and app wizards.
 *
 * This component is intentionally data-driven: an empty option list renders no
 * external controls, so existing self-managed and Cloud flows remain unchanged
 * until the API exposes external targets for an organization.
 */
export function ExternalDestinationPicker({
  options,
  value,
  onChange,
  disabled = false,
  label = "External destination",
  emptyMessage = "No external destinations are connected.",
}: {
  options: readonly ExternalDestinationOption[];
  value?: ExternalDestinationValue | null;
  onChange: (value: ExternalDestinationValue, option: ExternalDestinationOption) => void;
  disabled?: boolean;
  label?: string;
  emptyMessage?: string;
}) {
  if (options.length === 0) {
    return (
      <div className="rounded-xl bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <section aria-label={label} className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose the account and workload kind explicitly. Service containers and sandboxes have separate lifecycles.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[36rem]/target:grid-cols-2">
        {options.map((option) => {
          const selected = value?.targetId === option.id;
          const icon = option.logo ?? <Icon name={option.icon ?? DEFAULT_ICONS[option.workloadKind]} className="size-5" />;
          const scope = option.scope ? `${PROVIDER_LABELS[option.provider]} · ${option.scope}` : PROVIDER_LABELS[option.provider];
          const baseDescription = option.description ?? `${scope} · ${WORKLOAD_LABELS[option.workloadKind]}`;
          const description = option.disabledReason
            ? `${baseDescription} · ${option.disabledReason}`
            : baseDescription;
          const unavailable = option.disabled || Boolean(option.disabledReason);
          return (
            <OptionCard
              key={option.id}
              value={option.id}
              selected={selected}
              disabled={disabled || unavailable}
              onSelect={() => onChange({
                targetId: option.id,
                provider: option.provider,
                workloadKind: option.workloadKind,
                connectionId: option.connectionId,
                providerResourceId: option.providerResourceId,
              }, option)}
              icon={icon}
              label={option.name}
              description={description}
              badge={(
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {WORKLOAD_LABELS[option.workloadKind]}
                </span>
              )}
            >
              {(option.warning || option.disabledReason) && (
                <p className="mt-2 text-xs text-warning">
                  {option.disabledReason ?? option.warning}
                </p>
              )}
            </OptionCard>
          );
        })}
      </div>
    </section>
  );
}
