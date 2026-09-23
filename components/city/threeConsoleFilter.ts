/**
 * Surgical console filter for one specific piece of third-party deprecation
 * noise — client-side only (imported exclusively by CityScene, which is a
 * `next/dynamic ssr:false` chunk, so this never runs on the server).
 *
 * three r183 deprecated `THREE.Clock`, and `@react-three/fiber` 9.x still
 * constructs one internally on every Canvas mount
 * (pmndrs/react-three-fiber#3741), so every page load prints:
 *
 *   THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.
 *
 * R3F 9.8 added `state.timer` but kept the internal Clock; only fiber v10
 * removes it (see its v10-migration.md). Until then, this module uses
 * three's OWN console hook (`setConsoleFunction` — a supported interception
 * point, not a console monkey-patch) to drop exactly that message and pass
 * every other three.js log/warn/error through untouched.
 *
 * REMOVAL CONDITION: delete this module and its `installThreeConsoleFilter()`
 * call in CityScene.tsx once @react-three/fiber v10 stable ships and we
 * upgrade — the warning's source disappears there.
 */

import { setConsoleFunction } from "three";

/**
 * Prefix of the exact R3F-internal message to drop. Prefix matching (not
 * equality) because three may append deprecation context after the message.
 * Nothing else is filtered — a broad filter here would hide real issues.
 */
const SUPPRESSED_PREFIX = "THREE.Clock: This module has been deprecated";

/** Install the filter. Idempotent: the last call wins inside three's hook. */
export function installThreeConsoleFilter(): void {
  if (typeof window === "undefined") {
    return; // client-side only — never touch the server's console
  }
  setConsoleFunction((type, message, ...params) => {
    if (typeof message === "string" && message.startsWith(SUPPRESSED_PREFIX)) {
      return;
    }
    console[type](message, ...params);
  });
}
