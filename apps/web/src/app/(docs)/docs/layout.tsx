import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { docsSource } from "@/lib/source";
import type { ReactNode } from "react";

// fumadocs-ui/style.css is imported once in the (docs) ROOT layout so the
// stylesheet is confined to the docs document (see (docs)/layout.tsx).

/**
 * Native Fumadocs "Notebook" docs shell — full-width navbar on top (like
 * fumadocs.dev), sidebar + TOC below. RootProvider is scoped to /docs so the
 * light-only marketing site is untouched, while docs get the full native
 * experience: light/dark theme + toggle, native search (/api/search), sidebar,
 * TOC. No custom theming — stock Fumadocs.
 */
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ defaultTheme: "light", enableSystem: false }}>
      <DocsLayout
        tree={docsSource.pageTree}
        nav={{
          mode: "top",
          title: (
            // Same mark as the marketing navbar: the supplied Workbox Cloud mark + wordmark.
            //
            // INLINE STYLES, not Tailwind utilities: this document loads ONLY
            // fumadocs' standalone Tailwind build (see (docs)/layout.tsx), which
            // contains just the classes fumadocs itself uses. Arbitrary utilities
            // like `h-[22px]`/`border-[2.5px]` aren't in it, so with preflight's
            // `border-width: 0` the ring rendered as a 0x0 invisible span — the
            // wordmark showed alone. `currentColor` keeps the ring tracking the nav
            // text through the light/dark toggle.
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 28, height: 28, flexShrink: 0, overflow: "hidden", position: "relative", display: "inline-block" }}>
                <img
                  src="/brand/wb_cloud.webp"
                  alt=""
                  width={35}
                  height={35}
                  style={{ position: "absolute", inset: -3.5, maxWidth: "none" }}
                />
              </span>
              <span style={{ fontWeight: 600 }}>Workbox Cloud</span>
            </span>
          ),
          url: "/",
        }}
        githubUrl="https://github.com/oblien/openship"
        links={[
          { text: "Changelog", url: "/changelog" },
          { text: "Blog", url: "/blog" },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
