import type { Turn } from './roles.ts';
import type { Fact } from './scenario-file.ts';

/**
 * The checks that decide a scenario without a model.
 *
 * A scenario's own facts say what must, or must not, appear in the agent's
 * replies. `undelivered` checks the other side of the conversation: that every
 * message the driver wrote reached the Switch room, so an agent that "ignored"
 * a message it never received is not mistaken for one that ignored it.
 */

export interface FactResult {
  id: string;
  holds: boolean;
  detail: string;
}

export function checkFacts(facts: readonly Fact[], turns: readonly Turn[]): FactResult[] {
  const replies = turns.filter((turn) => turn.from === 'agent').map((turn) => turn.text);
  return facts.map((fact) => checkFact(fact, replies));
}

function checkFact(fact: Fact, replies: readonly string[]): FactResult {
  const wanted = fact.expect === 'matches';
  const ok = (reply: string): boolean => fact.pattern.test(reply) === wanted;
  const describe = `${fact.expect === 'matches' ? 'matches' : 'does not match'} /${fact.pattern.source}/i`;
  if (replies.length === 0) {
    return { id: fact.id, holds: false, detail: 'the agent never replied' };
  }
  const which = (index: number): string => `reply ${index + 1} of ${replies.length}`;
  switch (fact.turn) {
    case 'first':
    case 'last': {
      const index = fact.turn === 'first' ? 0 : replies.length - 1;
      const holds = ok(replies[index]!);
      return {
        id: fact.id,
        holds,
        detail: `${which(index)} ${holds ? describe : `fails: ${describe}`}`,
      };
    }
    case 'any': {
      const index = replies.findIndex(ok);
      return {
        id: fact.id,
        holds: index !== -1,
        detail: index === -1 ? `no reply ${describe}` : `${which(index)} ${describe}`,
      };
    }
    case 'every': {
      const failing = replies
        .map((reply, index) => (ok(reply) ? -1 : index))
        .filter((i) => i !== -1);
      return {
        id: fact.id,
        holds: failing.length === 0,
        detail:
          failing.length === 0
            ? `every reply ${describe}`
            : `${failing.map(which).join(', ')} fail: ${describe}`,
      };
    }
  }
}

/** The human messages that are not in the room's history: written by the driver, never delivered. */
export function undelivered(turns: readonly Turn[], history: readonly string[]): string[] {
  return turns
    .filter((turn) => turn.from === 'human' || turn.from === 'channel')
    .map((turn) => turn.text)
    .filter((text) => !history.some((body) => body.includes(text)));
}
