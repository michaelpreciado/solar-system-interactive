import { describe, expect, it } from 'vitest';
import {
  TIERS,
  TIER_ORDER,
  initialTier,
  stepTier,
  type DeviceProbe,
} from '../perf/tiers';

const probe = (over: Partial<DeviceProbe> = {}): DeviceProbe => ({
  isMobile: false,
  hasCoarsePointer: false,
  cores: 8,
  memoryGB: 8,
  maxTextureSize: 8192,
  renderer: 'ANGLE (NVIDIA GeForce RTX 4070)',
  isSoftware: false,
  webgl2: true,
  ...over,
});

describe('quality tiers', () => {
  it('scale down monotonically in cost-bearing knobs', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const lo = TIERS[TIER_ORDER[i - 1]];
      const hi = TIERS[TIER_ORDER[i]];
      expect(hi.maxDpr).toBeGreaterThanOrEqual(lo.maxDpr);
      expect(hi.bakeSize).toBeGreaterThanOrEqual(lo.bakeSize);
      expect(hi.asteroidCount).toBeGreaterThanOrEqual(lo.asteroidCount);
      expect(hi.bloomLevels).toBeGreaterThanOrEqual(lo.bloomLevels);
    }
  });

  it('clamps stepping at both ends', () => {
    expect(stepTier('minimal', -1)).toBe('minimal');
    expect(stepTier('ultra', 1)).toBe('ultra');
  });

  it('starts software rasterisers and WebGL1 devices on minimal', () => {
    expect(initialTier(probe({ isSoftware: true }))).toBe('minimal');
    expect(initialTier(probe({ webgl2: false }))).toBe('minimal');
  });

  it('starts phones below desktop discrete GPUs', () => {
    expect(initialTier(probe({ isMobile: true, cores: 4 }))).toBe('efficient');
    expect(initialTier(probe())).toBe('ultra');
  });
});
