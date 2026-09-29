/**
 * Quality tiers.
 *
 * Every knob that trades visual fidelity for frame time lives here, so the
 * adaptive controller has exactly one thing to mutate and the debug HUD has
 * exactly one thing to display.
 */

export type TierName = 'ultra' | 'high' | 'balanced' | 'efficient' | 'minimal';

export interface QualitySettings {
  name: TierName;
  /** Device-pixel-ratio ceiling. The single biggest lever, and the subtlest. */
  maxDpr: number;
  /**
   * Cube-map face size for the baked surface. Cube rather than equirect:
   * no pole pinch, uniform texel density, and no +/-180 seam where screen-space
   * derivatives blow up and draw a bright line down the planet.
   */
  bakeSize: number;
  heroBakeSize: number;
  /** Icosphere subdivision cap. */
  maxGeometryDetail: number;
  /** Bloom mip levels. 0 disables the effect entirely. */
  bloomLevels: number;
  /** MSAA samples on the HDR scene target. */
  msaa: number;
  shadowMapSize: number;
  /** Raymarch steps in the atmosphere shell. */
  atmosphereSteps: number;
  /** Extra procedural detail octaves blended in at close range. */
  detailOctaves: number;
  ringSegments: number;
  asteroidCount: number;
  /** Star cubemap face size. */
  starCubeSize: number;
  chromaticAberration: boolean;
  filmGrain: boolean;
  godRays: boolean;
  maxActiveMoons: number;
}

export const TIERS: Record<TierName, QualitySettings> = {
  ultra: {
    name: 'ultra',
    maxDpr: 2,
    bakeSize: 256,
    heroBakeSize: 512,
    maxGeometryDetail: 6,
    bloomLevels: 8,
    msaa: 4,
    shadowMapSize: 2048,
    atmosphereSteps: 12,
    detailOctaves: 3,
    ringSegments: 512,
    asteroidCount: 12000,
    starCubeSize: 1024,
    chromaticAberration: true,
    filmGrain: true,
    godRays: true,
    maxActiveMoons: 24,
  },
  high: {
    name: 'high',
    maxDpr: 1.75,
    bakeSize: 256,
    heroBakeSize: 512,
    maxGeometryDetail: 5,
    bloomLevels: 7,
    msaa: 4,
    shadowMapSize: 2048,
    atmosphereSteps: 10,
    detailOctaves: 2,
    ringSegments: 384,
    asteroidCount: 8000,
    starCubeSize: 1024,
    chromaticAberration: true,
    filmGrain: true,
    godRays: false,
    maxActiveMoons: 20,
  },
  balanced: {
    name: 'balanced',
    maxDpr: 1.5,
    bakeSize: 128,
    heroBakeSize: 256,
    maxGeometryDetail: 5,
    bloomLevels: 6,
    msaa: 2,
    shadowMapSize: 1024,
    atmosphereSteps: 8,
    detailOctaves: 1,
    ringSegments: 256,
    asteroidCount: 5000,
    starCubeSize: 512,
    chromaticAberration: true,
    filmGrain: false,
    godRays: false,
    maxActiveMoons: 14,
  },
  efficient: {
    name: 'efficient',
    maxDpr: 1.25,
    bakeSize: 128,
    heroBakeSize: 256,
    maxGeometryDetail: 4,
    bloomLevels: 5,
    msaa: 0,
    shadowMapSize: 512,
    atmosphereSteps: 6,
    detailOctaves: 0,
    ringSegments: 192,
    asteroidCount: 2500,
    starCubeSize: 512,
    chromaticAberration: false,
    filmGrain: false,
    godRays: false,
    maxActiveMoons: 8,
  },
  minimal: {
    name: 'minimal',
    maxDpr: 1,
    bakeSize: 64,
    heroBakeSize: 128,
    maxGeometryDetail: 3,
    bloomLevels: 0,
    msaa: 0,
    shadowMapSize: 0,
    atmosphereSteps: 4,
    detailOctaves: 0,
    ringSegments: 128,
    asteroidCount: 0,
    starCubeSize: 256,
    chromaticAberration: false,
    filmGrain: false,
    godRays: false,
    maxActiveMoons: 4,
  },
};

export const TIER_ORDER: TierName[] = [
  'minimal',
  'efficient',
  'balanced',
  'high',
  'ultra',
];

export const tierIndex = (name: TierName): number => TIER_ORDER.indexOf(name);

export const stepTier = (name: TierName, direction: 1 | -1): TierName => {
  const i = tierIndex(name) + direction;
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i))];
};

export interface DeviceProbe {
  isMobile: boolean;
  hasCoarsePointer: boolean;
  cores: number;
  memoryGB: number;
  maxTextureSize: number;
  renderer: string;
  /** True when the GL renderer string looks like a software rasteriser. */
  isSoftware: boolean;
  webgl2: boolean;
}

export function probeDevice(canvas?: HTMLCanvasElement): DeviceProbe {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = nav?.userAgent ?? '';
  const hasCoarsePointer =
    typeof matchMedia !== 'undefined' &&
    matchMedia('(pointer: coarse)').matches;
  const isMobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || hasCoarsePointer;

  let renderer = 'unknown';
  let maxTextureSize = 4096;
  let webgl2 = false;

  try {
    const c = canvas ?? document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      // Release the probe context immediately: browsers cap live contexts
      // (about 16), and the throwaway one would otherwise linger until GC.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Probing must never throw; a conservative tier is a fine fallback.
  }

  const isSoftware = /swiftshader|llvmpipe|software|mesa offscreen/i.test(
    renderer
  );

  return {
    isMobile,
    hasCoarsePointer,
    cores: nav?.hardwareConcurrency ?? 4,
    memoryGB: (nav as unknown as { deviceMemory?: number })?.deviceMemory ?? 4,
    maxTextureSize,
    renderer,
    isSoftware,
    webgl2,
  };
}

/**
 * Read a `?tier=` override from the URL.
 *
 * Needed for verification: a software rasteriser is correctly detected as
 * `minimal`, which means screenshots taken in CI would never exercise the
 * bloom, atmosphere or detail paths that ship to real hardware.
 */
export function tierFromUrl(): TierName | null {
  if (typeof location === 'undefined') return null;
  const value = new URLSearchParams(location.search).get('tier');
  return value && (TIER_ORDER as string[]).includes(value)
    ? (value as TierName)
    : null;
}

/** Pick a starting tier. The adaptive controller refines it from there. */
export function initialTier(probe: DeviceProbe): TierName {
  const forced = tierFromUrl();
  if (forced) return forced;
  if (!probe.webgl2 || probe.isSoftware) return 'minimal';
  if (probe.isMobile) {
    if (probe.cores >= 6 && probe.memoryGB >= 4) return 'balanced';
    return 'efficient';
  }
  // Discrete-GPU signatures. Conservative: a wrong guess up costs a visible
  // demote in the first two seconds, a wrong guess down costs nothing but a
  // slightly soft first impression that the controller corrects.
  if (/rtx|radeon rx|arc a|apple m[1-9]/i.test(probe.renderer)) return 'ultra';
  if (probe.cores >= 8 && probe.memoryGB >= 8) return 'high';
  return 'balanced';
}
