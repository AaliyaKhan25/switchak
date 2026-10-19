import { describe, expect, it } from 'vitest';
import type { UsageTotal } from '../clients/switch-client.ts';
import { parseAnswer } from './model.ts';
import { parseVerdicts } from './roles.ts';
import { AGENTIC_SCENARIO_DIR, loadAgenticScenarios, parseScenario } from './scenario-file.ts';
import { BudgetExceededError, Ledger, priceOf, usageCostUsd } from './spend.ts';

const SCENARIO = `
id: some-scenario
owner: platform
covers: [post_message]
persona: Someone.
goal: Something.
opening: Hello?
max_turns: 2
rubric:
  - id: replies
    criterion: The agent replies.
`;

describe('agentic scenario files', () => {
  it('reads every scenario in the suite', () => {
    const scenarios = loadAgenticScenarios(AGENTIC_SCENARIO_DIR);
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((scenario) => scenario.header.lane === 'agentic')).toBe(true);
  });

  it('reads a valid file, with setup messages optional', () => {
    const scenario = parseScenario('some-scenario.yaml', SCENARIO);
    expect(scenario.setupMessages).toEqual([]);
    expect(scenario.rubric).toEqual([{ id: 'replies', criterion: 'The agent replies.' }]);
    expect(scenario.header.requires).toEqual(['mattermost', 'agentic-models']);
  });

  it('names every problem in a bad file at once', () => {
    const bad = `
id: Not Kebab
owner: ''
covers: post_message
persona: Someone.
goal: Something.
opening: Hello?
max_turns: 9
surprise: true
rubric:
  - id: same
    criterion: One.
  - id: same
    criterion: Two.
`;
    let message = '';
    try {
      parseScenario('other.yaml', bad);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const problem of [
      "unknown field 'surprise'",
      "'owner' must be non-empty",
      "'covers' must be a list",
      'not kebab-case',
      'does not match the file name',
      "'max_turns'",
      'used twice',
    ]) {
      expect(message).toContain(problem);
    }
  });
});

describe('judge verdicts', () => {
  const ids = ['replies', 'stays-short'];

  it('takes one verdict per criterion, in rubric order, from JSON wrapped in prose', () => {
    const raw = `Here you go: {"verdicts": [
      {"id": "stays-short", "pass": false, "reason": "Long."},
      {"id": "replies", "pass": true, "reason": "It did."}]}`;
    expect(parseVerdicts(raw, ids)).toEqual({
      ok: true,
      verdicts: [
        { id: 'replies', pass: true, reason: 'It did.' },
        { id: 'stays-short', pass: false, reason: 'Long.' },
      ],
    });
  });

  it('refuses verdicts that do not match the rubric, or are not verdicts', () => {
    expect(parseVerdicts('no json here', ids).ok).toBe(false);
    expect(
      parseVerdicts('{"verdicts": [{"id": "replies", "pass": true, "reason": "x"}]}', ids)
    ).toMatchObject({ ok: false, error: expect.stringContaining('missing: stays-short') });
    expect(
      parseVerdicts(
        '{"verdicts": [{"id": "replies", "pass": "yes", "reason": "x"}, {"id": "stays-short", "pass": true, "reason": "x"}]}',
        ids
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('not {id, pass, reason}') });
  });
});

describe('model answers', () => {
  const answer = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      result: ' ok ',
      is_error: false,
      total_cost_usd: 0.0011,
      modelUsage: { [model]: {} },
      ...extra,
    });

  it('takes the text and cost of an answer from the model asked', () => {
    expect(parseAnswer(answer('claude-sonnet-5'), 'claude-sonnet-5')).toEqual({
      text: 'ok',
      costUsd: 0.0011,
    });
  });

  it('refuses an answer from another model, a failed call, and output that is not JSON', () => {
    expect(() => parseAnswer(answer('claude-haiku-4-5'), 'claude-sonnet-5')).toThrow(
      /came from claude-haiku-4-5/
    );
    expect(() =>
      parseAnswer(
        answer('claude-sonnet-5', { is_error: true, result: 'not available' }),
        'claude-sonnet-5'
      )
    ).toThrow(/not available/);
    expect(() => parseAnswer('Error: something', 'claude-sonnet-5')).toThrow(
      /did not answer with JSON/
    );
  });
});

describe('spend', () => {
  const row = (metric: string, amount: number, model = 'claude-sonnet-5'): UsageTotal => ({
    metric,
    clientId: 'c',
    clientName: 'e2e-abc123a-claude',
    model,
    amount,
  });

  it('prices tokens per metric and model, and counts turns and messages as free', () => {
    const usd = usageCostUsd([
      row('input_tokens', 1_000_000),
      row('output_tokens', 100_000),
      row('cache_read_tokens', 1_000_000),
      row('cache_write_tokens', 400_000),
      row('turns', 3),
    ]);
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 1, 6);
    expect(priceOf('claude-sonnet-5-20260801')).toEqual(priceOf('claude-sonnet-5'));
    expect(priceOf('claude-haiku-4-5@20251001')).toEqual(priceOf('claude-haiku-4-5'));
  });

  it('refuses a model it has no price for, rather than counting it as free', () => {
    expect(() => usageCostUsd([row('input_tokens', 10, 'claude-unknown-1')])).toThrow(/No price/);
  });

  it('stops once the limit is reached', () => {
    const ledger = new Ledger(1);
    ledger.addHarness(0.25);
    ledger.setAgent(0.5);
    expect(ledger.remainingUsd).toBeCloseTo(0.25, 6);
    ledger.assertWithin('the next turn');
    ledger.setAgent(0.75);
    expect(() => ledger.assertWithin('the next turn')).toThrow(BudgetExceededError);
  });
});
