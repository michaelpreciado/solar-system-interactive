/**
 * The scene graph.
 *
 * Mounts once. Every component here renders exactly one time -- there are no
 * props that change during animation, and no state hooks. All motion happens in
 * `SceneDriver`, which mutates the objects this file registers.
 */

import { useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BackSide,
  Color,
  Group,
  Mesh,
  Object3D,
  PlaneGeometry,
  Vector3,
  type Texture,
} from 'three';

import { BODIES, type BodyDef } from '../data/bodies';
import { AtmosphereMaterial } from '../gfx/materials/AtmosphereMaterial';
import { BodyMaterial } from '../gfx/materials/BodyMaterial';
import { CloudMaterial } from '../gfx/materials/CloudMaterial';
import { CoronaMaterial, StarMaterial } from '../gfx/materials/StarMaterial';
import {
  RingMaterial,
  SATURN_RINGS,
  buildRingGeometry,
  buildRingProfile,
} from '../gfx/materials/RingMaterial';
import { geometryForDetail } from '../gfx/geometry/icospheres';
import { BakeScheduler, getPlaceholders } from '../gfx/bakery/bakeSurface';
import { bakeStarfield } from '../gfx/bakery/bakeStars';
import { quality } from '../perf/QualityManager';
import { registerBody, type BodyHandles } from './registry';
import { OrbitLines } from './OrbitLines';
import { Overlays } from './Overlays';
import { KM_PER_UNIT } from '../sim/constants';

/** Bake priority: what the user sees first, first. */
const BAKE_PRIORITY: Record<string, number> = {
  sun: 0,
  earth: 1,
  jupiter: 2,
  saturn: 3,
  mars: 4,
  venus: 5,
  mercury: 6,
  neptune: 7,
  uranus: 8,
  luna: 9,
  io: 10,
  europa: 11,
  titan: 12,
  pluto: 13,
};

interface SceneProps {
  labelLayer: React.RefObject<HTMLDivElement>;
  onBakeProgress?: (done: number, total: number) => void;
}

export function Scene({ labelLayer, onBakeProgress }: SceneProps) {
  const { gl, scene } = useThree();

  // ---- one-time GPU setup ------------------------------------------------
  const scheduler = useMemo(() => new BakeScheduler(gl), [gl]);

  useEffect(() => {
    const settings = quality.settings;

    const stars = bakeStarfield(gl, settings.starCubeSize);
    scene.background = stars.texture;
    // Keep the sky present but well below 1.0 so it never blooms; only the Sun
    // and city lights should cross the bloom threshold.
    scene.backgroundIntensity = 0.85;

    for (const body of BODIES) {
      const size = body.hero ? settings.heroBakeSize : settings.bakeSize;
      scheduler.request(body.id, size, BAKE_PRIORITY[body.id] ?? 50);
    }

    const total = BODIES.length;
    let done = 0;
    const off = scheduler.onBaked(() => {
      done++;
      onBakeProgress?.(done, total);
    });

    return () => {
      off();
      stars.dispose();
      scheduler.dispose();
    };
  }, [gl, scene, scheduler, onBakeProgress]);

  // Drain the bake queue over the first frames rather than in one hitch.
  useEffect(() => {
    let raf = 0;
    const pump = () => {
      scheduler.step();
      if (!scheduler.complete) raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, [scheduler]);

  return (
    <>
      {/* No lights in the scene graph at all.
          Direct solar lighting is computed analytically per body in
          `BodyMaterial`, because one shared directional light cannot put the
          terminator in the right place on nine planets spread across 30 AU.
          The only fill is a trace of ambient so night sides read as dark
          rather than as a rendering failure. */}
      <ambientLight intensity={0.022} color="#5a6a8a" />

      {BODIES.map((body) => (
        <Body
          key={body.id}
          def={body}
          scheduler={scheduler}
          labelLayer={labelLayer}
        />
      ))}

      <OrbitLines />
      <Overlays />
    </>
  );
}

interface BodyProps {
  def: BodyDef;
  scheduler: BakeScheduler;
  labelLayer: React.RefObject<HTMLDivElement>;
}

function Body({ def, scheduler, labelLayer }: BodyProps) {
  const groupRef = useRef<Group>(null);
  const spinRef = useRef<Object3D>(null);
  const meshRef = useRef<Mesh>(null);
  const atmosphereRef = useRef<Mesh>(null);

  const isStar = def.archetype === 'star';

  const material = useMemo(() => {
    if (isStar) return new StarMaterial();
    return new BodyMaterial({
      terran: def.archetype === 'terran',
      banded: def.archetype === 'gasGiant' || def.archetype === 'iceGiant',
      ringShadow: def.id === 'saturn',
      detailOctaves: quality.settings.detailOctaves,
      earthMaps: def.id === 'earth',
    });
  }, [def.archetype, def.id, isStar]);

  const cloudRef = useRef<Mesh>(null);
  const cloudMaterial = useMemo(() => {
    if (def.id !== 'earth' || !(material instanceof BodyMaterial)) return null;
    const u = material.bodyUniforms;
    return new CloudMaterial({
      uSunDirObject: u.uSunDirObject,
      uSunColor: u.uSunColor,
      uSunIrradiance: u.uSunIrradiance,
      uTime: u.uTime,
    });
  }, [def.id, material]);

  // Baked Earth: lazy loaded, gated by the quality tier. The procedural bake
  // stays the instant fallback while loading and on low tiers.
  useEffect(() => {
    if (!cloudMaterial || !(material instanceof BodyMaterial)) return;
    let cancelled = false;
    const apply = (want: boolean) => {
      if (!want) {
        material.earthTarget = 0;
        return;
      }
      void import('../gfx/earth/earthTextures')
        .then((m) => m.loadEarthTextures())
        .then((t) => {
          if (cancelled) return;
          material.setEarthTextures(t);
          cloudMaterial.uniforms.uClouds.value = t.clouds;
          material.earthTarget = quality.settings.bakedEarth ? 1 : 0;
        })
        .catch(() => {
          /* keep the procedural Earth */
        });
    };
    apply(quality.settings.bakedEarth);
    const off = quality.subscribe((s) => apply(s.bakedEarth));
    return () => {
      cancelled = true;
      off();
    };
  }, [cloudMaterial, material]);

  const atmosphereMaterial = useMemo(
    () =>
      def.atmosphere
        ? new AtmosphereMaterial(
            def.atmosphere,
            quality.settings.atmosphereSteps
          )
        : null,
    [def.atmosphere]
  );

  // Placeholders are real 1x1 cube textures, never null. Assigning null to a
  // sampler makes three compile the program without it, and the later swap to
  // the baked texture then silently does nothing.
  useLayoutEffect(() => {
    const ph = getPlaceholders();
    applyTextures(material, ph.albedo, ph.surface);

    const existing = scheduler.get(def.id);
    if (existing) applyTextures(material, existing.albedo, existing.surface);

    return scheduler.onBaked((id, baked) => {
      // A null bake means that body's shader failed; it keeps the placeholder.
      if (id === def.id && baked)
        applyTextures(material, baked.albedo, baked.surface);
    });
  }, [def.id, material, scheduler]);

  // Register with the driver.
  useLayoutEffect(() => {
    const group = groupRef.current;
    const spinGroup = spinRef.current;
    if (!group || !spinGroup) return;

    const label = document.createElement('div');
    label.className = 'body-label';
    label.dataset.body = def.id;
    label.textContent = def.name;
    label.style.setProperty('--accent', def.accent);
    labelLayer.current?.appendChild(label);

    const handles: BodyHandles = {
      id: def.id,
      group,
      spinGroup,
      mesh: meshRef.current ?? undefined,
      material,
      atmosphere: atmosphereRef.current ?? undefined,
      clouds: cloudRef.current ?? undefined,
      atmosphereMaterial: atmosphereMaterial ?? undefined,
      label,
      active: true,
      screenRadius: 0,
    };

    const unregister = registerBody(handles);
    return () => {
      unregister();
      label.remove();
    };
  }, [def, material, atmosphereMaterial, cloudMaterial, labelLayer]);

  useEffect(
    () => () => {
      material.dispose();
      atmosphereMaterial?.dispose();
      cloudMaterial?.dispose();
    },
    [material, atmosphereMaterial, cloudMaterial]
  );

  // Geometry is unit-radius; the driver scales the group. That way a scale
  // morph is one `scale.setScalar` rather than a geometry rebuild.
  const geometry = useMemo(() => geometryForDetail(4), []);

  return (
    <group ref={groupRef}>
      <object3D ref={spinRef}>
        <mesh
          ref={meshRef}
          geometry={geometry}
          material={material}
          // Bodies are scaled by the group; three's frustum culling uses the
          // geometry's unit bounding sphere times the scale, which is correct.
          userData={{ bodyId: def.id }}
        />

        {cloudMaterial && (
          <mesh
            ref={cloudRef}
            geometry={geometry}
            material={cloudMaterial}
            scale={1.01}
            renderOrder={1}
            visible={false}
          />
        )}

        {def.atmosphere && atmosphereMaterial && (
          <mesh
            ref={atmosphereRef}
            geometry={geometry}
            material={atmosphereMaterial}
            scale={1 + def.atmosphere.heightFraction}
            renderOrder={2}
          />
        )}

        {def.id === 'saturn' && <SaturnRings def={def} />}
        {isStar && <Corona />}
      </object3D>
    </group>
  );
}

function applyTextures(
  material: BodyMaterial | StarMaterial,
  albedo: Texture,
  surface: Texture
): void {
  material.setTextures(albedo, surface);
}

function Corona() {
  // A unit quad in the XY plane; the vertex shader billboards it in view space.
  const geometry = useMemo(() => new PlaneGeometry(2, 2), []);
  const material = useMemo(() => new CoronaMaterial(3.4, 0.29), []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material]
  );
  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={3}
      // The billboard is sized in the shader from the parent's world scale, so
      // three's frustum test against the unit quad's bounds is meaningless.
      frustumCulled={false}
    />
  );
}

function SaturnRings({ def }: { def: BodyDef }) {
  const { geometry, material } = useMemo(() => {
    const profile = buildRingProfile(SATURN_RINGS, 7);
    // Radii are in body radii, because the parent group is already scaled by
    // the body's rendered radius.
    const inner = profile.innerKm / def.radiusKm;
    const outer = profile.outerKm / def.radiusKm;
    const geo = buildRingGeometry(
      inner,
      outer,
      quality.settings.ringSegments,
      6
    );
    const mat = new RingMaterial(profile.texture, profile.width);
    mat.uniforms.uPolarRatio.value = 1 - def.flattening;
    return { geometry: geo, material: mat, profile };
  }, [def]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material]
  );

  return <mesh geometry={geometry} material={material} renderOrder={1} />;
}

export const RING_INNER_RADII = SATURN_RINGS[0].inner / KM_PER_UNIT;
export { AdditiveBlending, BackSide, Color, Vector3 };
