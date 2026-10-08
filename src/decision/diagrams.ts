// Static decision diagrams as data, plus the diagram validator.
// SELECTION_CASCADE is fully static (generic, roster-independent options);
// the judge set is built per-turn from the roster/landmarks.

import type { DecisionDiagram, LayaQuestion } from "./decisionTypes.js";
import { DecisionDiagramSchema } from "./decisionTypes.js";
import { diagramDepth } from "./utils/runnerUtils.js";

/** Caps enforced by validateDiagram. */
export const MAX_DIAGRAM_DEPTH = 4;
export const MAX_OPTIONS_PER_QUESTION = 12;

/**
 * Intent cascade: intent_kind -> addressee|destination|target_object -> manner.
 * The engine runs this, then does a separate final choice over the concrete
 * suggestion candidates plus "none fit" (candidate_fit step).
 */
export const SELECTION_CASCADE: DecisionDiagram = {
  nodes: [
    {
      id: "intent_kind",
      type: "choice",
      instructions:
        "What kind of thing does the actor do next? Pick the single most fitting intent.",
      options: ["speak", "move", "interact", "gesture", "wait"],
    },
    {
      id: "addressee",
      type: "choice",
      instructions: "Who is the speech directed at?",
      options: ["one specific person", "everyone present", "nobody in particular"],
    },
    {
      id: "destination",
      type: "choice",
      instructions: "What kind of destination does the actor move toward?",
      options: ["a specific place", "toward someone", "wander aimlessly"],
    },
    {
      id: "target_object",
      type: "choice",
      instructions: "What does the actor do with the object?",
      options: ["use", "take", "examine", "move it aside"],
    },
    {
      id: "manner",
      type: "choice",
      instructions: "In what manner is the intent carried out?",
      options: ["directly and purposefully", "casually", "hesitantly", "playfully"],
    },
  ],
  edges: [
    { from: "intent_kind", whenWinner: "speak", to: "addressee" },
    { from: "intent_kind", whenWinner: "move", to: "destination" },
    { from: "intent_kind", whenWinner: "interact", to: "target_object" },
    { from: "intent_kind", whenWinner: "gesture", to: "manner" },
    { from: "intent_kind", whenWinner: "wait", to: "manner" },
    { from: "addressee", to: "manner" },
    { from: "destination", to: "manner" },
    { from: "target_object", to: "manner" },
  ],
  terminal: "manner",
};

/** Single noul question: is this event worth an inner reaction? */
export const OBSERVER_TRIAGE_QUESTION: LayaQuestion = {
  type: "noul",
  instructions:
    "Is this event notable enough that the observer would have an inner reaction to it — surprise, concern, amusement, irritation, curiosity? Answer true only for events that genuinely register, not for routine background happenings.",
};

/** Single score question: how memorable is this event (1-5)? */
export const SALIENCE_QUESTION: LayaQuestion = {
  type: "score",
  instructions:
    "How memorable is this event for the observer on a scale from 1 (utterly forgettable background noise) to 5 (impossible to forget — shocking, deeply personal, or life-changing)?",
  levels: ["1", "2", "3", "4", "5"],
};

/**
 * Batched judge set: two noul questions (moves? speaks?) plus choice
 * questions over the roster/landmarks. Run in ONE decide() call.
 */
export function buildJudgeQuestions(
  roster: string[],
  landmarks: string[],
): Record<string, LayaQuestion> {
  const nobody = "nobody in particular";
  const nowhere = "stays put / nowhere";
  const noContact = "no physical contact";
  return {
    q_moves: {
      type: "noul",
      instructions:
        "Does this action involve the actor physically relocating — walking, running, going somewhere? Resuming a stationary activity (typing, sitting back down to work) does NOT count as moving.",
    },
    q_speaks: {
      type: "noul",
      instructions:
        "Does this action include the actor uttering words aloud or explicitly intending to speak? Thinking or gesturing silently does NOT count.",
    },
    q_addressee: {
      type: "choice",
      instructions: "Who is the actor speaking directly to?",
      options: [...roster, nobody],
    },
    q_destination: {
      type: "choice",
      instructions: "Where does the actor move to, or toward whom?",
      options: [...landmarks, ...roster, nowhere],
    },
    q_contact: {
      type: "choice",
      instructions: "Who does the actor physically touch or hand something to?",
      options: [...roster, noContact],
    },
  };
}

export type DiagramValidation =
  | { ok: true; diagram: DecisionDiagram }
  | { ok: false; errors: string[] };

/**
 * Validate a diagram: schema shape, structural integrity (unique ids,
 * terminal exists, edges reference nodes), and the safety caps —
 * depth <= 4, options <= 12 per question, options non-empty and distinct.
 */
export function validateDiagram(input: unknown): DiagramValidation {
  const errors: string[] = [];
  const parsed = DecisionDiagramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "diagram"}: ${i.message}`,
      ),
    };
  }
  const diagram = parsed.data;

  const ids = new Set<string>();
  for (const node of diagram.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (node.type === "choice") {
      if (!node.options || node.options.length === 0) {
        errors.push(`choice node "${node.id}" has no options`);
      } else {
        if (node.options.length > MAX_OPTIONS_PER_QUESTION) {
          errors.push(
            `choice node "${node.id}" has ${node.options.length} options (max ${MAX_OPTIONS_PER_QUESTION})`,
          );
        }
        const seen = new Set<string>();
        for (const opt of node.options) {
          if (seen.has(opt)) errors.push(`choice node "${node.id}" has duplicate option "${opt}"`);
          seen.add(opt);
        }
      }
    }
    if (node.type === "score" && (!node.levels || node.levels.length < 2)) {
      errors.push(`score node "${node.id}" needs at least 2 levels`);
    }
  }

  if (!ids.has(diagram.terminal)) {
    errors.push(`terminal "${diagram.terminal}" is not a node`);
  }
  for (const edge of diagram.edges) {
    if (!ids.has(edge.from)) errors.push(`edge from unknown node "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`edge to unknown node "${edge.to}"`);
  }

  const depth = diagramDepth(diagram);
  if (depth > MAX_DIAGRAM_DEPTH) {
    errors.push(`diagram depth ${depth} exceeds max ${MAX_DIAGRAM_DEPTH}`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, diagram };
}
