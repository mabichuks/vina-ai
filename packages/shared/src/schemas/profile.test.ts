import { describe, expect, it } from 'vitest';
import {
  CoverLetterInputSchema,
  CoverLetterSchema,
  CvInputSchema,
  CvSchema,
  ProfileInputSchema,
  ProfileSchema,
} from './profile.js';

describe('ProfileSchema', () => {
  it('parses a representative row', () => {
    const fixture = {
      id: 'me',
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+44 7700 900000',
      location: 'London, UK',
      linkedin_url: 'https://www.linkedin.com/in/ada',
      website_url: null,
      bio: 'Mathematician.',
      created_at: '2026-04-01T12:00:00Z',
      updated_at: '2026-04-28T12:00:00Z',
    };
    expect(ProfileSchema.parse(fixture)).toEqual(fixture);
  });

  it('rejects when id !== "me"', () => {
    expect(() =>
      ProfileSchema.parse({
        id: 'other',
        full_name: 'x',
        email: 'x@y.com',
        phone: null,
        location: null,
        linkedin_url: null,
        website_url: null,
        bio: null,
        created_at: '2026-04-01T12:00:00Z',
        updated_at: '2026-04-01T12:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects an invalid email in input', () => {
    expect(() => ProfileInputSchema.parse({ full_name: 'x', email: 'not-an-email' })).toThrow();
  });

  it('accepts minimal input (just required fields)', () => {
    expect(ProfileInputSchema.parse({ full_name: 'Ada', email: 'ada@example.com' })).toEqual({
      full_name: 'Ada',
      email: 'ada@example.com',
    });
  });
});

describe('CvSchema / CvInputSchema', () => {
  const validRow = {
    id: '01HXYZ',
    label: 'Senior Backend',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf' as const,
    file_path: 'cvs/01HXYZ.pdf',
    extracted_text: 'Hello world',
    is_default: true,
    created_at: '2026-04-01T12:00:00Z',
  };

  it('parses a valid CV row', () => {
    expect(CvSchema.parse(validRow)).toEqual(validRow);
  });

  it('rejects an unknown mime type', () => {
    expect(() => CvSchema.parse({ ...validRow, mime_type: 'text/plain' })).toThrow();
  });

  it('parses CV input with only required fields', () => {
    expect(
      CvInputSchema.parse({
        label: 'Default',
        original_filename: 'cv.pdf',
        mime_type: 'application/pdf',
        file_path: 'cvs/x.pdf',
      }),
    ).toEqual({
      label: 'Default',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: 'cvs/x.pdf',
    });
  });
});

describe('CoverLetterSchema / CoverLetterInputSchema', () => {
  it('parses a valid cover letter row', () => {
    const row = {
      id: '01HXYZ',
      label: 'Default',
      original_filename: 'cover.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
      file_path: 'cover/01HXYZ.docx',
      extracted_text: null,
      is_default: false,
      created_at: '2026-04-01T12:00:00Z',
    };
    expect(CoverLetterSchema.parse(row)).toEqual(row);
  });

  it('rejects empty label in input', () => {
    expect(() =>
      CoverLetterInputSchema.parse({
        label: '',
        original_filename: 'cover.pdf',
        mime_type: 'application/pdf',
        file_path: 'cover/x.pdf',
      }),
    ).toThrow();
  });
});
