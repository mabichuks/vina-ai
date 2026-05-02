import { z } from 'zod';

const isoDate = z.iso.datetime();

const cvMimeType = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const ProfileSchema = z.object({
  id: z.literal('me'),
  full_name: z.string().min(1),
  email: z.email(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  linkedin_url: z.url().nullable(),
  website_url: z.url().nullable(),
  bio: z.string().nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileInputSchema = z.object({
  full_name: z.string().min(1),
  email: z.email(),
  phone: z.string().optional(),
  location: z.string().optional(),
  linkedin_url: z.url().optional(),
  website_url: z.url().optional(),
  bio: z.string().optional(),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const CvSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: cvMimeType,
  file_path: z.string().min(1),
  extracted_text: z.string().nullable(),
  is_default: z.boolean(),
  created_at: isoDate,
});
export type Cv = z.infer<typeof CvSchema>;

export const CvInputSchema = z.object({
  label: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: cvMimeType,
  file_path: z.string().min(1),
  extracted_text: z.string().optional(),
  is_default: z.boolean().optional(),
});
export type CvInput = z.infer<typeof CvInputSchema>;

export const CoverLetterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: cvMimeType,
  file_path: z.string().min(1),
  extracted_text: z.string().nullable(),
  is_default: z.boolean(),
  created_at: isoDate,
});
export type CoverLetter = z.infer<typeof CoverLetterSchema>;

export const CoverLetterInputSchema = z.object({
  label: z.string().min(1),
  original_filename: z.string().min(1),
  mime_type: cvMimeType,
  file_path: z.string().min(1),
  extracted_text: z.string().optional(),
  is_default: z.boolean().optional(),
});
export type CoverLetterInput = z.infer<typeof CoverLetterInputSchema>;
