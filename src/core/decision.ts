// Pure decision-layer helpers (Phase 5 of the renderer architecture).
//
// Everything here is deterministic and side-effect free: dynamic question
// construction from the live roster/scene (Anton's standing goal — the
// cascade's question sets are built from the world, not hardcoded),
// target-id resolution, intent → candidate-action rendering, and
// probability ranking. The Laya proposal/selection engines are thin
// orchestration over these.

import type { Actor, World } from "../types.js";
import type { Intent, LayaQuestion } from "../decision/decisionTypes.js";

/** Max options on any dynamically built choice question (diagram cap). */
export const MAX_TARGET_OPTIONS = 12;

/** Radius (cells) within which objects count as interaction candidates. */
export const INTERACT_CANDIDATE_RADIUS = 6;

function findActor(world: World, actorId: string): Actor | undefined {
  return world.actors.find((a) => a.id === actorId);
}

function actorName(world: World, actorId: string): string {
  return findActor(world, actorId)?.name ?? actorId;
}

/** Roster names visible to the cascade (everyone but the acting actor). */
export function rosterNames(world: World, actorId: string): string[] {
  return world.actors
    .filter((a) => a.id !== actorId)
    .map((a) => a.name)
    .filter((n) => n.trim().length > 0);
}

/** Named scene objects, nearest-first from the acting actor. */
export function nearbyObjectNames(
  world: World,
  actorId: string,
  radius: number = INTERACT_CANDIDATE_RADIUS,
): string[] {
  const actor = findActor(world, actorId);
  if (!actor) return [];
  return world.scene.objects
    .filter((o) => o.name.trim().length > 0)
    .map((o) => ({
      name: o.name,
      d: Math.hypot(actor.x - (o.x + o.w / 2), actor.y - (o.y + o.h / 2)),
    }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_TARGET_OPTIONS)
    .map(({ name }) => name);
}

/** All named scene objects (landmarks), alphabetical, capped. */
export function landmarkNames(world: World): string[] {
  const names = world.scene.objects
    .map((o) => o.name)
    .filter((n) => n.trim().length > 0);
  return [...new Set(names)].sort().slice(0, MAX_TARGET_OPTIONS);
}

// ---------------------------------------------------------------------------
// Dynamic target question
// ---------------------------------------------------------------------------

export type TargetQuestionKind = "speak" | "move" | "interact";

/**
 * Build the target-resolution choice question for a cascade intent whose
 * targetKind is known but whose targetId is not: the options are the live
 * roster / scene names, never hardcoded. Returns null when there is
 * nothing to resolve (targetKind "none"/undefined, or no candidates).
 * Pure.
 */
export function buildTargetQuestion(
  kind: TargetQuestionKind,
  targetKind: Intent["targetKind"],
  world: World,
  actorId: string,
): LayaQuestion | null {
  const name = actorName(world, actorId);
  if (targetKind === "actor") {
    const options = rosterNames(world, actorId);
    if (options.length === 0) return null;
    const instructions =
      kind === "speak"
        ? `Who does ${name} speak to?`
        : `Who does ${name} move toward?`;
    return { type: "choice", instructions, options };
  }
  if (targetKind === "landmark") {
    const options = landmarkNames(world);
    if (options.length === 0) return null;
    return {
      type: "choice",
      instructions: `Where does ${name} go?`,
      options,
    };
  }
  if (targetKind === "object") {
    const options = nearbyObjectNames(world, actorId);
    if (options.length === 0) return null;
    return {
      type: "choice",
      instructions: `What does ${name} interact with?`,
      options,
    };
  }
  return null;
}

export type ResolvedTarget = {
  id: string;
  kind: "actor" | "object";
};

/**
 * Map a target-question winner (a roster/scene name) back to its id.
 * Actors match by name (case-insensitive); objects/landmarks match by
 * name, nearest-first on ties. Undefined when nothing matches. Pure.
 */
export function resolveTargetId(
  world: World,
  actorId: string,
  targetKind: Intent["targetKind"],
  winnerName: string,
): ResolvedTarget | undefined {
  const want = winnerName.trim().toLowerCase();
  if (want.length === 0) return undefined;
  if (targetKind === "actor") {
    const hit = world.actors.find(
      (a) => a.id !== actorId && a.name.trim().toLowerCase() === want,
    );
    return hit !== undefined ? { id: hit.id, kind: "actor" } : undefined;
  }
  if (targetKind === "landmark" || targetKind === "object") {
    const actor = findActor(world, actorId);
    const hits = world.scene.objects.filter(
      (o) => o.name.trim().toLowerCase() === want,
    );
    if (hits.length === 0) return undefined;
    let best = hits[0]!;
    if (actor !== undefined && hits.length > 1) {
      let bestD = Infinity;
      for (const o of hits) {
        const d = Math.hypot(actor.x - (o.x + o.w / 2), actor.y - (o.y + o.h / 2));
        if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && o.id < best.id)) {
          best = o;
          bestD = d;
        }
      }
    }
    return { id: best.id, kind: "object" };
  }
  return undefined;
}

/**
 * Attach a resolved target to an intent (pure — returns a new intent).
 * Landmarks resolve to scene-object ids, so targetKind stays "landmark"
 * for the executor mapping while targetId carries the object id.
 */
export function attachTarget(
  intent: Intent,
  target: ResolvedTarget,
  targetKind: NonNullable<Intent["targetKind"]>,
): Intent {
  return { ...intent, targetId: target.id, targetKind };
}

// ---------------------------------------------------------------------------
// Intent → candidate actions (deterministic templates, parser-inverses)
// ---------------------------------------------------------------------------

/**
 * Render candidate action strings for a (possibly fully-typed) intent.
 * Templates are deliberately written as inverses of the deterministic
 * text parsers (`planMovementSemantics`, `planManipulation`,
 * `extractExactQuote`): the executors recover exactly the intent's
 * target from the rendered text, so the round-trip introduces no
 * ambiguity. No quotes are ever rendered — quoted speech stays
 * engine-dictated (Phase 2); unquoted speech is composed by the render
 * call. Pure.
 */
export function renderIntentCandidates(
  world: World,
  actorId: string,
  intent: Intent,
): string[] {
  const A = actorName(world, actorId);
  const targetName =
    intent.targetId !== undefined
      ? (intent.targetKind === "actor"
          ? findActor(world, intent.targetId)?.name
          : world.scene.objects.find((o) => o.id === intent.targetId)?.name) ??
        intent.targetId
      : undefined;

  switch (intent.kind) {
    case "speak": {
      if (targetName !== undefined) {
        return [
          `${A} greets ${targetName} warmly`,
          `${A} asks ${targetName} how they're doing`,
          `${A} makes small talk with ${targetName}`,
          `${A} says hello to ${targetName}`,
        ];
      }
      return [
        `${A} thinks out loud`,
        `${A} hums quietly to themselves`,
        `${A} mutters under their breath`,
      ];
    }
    case "move": {
      if (targetName !== undefined) {
        const prep = intent.targetKind === "actor" ? "" : "the ";
        return [
          `${A} walks over to ${prep}${targetName}`,
          `${A} approaches ${prep}${targetName}`,
          `${A} heads toward ${prep}${targetName}`,
        ];
      }
      return [
        `${A} wanders aimlessly`,
        `${A} strolls around the room`,
        `${A} paces thoughtfully`,
      ];
    }
    case "interact": {
      if (targetName !== undefined) {
        return [
          `${A} picks up the ${targetName}`,
          `${A} examines the ${targetName}`,
          `${A} uses the ${targetName}`,
        ];
      }
      return [`${A} looks around for something to do`];
    }
    case "gesture": {
      if (targetName !== undefined) {
        return [
          `${A} nods at ${targetName}`,
          `${A} waves at ${targetName}`,
          `${A} smiles at ${targetName}`,
        ];
      }
      return [
        `${A} nods thoughtfully`,
        `${A} stretches`,
        `${A} smiles to themselves`,
      ];
    }
    case "wait": {
      return [
        `${A} waits quietly`,
        `${A} observes the room`,
        `${A} sits back and watches`,
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Ranking + description
// ---------------------------------------------------------------------------

/**
 * Order options by descending choice probability (ties broken by option
 * order, then lexicographically — fully deterministic). Pure.
 */
export function rankOptionsByProbability(
  probabilities: Record<string, number>,
  options: string[],
): string[] {
  return [...options].sort((a, b) => {
    const pa = probabilities[a] ?? 0;
    const pb = probabilities[b] ?? 0;
    if (pb !== pa) return pb - pa;
    const ia = options.indexOf(a);
    const ib = options.indexOf(b);
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * One-line human description of an intent for reasoning strings and logs.
 * Pure.
 */
export function describeIntent(
  intent: Intent,
  world: World,
  actorId: string,
): string {
  const A = actorName(world, actorId);
  const target =
    intent.targetId !== undefined
      ? (intent.targetKind === "actor"
          ? findActor(world, intent.targetId)?.name ?? intent.targetId
          : world.scene.objects.find((o) => o.id === intent.targetId)?.name ??
            intent.targetId)
      : (intent.targetKind ?? "none");
  const manner = intent.manner ? ` (${intent.manner})` : "";
  const quote = intent.quote !== undefined ? ` quote="${intent.quote}"` : "";
  return `${A}: ${intent.kind} → ${target}${manner}${quote}`;
}
