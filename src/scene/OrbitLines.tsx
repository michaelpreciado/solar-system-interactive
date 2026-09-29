/**
 * Orbit paths.
 *
 * Each orbit is sampled once into a closed loop and never rebuilt. The scale
 * morph and the floating origin are applied as group transforms, so switching
 * between compressed and true scale costs one `scale` write rather than
 * regenerating nine buffers.
 *
 * Plain `Line` rather than `Line2`: at the widths that read well here (1 px)
 * the fat-line machinery buys nothing and costs a screen-space resolution
 * uniform that has to be maintained on every resize -- a well-known source of
 * "the lines vanished" bugs.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
} from 'three';

import { BODIES, compressDistance } from '../data/bodies';
import { AU } from '../sim/constants';
import { PLANET_ELEMENTS, propagate } from '../sim/ephemeris';
import { simClock } from '../sim/SimClock';
import { floatingOrigin } from '../sim/floatingOrigin';
import { uiState } from '../state/uiStore';
import { getOrbitMorph } from './orbitMorph';

const SEGMENTS = 512;

interface OrbitEntry {
  id: string;
  line: LineLoop;
  material: LineBasicMaterial;
  /** Both scale endpoints, so the morph is a per-frame lerp of a scalar. */
  truePositions: Float32Array;
  compressedPositions: Float32Array;
  geometry: BufferGeometry;
}

export function OrbitLines() {
  const groupRef = useRef<Group>(null);
  const scratch = useMemo(() => new Float64Array(3), []);

  const entries = useMemo<OrbitEntry[]>(() => {
    const out: OrbitEntry[] = [];

    for (const body of BODIES) {
      if (!body.planetId) continue;
      const elements = PLANET_ELEMENTS[body.planetId];

      // Sample a full period so the loop closes exactly, using the mean-motion
      // implied by the secular rate on mean longitude.
      const periodDays = (36525 * 360) / elements.LDot;
      const truePositions = new Float32Array(SEGMENTS * 3);
      const compressedPositions = new Float32Array(SEGMENTS * 3);

      for (let i = 0; i < SEGMENTS; i++) {
        const jd = simClock.jd + (i / SEGMENTS) * periodDays;
        propagate(elements, jd, scratch, 0);
        const ex = scratch[0];
        const ey = scratch[1];
        const ez = scratch[2];
        const rAU = Math.hypot(ex, ey, ez);
        const k = rAU > 0 ? compressDistance(rAU) / (rAU * AU) : 0;

        const o = i * 3;
        truePositions[o] = ex * AU;
        truePositions[o + 1] = ez * AU;
        truePositions[o + 2] = -ey * AU;

        compressedPositions[o] = ex * AU * k;
        compressedPositions[o + 1] = ez * AU * k;
        compressedPositions[o + 2] = -ey * AU * k;
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(new Float32Array(SEGMENTS * 3), 3)
      );
      geometry.attributes.position.needsUpdate = true;

      const material = new LineBasicMaterial({
        // Mostly the matrix cyan, tinted toward the body so orbits stay legible.
        color: new Color('#5ce1f2').lerp(new Color(body.accent), 0.4),
        transparent: true,
        opacity: 0.2,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });

      const line = new LineLoop(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = -1;

      out.push({
        id: body.id,
        line,
        material,
        truePositions,
        compressedPositions,
        geometry,
      });
    }

    return out;
  }, [scratch]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const e of entries) group.add(e.line);
    return () => {
      for (const e of entries) {
        group.remove(e.line);
        e.geometry.dispose();
        e.material.dispose();
      }
    };
  }, [entries]);

  // Orbit paths are static in absolute space, so the only per-frame work is
  // rebasing them against the floating origin and applying the morph. Both are
  // linear, so they collapse into one pass over the buffer.
  const lastMorph = useRef(-1);
  const lastOrigin = useRef([NaN, NaN, NaN]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    // Ease the focused body's orbit up and the rest down: a soft trail
    // highlight instead of nine identical lines.
    const focused = uiState().focusedBody;
    for (const e of entries) {
      const target = e.id === focused ? 0.62 : 0.2;
      const m = e.material;
      if (Math.abs(m.opacity - target) > 0.003)
        m.opacity += (target - m.opacity) * 0.12;
    }

    const visible = uiState().overlays.orbits;
    group.visible = visible;
    if (!visible) return;

    const morph = getOrbitMorph();
    const ox = floatingOrigin.origin[0];
    const oy = floatingOrigin.origin[1];
    const oz = floatingOrigin.origin[2];

    // Skip the rewrite when nothing that affects the buffer changed. During a
    // static view this makes the whole overlay free.
    if (
      morph === lastMorph.current &&
      ox === lastOrigin.current[0] &&
      oy === lastOrigin.current[1] &&
      oz === lastOrigin.current[2]
    ) {
      return;
    }
    lastMorph.current = morph;
    lastOrigin.current[0] = ox;
    lastOrigin.current[1] = oy;
    lastOrigin.current[2] = oz;

    for (const e of entries) {
      const attr = e.geometry.attributes.position;
      const dst = attr.array as Float32Array;
      const a = e.compressedPositions;
      const b = e.truePositions;
      for (let i = 0; i < dst.length; i += 3) {
        dst[i] = a[i] + (b[i] - a[i]) * morph - ox;
        dst[i + 1] = a[i + 1] + (b[i + 1] - a[i + 1]) * morph - oy;
        dst[i + 2] = a[i + 2] + (b[i + 2] - a[i + 2]) * morph - oz;
      }
      attr.needsUpdate = true;
    }
  }, -1);

  return <group ref={groupRef} />;
}
