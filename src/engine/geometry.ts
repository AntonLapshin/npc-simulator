// Compatibility shim: pure geometry lives in `src/core/geometry.ts` now
// (Phase 1 renderer architecture). This path re-exports it so existing
// importers keep working.
export * from "../core/geometry.js";
