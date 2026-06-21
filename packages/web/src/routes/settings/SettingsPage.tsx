import { AnswersTile } from './AnswersTile.js';
import { PromptsTile } from './PromptsTile.js';
import { SearchPreferencesTile } from './SearchPreferencesTile.js';
import { SitesTile } from './SitesTile.js';
import { SkillsTile } from './SkillsTile.js';

export function SettingsPage(): JSX.Element {
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
        Settings
      </h1>
      <SitesTile />
      <SearchPreferencesTile />
      <AnswersTile />
      <PromptsTile />
      <SkillsTile />
    </section>
  );
}
