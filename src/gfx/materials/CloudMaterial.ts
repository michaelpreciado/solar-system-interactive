/**
 * Earth's cloud shell: a thin sphere just above the surface carrying the
 * Blender-baked cloud density map. Lit analytically from the same object-space
 * Sun uniform as the surface (the uniform objects are shared with the body's
 * `BodyMaterial`, so the driver updates both with no extra work).
 */

import {
  Color,
  ShaderMaterial,
  type IUniform,
  type Texture,
  Vector3,
} from 'three';

import { EARTH_GLSL } from './BodyMaterial';

const VERT = /* glsl */ `
varying vec3 vObjectDir;
void main() {
  vObjectDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uClouds;
uniform vec3 uSunDirObject;
uniform vec3 uSunColor;
uniform float uSunIrradiance;
uniform float uTime;
uniform float uOpacity;
varying vec3 vObjectDir;
${EARTH_GLSL}

void main() {
  vec3 n = normalize(vObjectDir);
  float d = earthTex(uClouds, earthCloudDir(n, uTime)).r;
  float ndl = dot(n, uSunDirObject);
  // Soft wrap lighting: thick cloud scatters light past the terminator, and
  // the terminator edge picks up a warm sunset tint.
  float lit = smoothstep(-0.12, 0.55, ndl);
  vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(1.0), smoothstep(0.0, 0.3, ndl));
  vec3 col = uSunColor * uSunIrradiance * tint * (0.006 + 1.05 * lit);
  // Dense cores are slightly darker underneath.
  col *= 1.0 - 0.18 * smoothstep(0.6, 1.0, d);
  float a = smoothstep(0.04, 0.85, d) * uOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class CloudMaterial extends ShaderMaterial {
  constructor(shared: {
    uSunDirObject: IUniform<Vector3>;
    uSunColor: IUniform<Color>;
    uSunIrradiance: IUniform<number>;
    uTime: IUniform<number>;
  }) {
    super({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uClouds: { value: null as Texture | null },
        uOpacity: { value: 0 },
        // Shared by reference with BodyMaterial.bodyUniforms.
        uSunDirObject: shared.uSunDirObject,
        uSunColor: shared.uSunColor,
        uSunIrradiance: shared.uSunIrradiance,
        uTime: shared.uTime,
      },
      transparent: true,
      depthWrite: false,
      // The shell hugs the surface; depth precision at solar-system scales
      // z-fights it around icosphere vertices without an offset.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
    });
  }
}
