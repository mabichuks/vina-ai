import { describe, expect, it } from 'vitest';
import {
  findGoalNodeInTree,
  type ButtonGoal,
} from '../../src/adapters/element-locator.js';
import {
  accessibilityNodeToUiTree,
  type RawAccessibilityNode,
} from '../../src/snapshot/snapshot.js';

function tree(raw: RawAccessibilityNode) {
  return accessibilityNodeToUiTree(raw);
}

const cases: Array<[ButtonGoal, string, string]> = [
  ['easy_apply', 'Easy Apply', 'button'],
  ['easy_apply', 'Quick Apply', 'button'],
  ['easy_apply', 'Apply', 'button'],
  ['submit', 'Submit application', 'button'],
  ['submit', 'Submit', 'button'],
  ['submit', 'Send application', 'button'],
  ['advance', 'Continue', 'button'],
  ['advance', 'Next', 'button'],
  ['advance', 'Review', 'button'],
  ['dismiss', 'Dismiss', 'button'],
  ['dismiss', 'Close', 'button'],
];

describe('findGoalNodeInTree — accessibility-name match', () => {
  for (const [goal, name, role] of cases) {
    it(`matches goal=${goal} against role=${role} name="${name}"`, () => {
      const t = tree({
        role: 'WebArea',
        name: '',
        children: [{ role, name }],
      });
      const node = findGoalNodeInTree(t, goal);
      expect(node?.name).toBe(name);
    });
  }

  it('returns null when no node matches the goal', () => {
    const t = tree({
      role: 'WebArea',
      name: '',
      children: [{ role: 'button', name: 'Save draft' }],
    });
    expect(findGoalNodeInTree(t, 'submit')).toBeNull();
    expect(findGoalNodeInTree(t, 'easy_apply')).toBeNull();
  });

  it('ignores nodes with the right name but the wrong role (e.g. text node)', () => {
    const t = tree({
      role: 'WebArea',
      name: '',
      children: [{ role: 'StaticText', name: 'Submit' }],
    });
    expect(findGoalNodeInTree(t, 'submit')).toBeNull();
  });

  it('finds nested buttons depth-first', () => {
    const t = tree({
      role: 'WebArea',
      name: '',
      children: [
        {
          role: 'generic',
          name: '',
          children: [
            {
              role: 'group',
              name: '',
              children: [{ role: 'button', name: 'Continue' }],
            },
          ],
        },
      ],
    });
    const node = findGoalNodeInTree(t, 'advance');
    expect(node?.name).toBe('Continue');
  });

  it('returns the first match when several would match', () => {
    const t = tree({
      role: 'WebArea',
      name: '',
      children: [
        { role: 'button', name: 'Continue' },
        { role: 'button', name: 'Next' },
      ],
    });
    expect(findGoalNodeInTree(t, 'advance')?.name).toBe('Continue');
  });
});
