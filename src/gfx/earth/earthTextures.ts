/**
 * Lazy loader for the Blender-baked Earth maps (public/textures/earth).
 * Dynamically imported, so none of this ships in the initial bundle.
 */

import {
  LinearMipmapLinearFilter,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  ClampToEdgeWrapping,
  type Texture,
} from 'three';

import type { EarthTextures } from '../materials/BodyMaterial';

let pending: Promise<EarthTextures> | null = null;

function load(
  loader: TextureLoader,
  file: string,
  srgb: boolean
): Promise<Texture> {
  const url = `${import.meta.env.BASE_URL}textures/earth/${file}`;
  return loader.loadAsync(url).then((t) => {
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    return t;
  });
}

export function loadEarthTextures(): Promise<EarthTextures> {
  pending ??= (async () => {
    const l = new TextureLoader();
    const [albedo, normal, spec, night, clouds] = await Promise.all([
      load(l, 'earth_albedo.webp', true),
      load(l, 'earth_normal.webp', false),
      load(l, 'earth_spec.webp', false),
      load(l, 'earth_night.webp', false),
      load(l, 'earth_clouds.webp', false),
    ]);
    return { albedo, normal, spec, night, clouds };
  })().catch((e) => {
    pending = null; // allow a retry later
    throw e;
  });
  return pending;
}
