/**
 * Workbox Cloud mark. The supplied artwork has a dark cutout for light themes
 * and a light cutout for dark/dim themes; both variants share the same red mark.
 */
export function Logo({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`relative inline-block shrink-0 overflow-hidden ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/wb_cloud.webp"
        alt=""
        className="absolute block max-w-none object-contain dark:hidden dim:hidden"
        style={{ width: size * 1.244, height: size * 1.244, inset: -size * 0.122 }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/wb_cloud_dark.webp"
        alt=""
        className="absolute hidden max-w-none object-contain dark:block dim:block"
        style={{ width: size * 1.244, height: size * 1.244, inset: -size * 0.122 }}
      />
    </span>
  );
}
