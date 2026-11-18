# Vendored harness skills

A read-only in-repo snapshot of the `odytrice/jobs` harness's eight skills,
pinned by [`harness-version.json`](./harness-version.json). Do not edit these
files by hand — re-vendor from the pinned commit instead.

## Vendoring scope

Only `SKILL.md` and `references/` ship per skill. `scripts/` and `assets/` are
excluded: Vina's tools, renderer, database, and web UI replace them.

- `job-materials/scripts/render_pdf.py`, `verify_pdf.py` → `vina_materials_save`'s
  deterministic PDF/DOCX rendering.
- `job-sweep/scripts/ats_sweep.py` → SerpAPI/Playwright via `vina_search_jobs`.
- `job-review/scripts/compare_resume.py`, `job-interview/scripts/scaffold_studio.py`
  → Vina tools and the database.
- `job-setup/scripts/init_workspace.py` → the workspace generator + SQLite.
- `job-interview/assets/studio/`, `job-setup/assets/workspace/` → the Vina web UI
  and SQLite.

Inline references to those scripts/assets in the SKILL.md prose are
reference-only dead prose — same treatment as the state mechanics below.

## Reference-only state mechanics

`job-pipeline` and every markdown-note state mechanic (ledgers, batch notes,
`JOBSEARCH.md`-style workspace files) are reference-only. Their prose ships for
its procedure value, but Vina's SQLite (`applications`, `application_events`)
owns state, and the `vina_*` tools (`vina_application_status`,
`vina_review_record`, `vina_materials_save`) are the write path. Vina does not
port the harness's file-based workspace.
