export function WorkboxLogo({ size = 30, dark = false, className }: { size?: number; dark?: boolean; className?: string }) {
  const scale = 1.244;
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <img
        src={dark ? "/brand/wb_cloud_dark.webp" : "/brand/wb_cloud.webp"}
        alt=""
        className="absolute max-w-none object-contain"
        style={{ width: size * scale, height: size * scale, inset: -size * ((scale - 1) / 2) }}
      />
    </span>
  );
}
