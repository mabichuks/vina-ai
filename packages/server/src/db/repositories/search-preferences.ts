import type { Database as DatabaseType } from 'better-sqlite3';
import type { SearchPreferences, SearchPreferencesInput, Seniority, WorkModel } from '@vina/shared';

interface SearchPreferencesRow {
  id: 'default';
  description: string;
  keywords: string;
  locations: string;
  work_models: string;
  seniority: string;
  min_salary: number | null;
  max_salary: number | null;
  salary_currency: string | null;
  excluded_companies: string;
  score_threshold: number;
  updated_at: string;
}

function rowToPrefs(row: SearchPreferencesRow): SearchPreferences {
  return {
    id: 'default',
    description: row.description,
    keywords: JSON.parse(row.keywords) as string[],
    locations: JSON.parse(row.locations) as string[],
    work_models: JSON.parse(row.work_models) as WorkModel[],
    seniority: JSON.parse(row.seniority) as Seniority[],
    min_salary: row.min_salary,
    max_salary: row.max_salary,
    salary_currency: row.salary_currency,
    excluded_companies: JSON.parse(row.excluded_companies) as string[],
    score_threshold: row.score_threshold,
    updated_at: row.updated_at,
  };
}

const DEFAULT_PREFS: Omit<SearchPreferences, 'updated_at'> = {
  id: 'default',
  description: '',
  keywords: [],
  locations: [],
  work_models: [],
  seniority: [],
  min_salary: null,
  max_salary: null,
  salary_currency: null,
  excluded_companies: [],
  score_threshold: 70,
};

/** Returns the singleton row, creating defaults if none exist yet. */
export function getOrInitSearchPreferences(db: DatabaseType): SearchPreferences {
  const row = db.prepare(`SELECT * FROM search_preferences WHERE id = 'default'`).get() as
    | SearchPreferencesRow
    | undefined;
  if (row) return rowToPrefs(row);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO search_preferences
       (id, description, keywords, locations, work_models, seniority,
        min_salary, max_salary, salary_currency, excluded_companies,
        score_threshold, updated_at)
     VALUES ('default', @description, @keywords, @locations, @work_models, @seniority,
             @min_salary, @max_salary, @salary_currency, @excluded_companies,
             @score_threshold, @updated_at)`,
  ).run({
    description: DEFAULT_PREFS.description,
    keywords: JSON.stringify(DEFAULT_PREFS.keywords),
    locations: JSON.stringify(DEFAULT_PREFS.locations),
    work_models: JSON.stringify(DEFAULT_PREFS.work_models),
    seniority: JSON.stringify(DEFAULT_PREFS.seniority),
    min_salary: DEFAULT_PREFS.min_salary,
    max_salary: DEFAULT_PREFS.max_salary,
    salary_currency: DEFAULT_PREFS.salary_currency,
    excluded_companies: JSON.stringify(DEFAULT_PREFS.excluded_companies),
    score_threshold: DEFAULT_PREFS.score_threshold,
    updated_at: now,
  });

  return { ...DEFAULT_PREFS, updated_at: now };
}

/** Partial update — only provided fields are written. */
export function upsertSearchPreferences(
  db: DatabaseType,
  patch: SearchPreferencesInput,
): SearchPreferences {
  const current = getOrInitSearchPreferences(db);

  const next: SearchPreferences = {
    ...current,
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.keywords !== undefined && { keywords: patch.keywords }),
    ...(patch.locations !== undefined && { locations: patch.locations }),
    ...(patch.work_models !== undefined && { work_models: patch.work_models }),
    ...(patch.seniority !== undefined && { seniority: patch.seniority }),
    ...(patch.min_salary !== undefined && { min_salary: patch.min_salary }),
    ...(patch.max_salary !== undefined && { max_salary: patch.max_salary }),
    ...(patch.salary_currency !== undefined && {
      salary_currency: patch.salary_currency,
    }),
    ...(patch.excluded_companies !== undefined && {
      excluded_companies: patch.excluded_companies,
    }),
    ...(patch.score_threshold !== undefined && {
      score_threshold: patch.score_threshold,
    }),
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE search_preferences SET
       description=@description, keywords=@keywords, locations=@locations,
       work_models=@work_models, seniority=@seniority,
       min_salary=@min_salary, max_salary=@max_salary, salary_currency=@salary_currency,
       excluded_companies=@excluded_companies, score_threshold=@score_threshold,
       updated_at=@updated_at
     WHERE id='default'`,
  ).run({
    description: next.description,
    keywords: JSON.stringify(next.keywords),
    locations: JSON.stringify(next.locations),
    work_models: JSON.stringify(next.work_models),
    seniority: JSON.stringify(next.seniority),
    min_salary: next.min_salary,
    max_salary: next.max_salary,
    salary_currency: next.salary_currency,
    excluded_companies: JSON.stringify(next.excluded_companies),
    score_threshold: next.score_threshold,
    updated_at: next.updated_at,
  });

  return next;
}
