import { describe, expect, it } from 'vitest';
import { isLikelyPreActionSubstitutionRequest } from './_staff-substitution-intent.js';

describe('isLikelyPreActionSubstitutionRequest', () => {
  it('matches a plain pre-action substitution ask', () => {
    expect(isLikelyPreActionSubstitutionRequest('Can I use mushroom instead?')).toBe(true);
  });

  it('matches "should I" + "instead" phrasing', () => {
    expect(isLikelyPreActionSubstitutionRequest('We are out of pepperoni. Should I make mushroom instead?')).toBe(true);
  });

  it('matches "is it okay if" + "substitute"', () => {
    expect(isLikelyPreActionSubstitutionRequest('Is it okay if I substitute blueberries for the strawberries?')).toBe(true);
  });

  it('matches "may I" + "swap"', () => {
    expect(isLikelyPreActionSubstitutionRequest('May I swap the TEREA Silver for TEREA Turquoise?')).toBe(true);
  });

  it('matches "do you approve" + "replace"', () => {
    expect(isLikelyPreActionSubstitutionRequest('Do you approve if I replace Coke with Pepsi?')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLikelyPreActionSubstitutionRequest('CAN I use mushroom INSTEAD?')).toBe(true);
  });

  it('rejects a permission phrase with no substitution signal — ordinary staff message', () => {
    expect(isLikelyPreActionSubstitutionRequest('Can I leave early today?')).toBe(false);
  });

  // 2026-08-26 real production test (Christopher, TEREA Silver -> Turquoise):
  // the exact real-world phrasing lacked both "if" after "is it ok" and any
  // instead/substitute/swap/replace keyword — the original narrower gate
  // rejected it, which is exactly why the photo+caption misrouted into the
  // completion-proof pipeline. Widened, not weakened: every prior positive
  // case below still matches, and no prior negative case starts matching.
  it('matches the real production phrasing: "is it ok?" (no "if") + "found only"', () => {
    expect(isLikelyPreActionSubstitutionRequest('I found only Turquoise. Is it ok?')).toBe(true);
  });

  it('matches "is it okay?" without a trailing "if" clause', () => {
    expect(isLikelyPreActionSubstitutionRequest('Is it okay? I only have the blue one.')).toBe(true);
  });

  it('matches scarcity phrasing without the word "instead"', () => {
    expect(isLikelyPreActionSubstitutionRequest("Can I get this? We're out of the one you asked for.")).toBe(true);
    expect(isLikelyPreActionSubstitutionRequest("Should I get this? Couldn't find the exact item.")).toBe(true);
  });

  it('rejects a substitution word with no permission phrase — a statement, not a request', () => {
    expect(isLikelyPreActionSubstitutionRequest('I used the substitute detergent already.')).toBe(false);
  });

  it('rejects ordinary conversational text entirely unrelated to any task', () => {
    expect(isLikelyPreActionSubstitutionRequest('Thanks, will do!')).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest('What time should I pick up the kids?')).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest('Good morning')).toBe(false);
  });

  it('rejects completion/blocker/status text with neither signal', () => {
    expect(isLikelyPreActionSubstitutionRequest("It's done, sending the photo now.")).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest('The store is closed, I am stuck.')).toBe(false);
  });

  it('never throws and returns false for non-string or empty input', () => {
    expect(isLikelyPreActionSubstitutionRequest(null)).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest(undefined)).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest('')).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest('   ')).toBe(false);
    expect(isLikelyPreActionSubstitutionRequest(42)).toBe(false);
  });
});
