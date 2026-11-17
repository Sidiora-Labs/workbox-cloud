"use client";

import Link from "next/link";
import type { AppTemplate } from "@repo/core";
import { Icon } from "@repo/ui/icons";

const providerLabels: Record<string, string> = {
  native: "Your servers & Cloud",
  railway: "Railway",
  vercel: "Vercel",
  fly: "Fly.io",
  blaxel: "Blaxel",
  workbox: "Workbox",
};
export const catalogProviderName = (provider: string) => providerLabels[provider] ?? provider;

export function AppDeploymentChoices({
  template,
  selected,
}: {
  template: AppTemplate;
  selected?: string;
}) {
  const recipes = template.deploymentRecipes ?? [];
  if (!recipes.length) return null;
  return (
    <nav aria-label="Install destination" className="space-y-2">
      {template.nativeSupport !== false && !!template.services?.length && (
        <Link
          href={`/apps/new/${encodeURIComponent(template.id)}`}
          aria-current={!selected ? "page" : undefined}
          className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${!selected ? "bg-foreground text-background" : "bg-muted/40 hover:bg-muted/70"}`}
        >
          <span>Your servers & Cloud</span>
          <Icon name="server" className="size-4 shrink-0" />
        </Link>
      )}
      {recipes.map((recipe) => (
        <Link
          key={recipe.id}
          href={`/apps/new/${encodeURIComponent(template.id)}?recipe=${encodeURIComponent(recipe.id)}`}
          aria-current={selected === recipe.id ? "page" : undefined}
          className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === recipe.id ? "bg-foreground text-background" : "bg-muted/40 hover:bg-muted/70"}`}
        >
          <span className="min-w-0">
            <span className="block font-medium">{catalogProviderName(recipe.provider)}</span>
            <span className="block text-xs opacity-75">{recipe.label}</span>
          </span>
          <Icon name="cloud" className="size-4 shrink-0" />
        </Link>
      ))}
    </nav>
  );
}
