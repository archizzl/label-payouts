/** Someone's profile photo, or their initials when they have none. */
export function Avatar({ name, src, size = 28, square = false }: { name: string; src?: string | null; size?: number; square?: boolean }) {
  const style = { width: size, height: size };
  // A group's (a label or band) is square; a person's round.
  const shape = square ? "rounded-sm" : "rounded-full";
  if (src) {
    // A Bandcamp photo at its small (100px) size.
    const small = /^https:\/\/f4\.bcbits\.com\/img\//.test(src) ? src.replace(/_\d+\.jpg$/, "_3.jpg") : src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={small} alt="" style={style} className={`shrink-0 ${shape} bg-surface-2 object-cover`} />;
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
      className={`inline-flex shrink-0 items-center justify-center ${shape} bg-surface-2 font-bold text-muted`}
    >
      {initials}
    </span>
  );
}
