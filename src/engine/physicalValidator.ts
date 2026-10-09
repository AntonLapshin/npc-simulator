// Render-prose validation + validator-library re-exports (Phase 4).
//
// The old patch-based `validateConsequence` is deleted: the render engine
// returns prose only, so there are no patches left to validate against.
// The per-turn composer is `validateRenderProse` (see
// `./validate/render.ts`); the focused validators below remain as a pure,
// unit-tested library.

export { CONTACT_RADIUS } from "./validate/movement.js";
export { OBJECT_INTERACT_RADIUS } from "./validate/objects.js";

export { suggestSimilarIds } from "./validate/textUtils.js";
export { distanceToRect } from "./validate/movement.js";
export {
  contentWords,
  extractExactQuote,
  maskReportedSpeech,
  hasOwnUtterance,
  normLower,
  questionPreserved,
  quoteContained,
  quotedSegments,
  sameStem,
  stripForCompare,
  validateExactQuote,
  validateNarrativePlaceholder,
} from "./validate/speech.js";
export {
  validateExplanationCoverage,
  validateManipulationGrounding,
  validateObjectGrounding,
} from "./validate/objects.js";
export {
  collapseDoubledPrefix,
  detectVoiceViolation,
  findSupplementObserverSubject,
  findUnknownPersonNames,
  isExplicitStayAction,
  matchObserverCoordination,
  observerNameTokens,
  perceiverIds,
  stripAttributionPrefix,
  thirdPersonFallbackText,
  validateEnterFreshness,
  validateIdentityConsistency,
  validateNarrativeActors,
  validateNarrativeMovementGrounding,
  validateNarrativePronouns,
  validateNarrativeVoice,
  validateObserverSubject,
  validateRelationshipLabel,
  validateThoughtGrounding,
} from "./validate/narrative.js";
export {
  renderRetryFeedback,
  validateRenderProse,
  type RenderFacts,
} from "./validate/render.js";
