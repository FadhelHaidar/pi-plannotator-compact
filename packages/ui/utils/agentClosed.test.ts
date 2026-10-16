import { describe, expect, test } from 'bun:test';
import { AGENT_CLOSED_TITLE, agentClosedSubtitle, closedReviewCopy, type AgentClosedSurface } from './agentClosed';

describe('closedReviewCopy', () => {
  test.each(['file', 'folder', 'document', 'app', 'changes'] as AgentClosedSurface[])(
    'preserves agent copy exactly for %s, including legacy events without a reason', (surface) => {
      for (const unsentAnnotations of [0, 1, 4]) {
        const expected = { title: AGENT_CLOSED_TITLE, subtitle: agentClosedSubtitle(unsentAnnotations, surface) };
        expect(closedReviewCopy({ by: 'agent', unsentAnnotations }, surface)).toEqual(expected);
        expect(closedReviewCopy({ unsentAnnotations }, surface)).toEqual(expected);
      }
    },
  );

  test.each([0, 1, 4])('session closure is neutral and explains draft recovery (%s comments)', (unsentAnnotations) => {
    expect(closedReviewCopy({ by: 'session', unsentAnnotations })).toEqual({
      title: 'Review Closed',
      subtitle: "This review's session ended. Your saved draft comments are kept. Reopening the same document, unchanged, brings it back.",
    });
  });
});
