/** Someone's profile photo, or their initials when they have none. */
export function Avatar({ name, src, size = 28 }: { name: string; src?: string | null; size?: number }) {
  const style = { width: size, height: size };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" style={style} className="shrink-0 rounded-full bg-surface-2 object-cover" />;
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      style={{ ...style, fontSize: Math.round(size * 0.4) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-bold text-muted"
    >
      {initials}
    </span>
  );
}
