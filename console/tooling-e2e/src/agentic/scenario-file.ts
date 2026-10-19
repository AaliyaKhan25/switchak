import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ScenarioHeader } from '../core/scenario.ts';

/**
 * An agentic scenario, as written in `agentic/<id>.yaml`.
 *
 * It says who the human is and what they want, how the conversation opens,
 * and what a good conversation looks like. A model plays the human from it
 * (the driver), the agent under test answers in a real session, and another
 * model grades the transcript against the rubric (the judge). Adding a
 * scenario is adding a file: no code.
 *
 *     id: summarise-the-channel        # kebab-case, the file's own name
 *     owner: platform                  # a team or role, never a person
 *     covers: [read_context]           # as any scenario header
 *     persona: |                       # who the driver plays
 *     goal: |                          # what they want; the driver stops once they have it
 *     setup_messages: [...]            # posted, unaddressed, before the opening (optional)
 *     opening: "…"                     # the first message, sent as written, addressed to the agent
 *     max_turns: 3                     # human messages, the opening included
 *     rubric:                          # what the judge checks, each on its own
 *       - id: cites-the-decision
 *         criterion: The summary names the decision the team reached.
 */
export interface AgenticScenario {
  header: ScenarioHeader;
  persona: string;
  goal: string;
  setupMessages: string[];
  opening: string;
  maxTurns: number;
  rubric: { id: string; criterion: string }[];
}

/** Where the scenario files live: `console/tooling-e2e/agentic/`. */
export const AGENTIC_SCENARIO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agentic'
);

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEYS = new Set([
  'id',
  'owner',
  'covers',
  'persona',
  'goal',
  'setup_messages',
  'opening',
  'max_turns',
  'rubric',
]);

/** Every scenario file, validated. A malformed one throws naming every problem in it. */
export function loadAgenticScenarios(dir: string): AgenticScenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => parseScenario(file, readFileSync(path.join(dir, file), 'utf8')));
}

export function parseScenario(file: string, raw: string): AgenticScenario {
  const value: unknown = parse(raw);
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file}: not a mapping of scenario fields`);
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!KEYS.has(key)) problems.push(`unknown field '${key}'`);
  }
  const text = (key: string): string => {
    const field = doc[key];
    if (typeof field !== 'string' || field.trim() === '') {
      problems.push(`'${key}' must be non-empty text`);
      return '';
    }
    return field.trim();
  };
  const texts = (key: string, required: boolean): string[] => {
    const field = doc[key];
    if (field === undefined && !required) return [];
    if (!Array.isArray(field) || !field.every((item) => typeof item === 'string' && item !== '')) {
      problems.push(`'${key}' must be a list of non-empty text`);
      return [];
    }
    return field as string[];
  };

  const id = text('id');
  if (id !== '' && !ID.test(id)) problems.push(`id '${id}' is not kebab-case`);
  if (id !== '' && `${id}.yaml` !== file) problems.push(`id '${id}' does not match the file name`);
  const maxTurns = doc.max_turns;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 6) {
    problems.push(`'max_turns' must be a whole number from 1 to 6`);
  }
  const rubric: { id: string; criterion: string }[] = [];
  if (!Array.isArray(doc.rubric) || doc.rubric.length === 0) {
    problems.push(`'rubric' must list at least one criterion`);
  } else {
    for (const entry of doc.rubric as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (
        item === null ||
        typeof item.id !== 'string' ||
        !ID.test(item.id) ||
        typeof item.criterion !== 'string' ||
        item.criterion.trim() === ''
      ) {
        problems.push(`each rubric entry needs a kebab-case 'id' and a 'criterion'`);
        continue;
      }
      if (rubric.some((existing) => existing.id === item.id)) {
        problems.push(`rubric id '${item.id}' is used twice`);
      }
      rubric.push({ id: item.id, criterion: item.criterion.trim() });
    }
  }

  const scenario: AgenticScenario = {
    header: {
      id,
      covers: texts('covers', true),
      lane: 'agentic',
      environments: ['ephemeral', 'local', 'dev', 'staging'],
      owner: text('owner'),
      requires: ['mattermost', 'agentic-models'],
    },
    persona: text('persona'),
    goal: text('goal'),
    setupMessages: texts('setup_messages', false),
    opening: text('opening'),
    maxTurns: typeof maxTurns === 'number' ? maxTurns : 0,
    rubric,
  };
  if (problems.length > 0) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return scenario;
}
