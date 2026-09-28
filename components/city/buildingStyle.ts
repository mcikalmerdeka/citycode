/**
 * Building style vocabulary — the pure look of the Small World storybook
 * town: shape variants, roof kinds, facade/roof palettes and the procedural
 * window shader. No React here; Buildings.tsx owns instancing + interaction.
 *
 * Every choice is a deterministic function of the fileId hash, so a repo
 * always renders the same town.
 */

import * as THREE from "three";

import type { Building } from "@/lib/city/layout";
import { BUILDING_COLORS } from "@/lib/city/theme";

/** Scene environment uniforms consumed by the window/wall shader. */
export interface EnvParams {
  night: number;
  dusk: number;
  lightsOn: number;
  rain: number;
  cloud: number;
  wind: number;
  wet: number;
}

/** Stable 32-bit hash — the only "randomness" source for style picking. */
export function hashCode(value: string): number {
  let hash = 7;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** 0 cottage · 1 townhouse (shop plinth) · 2 apartment tower (flat roof). */
export type Variant = 0 | 1 | 2;

/** Height tier first so the skyline reads; hash tie-breaks for variety. */
export function variantFor(building: Building): Variant {
  const hash = hashCode(building.fileId);
  if (building.h < 5) return hash % 4 === 0 ? 1 : 0;
  if (building.h < 13) return hash % 5 === 0 ? 2 : 1;
  return hash % 5 === 0 ? 1 : 2;
}

export type RoofKind = "gable" | "hip" | "flat";

/** Towers get flat roofs with rooftop kit; houses split gable/hip by hash. */
export function roofKindFor(building: Building): RoofKind {
  if (variantFor(building) === 2) return "flat";
  return (hashCode(building.fileId) >>> 4) % 3 === 0 ? "hip" : "gable";
}

/**
 * Normalized wall geometries: footprint 1×1 centered, base y=0, height 1 —
 * instance scale [w, h, d] maps them onto the layout.
 */
export function buildVariantGeometries(): [
  THREE.BufferGeometry,
  THREE.BufferGeometry,
  THREE.BufferGeometry,
] {
  const box = (): THREE.BufferGeometry => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  return [box(), box(), box()];
}

/** Gable prism: unit footprint, base y=0, apex y=1, ridge along local X. */
export function buildGableGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.translate(0, 0, -0.5);
  return geometry;
}

/** Hip roof: a 4-sided pyramid whose base is the unit square, apex y=1. */
export function buildHipGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  geometry.rotateY(Math.PI / 4);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Base-anchored unit box (flat roof caps, solar panels, plinths). */
export function buildSlabGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

/** Facade color: storybook mix for houses, light concrete for towers. */
export function wallColorFor(building: Building): string {
  const hash = hashCode(building.fileId);
  const base =
    variantFor(building) === 2 && hash % 3 !== 0
      ? BUILDING_COLORS.towerWall
      : BUILDING_COLORS.facadeTones[hash % BUILDING_COLORS.facadeTones.length];
  const jitter = ((hash >>> 8) % 7) - 3;
  const color = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + jitter * 0.012, 0, 1));
  return `#${color.getHexString()}`;
}

/** Roof color: pitched roofs pick from the reference mix; flat caps are grey. */
export function roofColorFor(building: Building): string {
  if (roofKindFor(building) === "flat") return BUILDING_COLORS.towerRoof;
  const tones = BUILDING_COLORS.roofTones;
  return tones[(hashCode(building.fileId) >>> 2) % tones.length];
}

/** Pitch multiplier 0.9–1.5 — steep storybook roofs, varied per house. */
function roofPitchFor(fileId: string): number {
  return 0.9 + (((hashCode(fileId) >>> 3) % 5) / 5) * 0.6;
}

/** Roof rise (world units) above the wall top. Flat caps are a thin parapet. */
export function roofRiseFor(building: Building): number {
  if (roofKindFor(building) === "flat") return 0.45;
  const base = roofKindFor(building) === "hip" ? 0.3 : 0.34;
  return Math.min(building.w, building.d) * base * roofPitchFor(building.fileId);
}

/** Eave overhang so roofs read as a separate volume from the walls. */
export const ROOF_OVERHANG = 1.08;
/** Parapet cap overhang on flat-roofed towers. */
export const CAP_OVERHANG = 1.03;

/**
 * Procedural windows + environment response, injected into the shared wall
 * material via onBeforeCompile. Regular storybook rows of dark glass with a
 * white frame on every vertical face, a ground plinth band, and a thin
 * cornice line near the wall top. At dusk/night a share of panes glow warm.
 */
export function injectWindows(
  shader: THREE.WebGLProgramParametersWithUniforms,
  env: EnvParams,
): void {
  shader.uniforms.cityNight = { value: env.night };
  shader.uniforms.cityDusk = { value: env.dusk };
  shader.uniforms.cityLightsOn = { value: env.lightsOn };
  shader.uniforms.cityRain = { value: env.rain };
  shader.uniforms.cityCloud = { value: env.cloud };
  shader.uniforms.cityWet = { value: env.wet };

  const glass = new THREE.Color(BUILDING_COLORS.windowGlass);
  const frame = new THREE.Color(BUILDING_COLORS.windowFrame);
  const vec3 = (c: THREE.Color): string =>
    `vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)})`;

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
       varying vec3 vCityWorldPos;
       varying vec3 vCityWorldNormal;
       varying float vCityTop;`,
    )
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
       vec4 cityWP = vec4(transformed, 1.0);
       vec3 cityN = objectNormal;
       vCityTop = 1.0;
       #ifdef USE_INSTANCING
         cityWP = instanceMatrix * cityWP;
         cityN = mat3(instanceMatrix) * cityN;
         vCityTop = (instanceMatrix * vec4(0.0, 1.0, 0.0, 1.0)).y;
       #endif
       vCityWorldPos = (modelMatrix * cityWP).xyz;
       vCityWorldNormal = normalize(mat3(modelMatrix) * cityN);`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       varying vec3 vCityWorldPos;
       varying vec3 vCityWorldNormal;
       varying float vCityTop;
       uniform float cityNight;
       uniform float cityDusk;
       uniform float cityLightsOn;
       uniform float cityRain;
       uniform float cityCloud;
       uniform float cityWet;`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       {
         vec3 cityNrm = normalize(vCityWorldNormal);
         if (abs(cityNrm.y) < 0.55) {
           float cityU = abs(cityNrm.x) > abs(cityNrm.z) ? vCityWorldPos.z : vCityWorldPos.x;
           float cityV = vCityWorldPos.y;
           float fromTop = vCityTop - cityV;
           float pu = fract(cityU / 2.3);
           float pv = fract((cityV - 0.35) / 2.7);
           float frameM = step(0.26, pu) * step(pu, 0.74) * step(0.22, pv) * step(pv, 0.80);
           float glassM = step(0.33, pu) * step(pu, 0.67) * step(0.29, pv) * step(pv, 0.73);
           // Mullion: splits each pane into two sashes.
           glassM *= 1.0 - step(0.485, pu) * step(pu, 0.515);
           float cellId = floor(cityU / 2.3) * 131.0 + floor((cityV - 0.35) / 2.7) * 57.0;
           float rnd = fract(sin(cellId * 12.9898) * 43758.5453);
           // No windows in the plinth band or squeezed under the eaves.
           float allowed = step(0.9, cityV) * step(0.55, fromTop) * step(0.08, rnd);
           frameM *= allowed;
           glassM *= allowed;
           diffuseColor.rgb = mix(diffuseColor.rgb, ${vec3(frame)}, (frameM - glassM) * 0.9);
           diffuseColor.rgb = mix(diffuseColor.rgb, ${vec3(glass)}, glassM * 0.88);
           // Upper glass catches a little sky.
           diffuseColor.rgb += glassM * smoothstep(0.45, 0.73, pv) * vec3(0.06, 0.07, 0.09);
           // Plinth: slightly darker ground-floor band; cornice: pale line.
           diffuseColor.rgb *= 1.0 - 0.10 * (1.0 - step(0.6, cityV));
           float cornice = step(0.18, fromTop) * step(fromTop, 0.38);
           diffuseColor.rgb = mix(diffuseColor.rgb, ${vec3(frame)}, cornice * 0.55);
           float evening = max(cityDusk, max(cityNight, cityLightsOn));
           float lit = step(mix(0.9, 0.4, evening), rnd);
           float glow = glassM * lit * (0.35 + 0.65 * fract(rnd * 9.17));
           totalEmissiveRadiance += vec3(1.0, 0.82, 0.5) * glow * evening * 1.1;
         } else {
           diffuseColor.rgb *= 0.9;
         }
         diffuseColor.rgb *= 1.0 - 0.10 * max(cityRain, cityCloud);
         float cityLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(cityLuma), cityWet * 0.35);
         diffuseColor.rgb *= 1.0 - 0.12 * cityWet;
       }`,
    );
}
