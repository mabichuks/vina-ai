import { describe, expect, it } from 'vitest';
import { newId } from '../src/ulid.js';

describe('newId', () => {
  it('produces 1000 unique 26-char monotonic ULIDs in sort order', () => {
    const ids = Array.from({ length: 1000 }, newId);
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});
