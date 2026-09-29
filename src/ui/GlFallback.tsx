interface Props {
  reason: 'unsupported' | 'lost';
}

/**
 * Shown instead of the canvas when WebGL2 is missing, or when the GPU context
 * is lost mid-session (driver reset, mobile tab eviction). Reuses the crash
 * card so it inherits the glass styling and the alert semantics.
 */
export function GlFallback({ reason }: Props) {
  const lost = reason === 'lost';
  return (
    <div className="crash" role="alert" data-testid="gl-fallback">
      <div className="crash__card">
        <h1>
          {lost ? 'The graphics context was lost' : 'WebGL 2 is unavailable'}
        </h1>
        <p>
          {lost
            ? 'The browser reclaimed the GPU, usually after a driver reset or a long time in the background. Reloading restores the simulation.'
            : 'Orrery draws every planet on your GPU and needs WebGL 2. Try a current version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled in your browser settings.'}
        </p>
        <div className="crash__actions">
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    </div>
  );
}
