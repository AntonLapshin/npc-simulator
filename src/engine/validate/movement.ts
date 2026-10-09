// Movement validation checks.
//
// Phase 4 (renderer architecture): movement is engine-owned and the render
// contract is prose-only — there are no movement patches left to validate.
// This module keeps the shared constants and the pure-core re-exports
// used by the engine and the narrative validators.

import { distanceToRect } from "../../core/geometry.js";

// Word-sense predicates moved to the pure core (src/core/movement.ts);
// re-exported here so existing importers keep working.
export {
  isFacingOnlyTurn,
  isInterrogativeQuestion,
  isNonLocomotionSense,
} from "../../core/movement.js";
// distanceToRect moved to the pure core (src/core/geometry.ts);
// re-exported here (and via physicalValidator) for existing importers.
export { distanceToRect };

/** Physical-contact radius: touching requires ending this close (Euclidean). */
export const CONTACT_RADIUS = 2.5;
