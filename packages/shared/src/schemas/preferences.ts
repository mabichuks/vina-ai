import { z } from 'zod';

export const WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

export const SENIORITIES = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
] as const;
export type Seniority = (typeof SENIORITIES)[number];

const isoDate = z.iso.datetime();

export const SearchPreferencesSchema = z.object({
  id: z.literal('default'),
  description: z.string().min(1),
  keywords: z.array(z.string()),
  locations: z.array(z.string()),
  work_models: z.array(z.enum(WORK_MODELS)),
  seniority: z.array(z.enum(SENIORITIES)),
  min_salary: z.number().int().nonnegative().nullable(),
  max_salary: z.number().int().nonnegative().nullable(),
  salary_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  excluded_companies: z.array(z.string()),
  score_threshold: z.number().int().min(0).max(100),
  updated_at: isoDate,
});
export type SearchPreferences = z.infer<typeof SearchPreferencesSchema>;

export const SearchPreferencesInputSchema = z.object({
  description: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  work_models: z.array(z.enum(WORK_MODELS)).optional(),
  seniority: z.array(z.enum(SENIORITIES)).optional(),
  min_salary: z.number().int().nonnegative().nullable().optional(),
  max_salary: z.number().int().nonnegative().nullable().optional(),
  salary_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  excluded_companies: z.array(z.string()).optional(),
  score_threshold: z.number().int().min(0).max(100).optional(),
});
export type SearchPreferencesInput = z.infer<typeof SearchPreferencesInputSchema>;
