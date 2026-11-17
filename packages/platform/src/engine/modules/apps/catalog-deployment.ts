import { createHash } from "node:crypto";
import { AppError, type AppTemplate } from "@repo/core";
import type { ExternalCatalogIdentity, ExternalPlanInput } from "@repo/contracts";
import { getRuntimeTemplate } from "./catalog-source";

export const CATALOG_RESOURCE_KEYS = ["appTemplateId", "appRecipeId", "appTemplateName", "appTemplateLogo", "appTemplateVersion", "appTemplateDigest"] as const;
const destinations = new Set(["name", "projectId", "environmentId", "appName", "region", "createApp"]);
const sensitive = /^(environment|env|envs|variables|secrets|apiKey|apiToken|token|password|authorization|config)$/i;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;

export function catalogIdentity(resource: Record<string, unknown>): ExternalCatalogIdentity | undefined {
  if (typeof resource.appTemplateId !== "string" || typeof resource.appRecipeId !== "string" || typeof resource.appTemplateDigest !== "string" || !/^[a-f0-9]{64}$/.test(resource.appTemplateDigest)) return undefined;
  return { templateId: resource.appTemplateId, recipeId: resource.appRecipeId,
    name: String(resource.appTemplateName ?? resource.appTemplateId), logo: String(resource.appTemplateLogo ?? "package"),
    digest: resource.appTemplateDigest, ...(resource.appTemplateVersion ? { version: String(resource.appTemplateVersion) } : {}) };
}

/** Pure resolution makes unsupported recipe features and tampered inputs testable without cloud access. */
export function resolveTemplateRecipe(template: AppTemplate, input: ExternalPlanInput): ExternalPlanInput {
  const selection = input.catalog;
  if (!selection || selection.templateId !== template.id || template.custom || !template.available)
    throw new AppError("This catalog recipe is not available.", 400, "APP_RECIPE_UNAVAILABLE");
  const recipe = template.deploymentRecipes?.find(item => item.id === selection.recipeId);
  if (!recipe || recipe.provider !== input.target.provider || recipe.workloadKind !== input.target.workloadKind)
    throw new AppError("Choose a supported deployment recipe for this provider.", 400, "APP_RECIPE_UNSUPPORTED");
  if (input.image || input.source || input.environment || input.workload)
    throw new AppError("Catalog deployments use the reviewed recipe. Change its declared configuration fields instead.", 400, "APP_RECIPE_OVERRIDE");
  for (const key of Object.keys(input.target.resource)) if (!destinations.has(key))
    throw new AppError("Catalog deployments accept only declared configuration and destination fields.", 400, "APP_RECIPE_OVERRIDE");
  const resource: Record<string, string> = { ...recipe.resource, ...input.target.resource };
  const source: Record<string, string> = { ...recipe.source };
  const environment: Record<string, string> = { ...recipe.environment };
  if (Object.keys(source).some(key => sensitive.test(key)))
    throw new AppError("Secret recipe values must use the encrypted environment field.", 400, "APP_RECIPE_INVALID");
  const definitions = new Map((recipe.inputs ?? []).map(field => [field.key, field]));
  for (const key of Object.keys(selection.config ?? {})) if (!definitions.has(key))
    throw new AppError("The catalog configuration contains an unknown field.", 400, "APP_RECIPE_INPUT_INVALID");
  for (const field of definitions.values()) {
    const value = selection.config?.[field.key] ?? field.default;
    if (field.required && !value?.trim()) throw new AppError(`${field.label} is required.`, 400, "APP_RECIPE_INPUT_REQUIRED");
    if (value === undefined || value === "") continue;
    if (field.type === "number" && !Number.isFinite(Number(value))) throw new AppError(`${field.label} must be a number.`, 400, "APP_RECIPE_INPUT_INVALID");
    if (field.type === "select" && !field.options?.some(option => option.value === value)) throw new AppError(`${field.label} has an invalid choice.`, 400, "APP_RECIPE_INPUT_INVALID");
    const key = field.targetKey ?? field.key;
    if ((field.type === "password" && field.target !== "environment") || (field.target !== "environment" && sensitive.test(key)) || (field.target === "resource" && CATALOG_RESOURCE_KEYS.includes(key as typeof CATALOG_RESOURCE_KEYS[number])))
      throw new AppError("The catalog recipe has an unsafe configuration mapping.", 400, "APP_RECIPE_INVALID");
    (field.target === "environment" ? environment : field.target === "source" ? source : resource)[key] = value;
  }
  const digest = createHash("sha256").update(JSON.stringify(canonical(template))).digest("hex");
  Object.assign(resource, { appTemplateId: template.id, appRecipeId: recipe.id, appTemplateName: template.name,
    appTemplateLogo: template.logo, appTemplateVersion: template.provenance?.revision ?? template.updatedAt ?? digest, appTemplateDigest: digest });
  return { target: { ...input.target, resource }, idempotencyKey: input.idempotencyKey,
    ...(recipe.image ? { image: recipe.image } : {}), ...(Object.keys(source).length ? { source } : {}),
    ...(Object.keys(environment).length ? { environment } : {}) };
}

export function resolveCatalogDeployment(input: ExternalPlanInput): ExternalPlanInput {
  if (!input.catalog) {
    if (CATALOG_RESOURCE_KEYS.some(key => key in input.target.resource))
      throw new AppError("Catalog identity is assigned by the server.", 400, "APP_RECIPE_OVERRIDE");
    return input;
  }
  const template = getRuntimeTemplate(input.catalog.templateId);
  if (!template || template.requiresUpdate) throw new AppError("This catalog recipe is unavailable or needs a newer version.", 400, "APP_RECIPE_UNAVAILABLE");
  return resolveTemplateRecipe(template, input);
}

export function requiredRecipeCapabilities(resource: Record<string, string>): readonly string[] {
  const identity = catalogIdentity(resource);
  if (!identity) return [];
  return getRuntimeTemplate(identity.templateId)?.deploymentRecipes?.find(recipe => recipe.id === identity.recipeId)?.requiredCapabilities ?? [];
}
