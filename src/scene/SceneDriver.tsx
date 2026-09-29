/**
 * The driver: the only `useFrame` in the application.
 *
 * Everything that moves is mutated here, imperatively. React mounts the scene
 * once and is then completely out of the animation path -- no state writes, no
 * reconciliation, no allocation. That invariant is the reason this can hold a
 * 120 Hz budget at all, and `src/test/driver.test.ts` asserts it.
 *
 * Order matters: clock -> world -> origin -> transforms -> camera -> uniforms
 * -> labels. Camera must run after transforms so a followed body is already at
 * its new position, and labels must run after the camera so projection uses the
 * final view matrix.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Matrix4, Vector3, type PerspectiveCamera } from 'three';

import { BODIES, BODY_BY_ID } from '../data/bodies';
import { quality } from '../perf/QualityManager';
import { simClock } from '../sim/SimClock';
import type { DriverHandle } from './driverHandle';
import { floatingOrigin } from '../sim/floatingOrigin';
import {
  absPos,
  bodyIndex,
  distanceAU,
  obliquityRad,
  radii,
  spin,
  stepWorld,
} from '../sim/world';
import { AU, KM_PER_UNIT, TAU, lightTimeSeconds } from '../sim/constants';
import { uiState, useUIStore } from '../state/uiStore';
import {
  formatClock,
  formatDate,
  formatDistanceKm,
  formatLightTime,
  formatSpeed,
  publishTelemetry,
} from '../state/telemetry';
import { allBodies, type BodyHandles } from './registry';
import { setOrbitMorph } from './orbitMorph';
import { geometryForDetail } from '../gfx/geometry/icospheres';
import { attachFreeFlightInput, readThrust } from '../camera/freeFlightInput';

const TELEMETRY_INTERVAL = 0.1;

/** Scratch vectors, allocated once. Nothing in the loop may allocate. */
const sunScene = new Vector3();
const tmpA = new Vector3();
const tmpB = new Vector3();
const invMatrix = new Matrix4();

interface SceneDriverProps {
  handle: DriverHandle;
  labelLayer: React.RefObject<HTMLDivElement>;
  onReady?: () => void;
}

export function SceneDriver({ handle, labelLayer, onReady }: SceneDriverProps) {
  const { camera, gl, size } = useThree();
  const telemetryAccumulator = useRef(0);
  const lastFrameTime = useRef(performance.now());
  const readyFired = useRef(false);
  const introPending = useRef(false);

  const { rig, scaleMorph } = handle;

  // Subscribe to discrete UI changes outside React's render path, so a store
  // write never triggers a re-render of anything in the 3D tree.
  useEffect(() => {
    const unsubScale = useUIStore.subscribe(
      (s) => s.scaleTarget,
      (t) => {
        scaleMorph.target = t;
        if (uiState().reducedMotion) scaleMorph.snap(t);
      }
    );
    const unsubMotion = useUIStore.subscribe(
      (s) => s.reducedMotion,
      (reduced) => {
        rig.instant = reduced;
      }
    );
    // The fly-to. Selecting a body has to move the camera *to* it, not merely
    // re-aim at it -- otherwise picking Earth from a system-wide view leaves you
    // 86,000 km out, staring at a 30-pixel dot.
    const unsubFocus = useUIStore.subscribe(
      (s) => s.focusedBody,
      (id) => {
        const i = bodyIndex[id];
        if (i === undefined) return;
        const radius = radii[i] || 1;

        // Frame the body with a little headroom. Saturn needs more, or the
        // camera arrives inside the ring system.
        const framing = id === 'saturn' ? 5.4 : 3.6;

        // Adopt the new body's minimum approach *before* flying, because
        // `flyTo` clamps against it. Leaving the previous body's value in place
        // means flying from the Sun (radius 28) to Earth (radius 2.6) clamps the
        // requested 9.4 units up to 29 -- you arrive, but far too far out, and
        // only for bodies smaller than the one you left.
        rig.minDistance = radius * 1.04;

        rig.flyTo(
          absPos[i * 3] - floatingOrigin.origin[0],
          absPos[i * 3 + 1] - floatingOrigin.origin[1],
          absPos[i * 3 + 2] - floatingOrigin.origin[2],
          radius * framing,
          {
            // Come in slightly above the ecliptic so orbits and rings read as
            // discs rather than as edge-on lines.
            polar: 1.15,
            duration: uiState().reducedMotion ? 0 : 2.4,
          }
        );
      }
    );

    rig.instant = uiState().reducedMotion;
    scaleMorph.snap(uiState().scaleTarget);

    // Open on a system-wide view rather than tight on the Sun, so the first
    // thing anyone sees is the whole thing turning.
    // First visit only: start high and far, and glide in once the scene is
    // revealed (see the ready branch below). Reduced motion skips it.
    if (!uiState().introComplete && !uiState().reducedMotion) {
      introPending.current = true;
      rig.distance.snap(1500);
      rig.polar.snap(0.38);
      rig.azimuth.snap(rig.azimuth.value - 1.1);
    } else {
      rig.distance.snap(430);
      rig.polar.snap(1.02);
    }

    return () => {
      unsubScale();
      unsubMotion();
      unsubFocus();
    };
  }, [rig, scaleMorph]);

  useEffect(() => attachFreeFlightInput(), []);

  // `renderer.info` resets on every `render()`. We only render once per frame
  // today, but the bake passes also call render, so autoReset would zero the
  // counters we want to report. Own the reset explicitly.
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame((_, rawDelta) => {
    const perspective = camera as PerspectiveCamera;

    // A backgrounded tab hands back a multi-second delta on return. Clamping
    // stops the simulation from teleporting and the springs from exploding.
    const dt = Math.min(rawDelta, 1 / 15);

    const frameStart = performance.now();
    quality.sample(frameStart - lastFrameTime.current);
    lastFrameTime.current = frameStart;

    // ---- simulation ------------------------------------------------------
    simClock.advance(dt);
    const morph = scaleMorph.step(dt);
    setOrbitMorph(morph);
    stepWorld(simClock.jd, morph);

    const state = uiState();
    const focusIdx = bodyIndex[state.focusedBody] ?? 0;
    const focusDef = BODY_BY_ID[state.focusedBody] ?? BODIES[0];

    // ---- floating origin -------------------------------------------------
    // Keep the origin on the focused body. Everything the camera can get close
    // to is then within a few thousand units of zero, and float32 has precision
    // to spare even at Neptune's 4.5e6-unit distance from the Sun.
    floatingOrigin.moveTo(
      absPos[focusIdx * 3],
      absPos[focusIdx * 3 + 1],
      absPos[focusIdx * 3 + 2]
    );

    sunScene.set(
      -floatingOrigin.origin[0],
      -floatingOrigin.origin[1],
      -floatingOrigin.origin[2]
    );

    // ---- transforms ------------------------------------------------------
    const settings = quality.settings;
    const viewportHeight = size.height;
    const tanHalfFov = Math.tan(((perspective.fov ?? 60) * Math.PI) / 360);

    for (const h of allBodies()) {
      const i = bodyIndex[h.id];
      if (i === undefined) continue;
      const o = i * 3;

      h.group.position.set(
        absPos[o] - floatingOrigin.origin[0],
        absPos[o + 1] - floatingOrigin.origin[1],
        absPos[o + 2] - floatingOrigin.origin[2]
      );

      const radius = radii[i];
      h.group.scale.setScalar(radius);

      // Axial tilt on Z, spin on Y. Applying them in that order means the tilt
      // stays fixed in the ecliptic frame while the body turns beneath it,
      // which is what produces seasons rather than a wobble.
      h.spinGroup.rotation.set(0, spin[i], obliquityRad[i], 'ZYX');

      // Screen-space radius drives LOD, label visibility and culling.
      tmpA.copy(h.group.position).sub(perspective.position);
      const dist = tmpA.length();
      const px =
        dist > 0 ? (radius / dist) * (viewportHeight / (2 * tanHalfFov)) : 1e9;
      h.screenRadius = px;

      const visible = px > 0.35;
      h.group.visible = visible;
      h.active = visible;
      if (!visible) continue;

      if (h.mesh) {
        const detail =
          px > 700
            ? settings.maxGeometryDetail
            : px > 180
              ? Math.min(5, settings.maxGeometryDetail)
              : px > 40
                ? Math.min(4, settings.maxGeometryDetail)
                : 3;
        const geo = geometryForDetail(detail);
        if (h.mesh.geometry !== geo) h.mesh.geometry = geo;
      }
    }

    // ---- camera ----------------------------------------------------------
    const focusRadius = radii[focusIdx] || 1;
    rig.minDistance = focusRadius * 1.04;
    rig.maxDistance = 6e6;

    // The phone HUD stacks along the bottom edge, so a subject centred in the
    // canvas sits behind it. Lift it into the clear area -- half the height the
    // stack occupies, which recentres the subject in what is left.
    rig.screenBias = size.width <= 860 ? 0.11 : 0;
    rig.setTarget(
      absPos[focusIdx * 3] - floatingOrigin.origin[0],
      absPos[focusIdx * 3 + 1] - floatingOrigin.origin[1],
      absPos[focusIdx * 3 + 2] - floatingOrigin.origin[2]
    );

    // Transition through enterFree/exitFree rather than assigning `mode`
    // directly. Those seed the free-flight position and orientation from where
    // the camera actually is; without them, entering free flight teleports you
    // to the scene origin looking down -Z, because `freePosition` is still its
    // initial zero.
    const wantsFree = state.cameraMode === 'free';
    if (wantsFree && rig.mode !== 'free') rig.enterFree(perspective);
    else if (!wantsFree && rig.mode === 'free') rig.exitFree(perspective);

    if (rig.mode === 'free') {
      const thrust = readThrust();
      if (thrust.right || thrust.up || thrust.forward) {
        // Scale speed to how far the camera actually is from what it is
        // looking at, so the same keypress is a gentle nudge beside a moon and
        // a real move at system scale. This has to be measured from the camera
        // rather than read from `rig.currentDistance`: that is the orbit
        // spring, which free mode never steps, so it would stay frozen at
        // whatever it held on entry and flying outward would slow to a crawl.
        tmpA.copy(perspective.position).sub(rig.target.asVector(tmpB));
        const range = tmpA.length();
        const speed =
          Math.max(focusRadius * 6, range * 1.2) * (thrust.boost ? 4 : 1);
        rig.thrust(thrust.right, thrust.up, thrust.forward, dt, speed);
      }
    }

    rig.update(dt, perspective);

    // ---- shader uniforms -------------------------------------------------
    for (const h of allBodies()) {
      if (!h.active) continue;
      h.group.updateMatrixWorld(true);

      const mat = h.material;
      if (!mat) continue;

      if ('bodyUniforms' in mat) {
        const u = mat.bodyUniforms;
        u.uTime.value = simClock.elapsed;

        // Sun direction in the mesh's object space. Doing the transform here
        // rather than in the shader means the fragment stage gets a constant.
        if (h.mesh) {
          invMatrix.copy(h.mesh.matrixWorld).invert();
          tmpB.copy(sunScene).applyMatrix4(invMatrix).normalize();
          (u.uSunDirObject.value as Vector3).copy(tmpB);
        }

        // Differential rotation for banded atmospheres.
        u.uBandScroll.value = (simClock.jd * 0.06) % TAU;

        // Detail octaves blend in only when a body fills a good part of the
        // screen, so the expensive path never runs during a system-wide view.
        const blend = smoothstep(120, 600, h.screenRadius);
        u.uDetailBlend.value = settings.detailOctaves > 0 ? blend : 0;

        // The Sun's angular radius as seen from here, which sets the physical
        // softness of the terminator.
        const au = distanceAU[bodyIndex[h.id]];
        const d = au * AU;
        u.uSunAngularRadius.value = d > 0 ? Math.min(0.3, 696 / d) : 0.00465;

        // Irradiance. True inverse-square would put Neptune at 1/900 of
        // Earth's light, which is honest and unwatchable. A softer exponent
        // with a floor still reads as "much dimmer out here" while keeping the
        // outer planets legible.
        u.uSunIrradiance.value =
          au > 0.01 ? Math.min(2.2, Math.max(0.45, Math.pow(1 / au, 0.55))) : 1;
      } else {
        // Star material.
        (
          mat as { uniforms: Record<string, { value: number }> }
        ).uniforms.uTime.value = simClock.elapsed;
      }

      if (h.atmosphere) {
        h.atmosphere.visible = state.overlays.atmospheres;
      }
      if (h.atmosphereMaterial && h.mesh && state.overlays.atmospheres) {
        invMatrix.copy(h.mesh.matrixWorld).invert();
        tmpB.copy(sunScene).applyMatrix4(invMatrix).normalize();
        (h.atmosphereMaterial.uniforms.uSunDirObject.value as Vector3).copy(
          tmpB
        );
      }
    }

    // ---- labels ----------------------------------------------------------
    projectLabels(perspective, size.width, size.height, labelLayer.current);

    // ---- telemetry -------------------------------------------------------
    telemetryAccumulator.current += dt;
    if (telemetryAccumulator.current >= TELEMETRY_INTERVAL) {
      telemetryAccumulator.current = 0;
      publishFrameTelemetry(
        focusIdx,
        focusDef.name,
        rig.currentDistance,
        focusRadius,
        gl
      );
    }

    if (!readyFired.current) {
      readyFired.current = true;
      if (introPending.current) {
        introPending.current = false;
        rig.distance.setHalfLife(1.15);
        rig.polar.setHalfLife(1.0);
        rig.azimuth.setHalfLife(1.0);
        rig.distance.target = 430;
        rig.polar.target = 1.02;
        rig.azimuth.target = rig.azimuth.value + 1.1;
        useUIStore.getState().completeIntro();
      }
      onReady?.();
    }
  }, 0);

  return null;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const labelPos = new Vector3();
const rayDir = new Vector3();
const toTarget = new Vector3();

/**
 * Is `target` hidden behind another body from the camera's point of view?
 *
 * An analytic ray/sphere test against the handful of active bodies. Without it,
 * every inner planet's label floats on top of the Sun whenever it passes behind
 * it -- which, viewed from outside the system, is half the time.
 */
function isOccluded(camera: PerspectiveCamera, target: BodyHandles): boolean {
  toTarget.copy(target.group.position).sub(camera.position);
  const targetDistance = toTarget.length();
  if (targetDistance < 1e-6) return false;
  rayDir.copy(toTarget).divideScalar(targetDistance);

  for (const other of allBodies()) {
    if (other === target || !other.active) continue;
    const radius = other.group.scale.x;
    // Only bodies large enough to matter, and only ones in front of the target.
    if (radius <= 0) continue;

    toTarget.copy(other.group.position).sub(camera.position);
    const along = toTarget.dot(rayDir);
    if (along <= 0 || along >= targetDistance) continue;

    const perpSq = toTarget.lengthSq() - along * along;
    if (perpSq < radius * radius) return true;
  }
  return false;
}

function projectLabels(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  layer: HTMLDivElement | null
): void {
  if (!layer) return;
  const showLabels = uiState().overlays.labels;
  const halfW = width * 0.5;
  const halfH = height * 0.5;

  for (const h of allBodies()) {
    const el = h.label;
    if (!el) continue;

    if (!showLabels || !h.active) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      continue;
    }

    if (isOccluded(camera, h)) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      continue;
    }

    labelPos.copy(h.group.position).project(camera);

    // Behind the camera, or off screen.
    if (
      labelPos.z > 1 ||
      labelPos.x < -1.3 ||
      labelPos.x > 1.3 ||
      labelPos.y < -1.3 ||
      labelPos.y > 1.3
    ) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      continue;
    }

    const x = labelPos.x * halfW + halfW;
    const y = -labelPos.y * halfH + halfH;
    const offset = Math.min(h.screenRadius + 14, 90);

    // transform and opacity only: both are compositor properties, so this
    // never triggers layout or paint.
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - offset).toFixed(1)}px, 0) translateX(-50%)`;
    // Fade out when the body is huge (you know what you're looking at) and
    // when it is tiny (the label would be noise).
    const fade =
      smoothstep(0.8, 3, h.screenRadius) *
      (1 - smoothstep(400, 900, h.screenRadius) * 0.85);
    el.style.opacity = fade.toFixed(3);
  }
}

function publishFrameTelemetry(
  focusIdx: number,
  focusName: string,
  cameraDistance: number,
  focusRadius: number,
  gl: { info: { render: { calls: number; triangles: number }; reset(): void } }
): void {
  const date = simClock.date;
  const sunDistUnits = distanceAU[focusIdx] * AU;
  const altitude = Math.max(0, cameraDistance - focusRadius);

  publishTelemetry({
    date: formatDate(date),
    time: formatClock(date),
    speed: simClock.playing ? formatSpeed(simClock.daysPerSecond) : 'Paused',
    focusName,
    focusDistance: formatDistanceKm(cameraDistance * KM_PER_UNIT),
    focusAltitude: formatDistanceKm(altitude * KM_PER_UNIT),
    sunDistance:
      sunDistUnits > 0 ? formatDistanceKm(sunDistUnits * KM_PER_UNIT) : '--',
    lightTime:
      sunDistUnits > 0 ? formatLightTime(lightTimeSeconds(sunDistUnits)) : '--',
    fps: quality.stats.fps > 0 ? quality.stats.fps.toFixed(0) : '--',
    frameMs:
      quality.stats.p95 > 0 ? `${quality.stats.p95.toFixed(1)} ms` : '--',
    drawCalls: String(gl.info.render.calls),
    triangles: gl.info.render.triangles.toLocaleString(),
    tier: quality.tierName,
    accuracy: simClock.isExtrapolated ? 'Extrapolated' : 'Accurate',
  });

  gl.info.reset();
}
