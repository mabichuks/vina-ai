import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import {
  deleteLlmProvider,
  findLlmProviderById,
  insertLlmProvider,
} from '../../../src/db/repositories/llm-providers.js';
import { updateSettings } from '../../../src/db/repositories/settings.js';
import { freshTestDb } from '../helpers.js';

describe('llm_providers repository', () => {
  it('round-trips ciphertext for encrypted_api_key', () => {
    const db = freshTestDb();
    const cipher = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const p = insertLlmProvider(db, {
      kind: 'openai',
      label: 'GPT',
      model: 'gpt-5',
      encrypted_api_key: cipher,
    });
    expect(Buffer.compare(findLlmProviderById(db, p.id)!.encrypted_api_key!, cipher)).toBe(0);
    db.close();
  });

  it('FK RESTRICT blocks deletion when settings.active_llm_provider_id references the row', () => {
    const db = freshTestDb();
    const p = insertLlmProvider(db, { kind: 'anthropic', label: 'Claude', model: 'm' });
    updateSettings(db, { active_llm_provider_id: p.id });
    expect(() => deleteLlmProvider(db, p.id)).toThrow();

    updateSettings(db, { active_llm_provider_id: null });
    deleteLlmProvider(db, p.id);
    expect(findLlmProviderById(db, p.id)).toBeNull();
    db.close();
  });

  it('delete of missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => deleteLlmProvider(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
