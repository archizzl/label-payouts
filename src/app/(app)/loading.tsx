/**
 * Shown the moment you click to another page, while it loads: the page's outline in quiet grey
 * blocks (the navigation above stays put).
 */
export default function Loading() {
  const bar = "animate-pulse rounded-sm bg-surface-2";
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-8">
        <div className={`${bar} h-8 w-48`} />
        <div className={`${bar} mt-3 h-4 w-80 max-w-full`} />
      </div>
      {[0, 1].map((section) => (
        <section key={section} className="mb-10">
          <div className="mb-3 border-b border-border pb-2">
            <div className={`${bar} h-5 w-36`} />
          </div>
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className={`${bar} h-4`} style={{ width: `${90 - row * 15}%` }} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
