import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACESFilmicToneMapping, NoToneMapping } from 'three';

import { Scene } from './scene/Scene';
import { SceneDriver } from './scene/SceneDriver';
import { createDriverHandle } from './scene/driverHandle';
import { Composer } from './scene/Composer';
import { Pointer } from './scene/Pointer';
import { quality } from './perf/QualityManager';
import { initialTier, probeDevice, tierFromUrl } from './perf/tiers';
import { useUIStore } from './state/uiStore';
import { LoadingScreen } from './ui/LoadingScreen';
import { Hud } from './ui/Hud';
import { DebugHud } from './perf/DebugHud';
import { useKeyboardShortcuts } from './ui/useKeyboardShortcuts';
import { useCursorGlow } from './ui/useCursorGlow';
import { audio } from './audio/engine';

export default function App() {
  const labelLayer = useRef<HTMLDivElement>(null);
  const appRoot = useRef<HTMLDivElement>(null);
  const handle = useMemo(() => createDriverHandle(), []);
  const [bakeProgress, setBakeProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const setReducedMotion = useUIStore((s) => s.setReducedMotion);

  // Probe the device and pick a starting tier before the canvas mounts, so the
  // first bake happens at the right resolution rather than being redone.
  const [dpr] = useState(() => {
    const probe = probeDevice();
    const forced = tierFromUrl();
    const tier = initialTier(probe);
    if (forced) {
      quality.locked = true;
      quality.setTier(forced, 'url override');
    } else if (useUIStore.getState().tierAuto) {
      quality.setTier(tier, 'device probe');
    } else {
      quality.setTier(useUIStore.getState().tier, 'user preference');
    }
    return Math.min(window.devicePixelRatio || 1, quality.settings.maxDpr);
  });

  useEffect(() => {
    quality.detectRefreshRate().then((hz) => {
      const target = useUIStore.getState().targetFps;
      quality.setTargetFps(Math.min(hz, target));
    });
  }, []);

  // Keep the store's tier in sync when the adaptive controller changes it, so
  // the settings panel shows the truth. This fires at most once every 5 s.
  useEffect(
    () =>
      quality.subscribe((settings) => {
        useUIStore.setState({ tier: settings.name });
      }),
    []
  );

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setReducedMotion]);

  useKeyboardShortcuts(handle);
  useCursorGlow(appRoot);

  useEffect(() => () => audio.dispose(), []);

  const onBakeProgress = useCallback((done: number, total: number) => {
    setBakeProgress(done / total);
  }, []);

  const onReady = useCallback(() => setReady(true), []);

  return (
    <div className="app-root" ref={appRoot}>
      <Canvas
        dpr={dpr}
        gl={{
          antialias: false, // MSAA is configured on the composer's render target
          alpha: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
          preserveDrawingBuffer: false,
        }}
        camera={{ fov: 55, near: 0.1, far: 1e7, position: [0, 220, 620] }}
        onCreated={({ gl }) => {
          // Tone mapping happens inside the composer, after bloom. Doing it
          // here as well would crush the HDR range before it can bloom.
          gl.toneMapping =
            quality.settings.bloomLevels > 0
              ? NoToneMapping
              : ACESFilmicToneMapping;
        }}
      >
        <Scene labelLayer={labelLayer} onBakeProgress={onBakeProgress} />
        <SceneDriver
          handle={handle}
          labelLayer={labelLayer}
          onReady={onReady}
        />
        <Pointer handle={handle} />
        <Composer />
      </Canvas>

      {/* Labels live outside the canvas and are positioned by direct transform
          writes from the driver -- no React involvement per frame. */}
      <div ref={labelLayer} className="label-layer" aria-hidden="true" />

      <div className="cinematic-frame" aria-hidden="true">
        <span className="cinematic-frame__corner cinematic-frame__corner--tl" />
        <span className="cinematic-frame__corner cinematic-frame__corner--tr" />
        <span className="cinematic-frame__corner cinematic-frame__corner--bl" />
        <span className="cinematic-frame__corner cinematic-frame__corner--br" />
        <span className="cinematic-frame__grain" />
      </div>

      <div className="cursor-glow" aria-hidden="true" />

      <Hud />
      <span className="credit">
        Built by <b>Preciado Tech</b>
      </span>
      <DebugHud />
      <LoadingScreen progress={bakeProgress} ready={ready} />
    </div>
  );
}
