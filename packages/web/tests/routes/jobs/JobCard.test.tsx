import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { JobCard } from '../../../src/routes/jobs/JobCard.js';
import type { Job } from '@vina/shared';

const baseManual: Job = {
  id: 'j1',
  site_id: 'google',
  external_id: 'ex',
  url: 'https://gh.io/x',
  external_apply_url: 'https://gh.io/x',
  apply_method: 'manual',
  original_source: 'via Greenhouse',
  title: 'Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'd',
  salary_text: null,
  posted_at: null,
  discovered_at: '2026-05-13T10:00:00Z',
  match_score: 85,
  match_justification: 'good',
  status: 'scored',
};

const noop = (): void => undefined;

afterEach(() => {
  cleanup();
});

describe('JobCard original_source', () => {
  it('renders the via caption under the header', () => {
    render(<JobCard job={baseManual} variant="new" onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop} />);
    expect(screen.getByText('via Greenhouse')).toBeInTheDocument();
  });

  it('uses original_source for the apply button label, stripped of the via prefix', () => {
    render(<JobCard job={baseManual} variant="new" onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop} />);
    expect(screen.getByRole('button', { name: 'Apply on Greenhouse' })).toBeInTheDocument();
  });

  it('falls back to Apply externally when original_source is null on a manual job', () => {
    render(
      <JobCard
        job={{ ...baseManual, original_source: null }}
        variant="new"
        onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply externally' })).toBeInTheDocument();
  });

  it('keeps Apply on LinkedIn for auto-apply jobs', () => {
    render(
      <JobCard
        job={{ ...baseManual, apply_method: 'auto', site_id: 'linkedin', original_source: null }}
        variant="new"
        onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply on LinkedIn' })).toBeInTheDocument();
  });
});
