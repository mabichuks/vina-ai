# Employer Board APIs

Read postings from the employer's own applicant-tracking system. Aggregators
lag and keep dead listings, so they are discovery hints at most; the
employer board is the authority for live status, dates, location, and pay.

## Greenhouse

- List: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs`
- Job: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?pay_transparency=true&questions=true`
- Freshness: `first_published`. `updated_at` moves on any edit and is not a
  "new" signal.
- Location: `location.name`; the job endpoint adds `offices`.
- Pay: `pay_input_ranges[]` with `min_cents`, `max_cents`, `currency_type`,
  `title`, and a `blurb` that often limits the range to one country. A range
  titled for one country says nothing about another. Many employers put pay
  only in `content` (HTML-escaped description).
- Form: `questions[]` (label, required, field types and options),
  `location_questions`, `demographic_questions`, `compliance`.
- Some employers embed the form in an iframe on their own site; the hosted
  board URL or `job-boards.greenhouse.io/embed/job_app?for={token}&token={id}`
  reaches it directly.

## Ashby

- Board: `https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true`
- Freshness: `publishedAt`. Skip `isListed: false`.
- Location: `location`, `secondaryLocations[].location`,
  `address.postalAddress.addressCountry`, `workplaceType`, `isRemote`.
- Pay: under `job.compensation`, never a top-level key (that key is silently
  empty). `compensationTiers[].components[]` carries `compensationType`
  (`Salary`, `EquityPercentage`, ...), `currencyCode`, `minValue`, `maxValue`,
  and `interval`; `compensationTierSummary` is the display string.
- Throttling answers **404, not 429**. A 404 is not proof a board is gone;
  retry with backoff before treating it as absent. Some boards are genuinely
  absent from the public API; use the employer career page for those.
- The application form is not in the posting API; read it in the browser.

## Lever

- Board: `https://api.lever.co/v0/postings/{token}?mode=json`
  (`api.eu.lever.co` for EU-hosted boards).
- Freshness: `createdAt`, epoch milliseconds. Reposts get new ids.
- Location: `categories.location`, `categories.allLocations`, `country`,
  `workplaceType`.
- Pay: `salaryRange` (`min`, `max`, `currency`, `interval`) when published;
  otherwise in the description lists.
- An unknown token answers 404 or an error object, not an empty list.

## Not sweepable

- **Workday** employers have no shared public board API. Use the employer's
  career site or a signed-in job board, then verify on the Workday posting.
- **SmartRecruiters, Workable, Teamtailor, iCIMS, Dayforce** and similar:
  read the employer page directly; add a fetcher only when a workspace uses
  one often.
- Signed-in boards (for example LinkedIn) show reposts with fresh dates.
  The employer's first-publication date wins.

## Sweep hygiene

- Errors are coverage gaps. Report them; never read them as "no openings".
- Overlapping token lists are not unique employers; never sum their counts.
- Raw title and location matches are discovery counts, not qualified leads.
- Sort the window by publication date when the user wants newest first;
  fit ranking buries fresh postings.
- Keep raw output folders and cite them in the leads note.
