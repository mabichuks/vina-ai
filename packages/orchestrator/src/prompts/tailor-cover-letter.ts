/**
 * Cover-letter-tailoring user-prompt builder. The system prompt now lives
 * in `prompts/tailor-cover-letter.md`; this file keeps only the
 * userTemplate and its input shape.
 */

export interface TailorCoverLetterInput {
  job: { title: string; company: string; description: string };
  source_template: string;
  user_profile: { full_name: string; bio: string | null };
}

export function tailorCoverLetterUserPrompt(input: TailorCoverLetterInput): string {
  const { job, source_template, user_profile } = input;
  return [
    '## Job',
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    'Description:',
    job.description,
    '',
    '## User profile',
    `Name: ${user_profile.full_name}`,
    user_profile.bio ? `Bio: ${user_profile.bio}` : '',
    '',
    '## Source template',
    source_template,
  ].join('\n');
}
