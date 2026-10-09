// Compatibility shim: pure pathfinding lives in `src/core/pathfinding.ts`
// now (Phase 1 renderer architecture). This path re-exports it so
// existing importers keep working.
export * from "../core/pathfinding.js";
