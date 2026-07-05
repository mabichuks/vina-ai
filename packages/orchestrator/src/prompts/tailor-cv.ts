/**
 * CV-tailoring user-prompt builder. The system prompt now lives in
 * `prompts/tailor-cv.md`; this file keeps only the userTemplate and its
 * input shape (per the prompt-system spec — interpolation stays in code).
 */

export interface TailorCvInput {
  job: {
    title: string;
    company: string;
    description: string;
  };
  source_cv_text: string;
  user_profile: {
    full_name: string;
    bio: string | null;
  };
}

export function tailorCvUserPrompt(input: TailorCvInput): string {
  const { job, source_cv_text, user_profile } = input;
  const lines: string[] = [];

  lines.push('## Job');
  lines.push(`Title: ${job.title}`);
  lines.push(`Company: ${job.company}`);
  lines.push('Description:');
  lines.push(job.description);
  lines.push('');

  lines.push('## User profile');
  lines.push(`Name: ${user_profile.full_name}`);
  if (user_profile.bio) lines.push(`Bio: ${user_profile.bio}`);
  lines.push('');

  lines.push('## Source CV');
  lines.push(source_cv_text);

  return lines.join('\n');
}
