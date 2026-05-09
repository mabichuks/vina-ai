import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import { freshTestDb } from '../test-helpers.js';
import {
  deleteLlmProvider,
  findLlmProviderById,
  insertLlmProvider,
  listLlmProviders,
  updateLlmProvider,
} from './llm-providers.js';
import { updateSettings } from './settings.js';

describe('llm_providers repository', () => {
  it('insert + find + list', () => {
    const db = freshTestDb();
    const p = insertLlmProvider(db, {
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-4-7',
      encrypted_api_key: Buffer.from('cipher'),
    });
    expect(findLlmProviderById(db, p.id)?.kind).toBe('anthropic');
    expect(listLlmProviders(db)).toHaveLength(1);
    db.close();
  });

  it('round-trips ciphertext for encrypted_api_key', () => {
    const db = freshTestDb();
    const cipher = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const p = insertLlmProvider(db, {
      kind: 'openai',
      label: 'GPT',
      model: 'gpt-5',
      encrypted_api_key: cipher,
    });
    const round = findLlmProviderById(db, p.id);
    expect(round?.encrypted_api_key).toBeInstanceOf(Buffer);
    expect(Buffer.compare(round!.encrypted_api_key!, cipher)).toBe(0);
    db.close();
  });

  it('update label/model without touching ciphertext', () => {
    const db = freshTestDb();
    const cipher = Buffer.from('original');
    const p = insertLlmProvider(db, {
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-4-7',
      encrypted_api_key: cipher,
    });
    const updated = updateLlmProvider(db, p.id, { label: 'Claude (renamed)' });
    expect(updated.label).toBe('Claude (renamed)');
    expect(Buffer.compare(updated.encrypted_api_key!, cipher)).toBe(0);
    db.close();
  });

  it('deleting a provider that settings.active_llm_provider_id references is rejected by the FK', () => {
    const db = freshTestDb();
    const p = insertLlmProvider(db, {
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-4-7',
    });
    updateSettings(db, { active_llm_provider_id: p.id });

    expect(() => deleteLlmProvider(db, p.id)).toThrow();

    // After clearing the FK pointer, delete should succeed.
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
