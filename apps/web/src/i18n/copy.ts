import type { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Stable catalog identifiers keep the public English source readable at call sites. */
function hashMessageKey(source: string): string {
  let hash = 2166136261;
  for (const character of source.trim().replace(/\s+/g, " ")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `m${(hash >>> 0).toString(36)}`;
}

function legacySources(source: string): string[] {
  const normalized = source.trim().replace(/\s+/g, " ");
  let variants = [normalized];
  if (normalized.includes("Workbox Cloud Mail Preview"))
    variants.push(normalized.replaceAll("Workbox Cloud Mail Preview", "Zero Email Preview"));
  if (normalized.includes("Ask Workbox Cloud Mail"))
    variants.push(normalized.replaceAll("Ask Workbox Cloud Mail", "Ask Zero"));
  if (normalized.includes("A Workbox Cloud"))
    variants.push(normalized.replaceAll("A Workbox Cloud", "An OpenShip"));
  if (normalized.includes("a Workbox Cloud")) {
    variants.push(normalized.replaceAll("a Workbox Cloud", "an OpenShip"));
    variants.push(normalized.replaceAll("a Workbox Cloud", "an OpenShip Cloud"));
  }
  const token = /\bWorkbox Cloud(?: Mail| Desktop)?\b/g;
  for (const match of normalized.matchAll(token)) {
    const value = match[0];
    const replacements = value === "Workbox Cloud Mail Preview"
      ? ["Zero Email Preview", "OpenShip Mail Preview"]
      : value.startsWith("Ask Workbox Cloud Mail")
        ? [value.replace("Ask Workbox Cloud Mail", "Ask Zero"), value.replace("Ask Workbox Cloud Mail", "Ask OpenShip Mail")]
        : value.endsWith(" Mail")
      ? ["OpenShip Mail"]
      : value.endsWith(" Desktop")
        ? ["OpenShip Desktop"]
        : ["OpenShip Cloud", "OpenShip"];
    variants = variants.flatMap((current) =>
      replacements.map((replacement) => {
        const index = current.indexOf(value);
        return index < 0 ? current : current.slice(0, index) + replacement + current.slice(index + value.length);
      }),
    );
  }
  return [...new Set(variants.map((value) => value.replace(/\bOpenship\b/g, "OpenShip")))];
}

export function messageKey(source: string): string {
  return hashMessageKey(legacySources(source)[1] ?? legacySources(source)[0] ?? source);
}

/** Keys retained for catalogs authored before the Workbox Cloud rebrand. */
export function legacyMessageKeys(source: string): string[] {
  return legacySources(source).map(hashMessageKey);
}

/** Apply the current product display name without changing message keys. */
export function brandCopy(value: string): string {
  return value
    .replace(/\bOpenShip Cloud\b/gi, "Workbox Cloud")
    .replace(/\bOpenship Cloud\b/gi, "Workbox Cloud")
    .replace(/\bOpenShip Mail\b/gi, "Workbox Cloud Mail")
    .replace(/\bOpenship Mail\b/gi, "Workbox Cloud Mail")
    .replace(/\bOpenShip Desktop\b/gi, "Workbox Cloud Desktop")
    .replace(/\bOpenship Desktop\b/gi, "Workbox Cloud Desktop")
    .replace(/\bOpenShip\b(?![-.\/])/gi, "Workbox Cloud")
    .replace(/\bOpenship\b(?![-.\/])/gi, "Workbox Cloud");
}

export type Copy = {
  <T>(value: T, values?: Record<string, string | number>): T;
  rich(
    source: string,
    values: Record<string, string | number | ((children: ReactNode) => ReactNode)>,
  ): ReactNode;
};

const technicalFields = new Set([
  "id",
  "slug",
  "slugs",
  "href",
  "url",
  "src",
  "image",
  "images",
  "logo",
  "logos",
  "code",
  "command",
  "commands",
  "shell",
  "repository",
  "protocol",
  "transport",
  "category",
  "@type",
  "@context",
  "@id",
  "type",
  "rel",
  "unitCode",
  "priceCurrency",
  "currency",
  "inLanguage",
]);

export function createCopy(t: ReturnType<typeof useTranslations>): Copy {
  const copy = <T>(value: T, values?: Record<string, string | number>): T => {
    if (typeof value !== "string" || !value.trim()) return value;
    const key = legacyMessageKeys(value).find((candidate) => t.has(candidate));
    if (!key) return brandCopy(value) as T;
    const prefix = value.match(/^\s*/)?.[0] ?? "";
    const suffix = value.match(/\s*$/)?.[0] ?? "";
    const translated = values ? t(key, values) : t.raw(key);
    return typeof translated === "string"
      ? (`${prefix}${brandCopy(translated)}${suffix}` as T)
      : brandCopy(value) as T;
  };
  return Object.assign(copy, {
    rich: (source: string, values: Parameters<Copy["rich"]>[1]) => {
      const key = legacyMessageKeys(source).find((candidate) => t.has(candidate));
      return key ? t.rich(key, values) : source;
    },
  });
}

/** Translate public presentation data without mutating shared module constants. */
export function translateCopyData<T>(value: T, copy: Copy): T {
  if (typeof value === "string") return copy(value);
  if (Array.isArray(value)) return value.map((item) => translateCopyData(item, copy)) as T;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !("$$typeof" in value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        technicalFields.has(key) ? entry : translateCopyData(entry, copy),
      ]),
    ) as T;
  }
  return value;
}
