/**
 * Canned SerpAPI-shaped JSON responses for the Google Jobs fixture server.
 * Page 1 returns two listings with a next_page_token; page 2 returns one
 * listing with no token (final page).
 */

export const FIXTURE_JOBS_PAGE_1 = {
  jobs_results: [
    {
      job_id: 'g-1',
      title: 'Senior TypeScript Engineer',
      company_name: 'Acme Corp',
      location: 'Remote',
      via: 'via Greenhouse',
      description: 'Build TypeScript APIs.',
      detected_extensions: { salary: '$180K' },
      apply_options: [{ title: 'Apply on Greenhouse', link: 'https://gh.io/g-1' }],
    },
    {
      job_id: 'g-2',
      title: 'Staff Backend Engineer',
      company_name: 'Globex',
      location: 'New York',
      via: 'via Lever',
      description: 'Lead backend services.',
      apply_options: [{ title: 'Apply on Lever', link: 'https://lever.co/g-2' }],
    },
  ],
  serpapi_pagination: { next_page_token: 'pg2' },
} as const;

export const FIXTURE_JOBS_PAGE_2 = {
  jobs_results: [
    {
      job_id: 'g-3',
      title: 'Junior Frontend Engineer',
      company_name: 'Initech',
      location: 'Remote',
      via: 'via Workday',
      description: 'Frontend work.',
      apply_options: [{ title: 'Apply', link: 'https://workday.com/g-3' }],
    },
  ],
} as const;
