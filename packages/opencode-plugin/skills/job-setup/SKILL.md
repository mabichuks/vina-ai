---
name: job-setup
description: Create or audit a job-search workspace (JOBSEARCH.md contract, pipeline, master resume, tailoring rules, checks, story bank, folders). Use to set up a job search, onboard the harness, or check a workspace's contract.
---

# Job Setup

Creates the files every other skill reads, and audits them. Writes only
inside the workspace; never sends, submits, or books.

`assets/workspace/JOBSEARCH.md` is the contract: the section headings every
skill reads, the harness conventions, and a `<FILL: ...>` marker for each
personal fact. Skills find the workspace's copy at the path given; else in
the working directory or its nearest ancestor; else at the path under
`## Job Search` in that folder's `AGENTS.md`. A skill that needs a missing
section, or one still holding a marker, names it and stops.

## Modes

- **New:** no `JOBSEARCH.md` is found.
- **Audit:** a `JOBSEARCH.md` exists. Check it, report, and fill gaps with
  the user.

## New Workspace

1. Agree the workspace folder with the user (a notes vault subfolder works).
   Scaffold it, then show what was created and skipped:

   ```text
   python <skill-dir>/scripts/init_workspace.py "<workspace>" --dry-run
   python <skill-dir>/scripts/init_workspace.py "<workspace>"
   ```

   Existing files are never overwritten.
2. **Fill the contract** section by section with the user, in a few grouped
   questions rather than one at a time. Import from material the user points
   to (an existing plan, notes, or resume) instead of asking again, and show
   what was imported. Replace every `<FILL: ...>` marker (`&lt;FILL:` inside
   HTML); pattern variables such as `<Company>` stay. Keep
   `## Harness Conventions` verbatim.
3. **Master record.** Convert the user's current resume into `Resume.md` (the
   source of truth) and `Resume.html` (the render source, following
   `job-materials` `references/resume-html.md`). Mark the recent roles that
   must stay frozen with the user. Ask the user to confirm every date, title,
   and employer; a parsed resume garbles them. Render and verify per
   `job-materials` § Render And Verify.
4. **Rules and checks.** Fill the tailoring rules (what may flex, frozen
   roles, never-claimed skills, summary conventions) and the checks file
   (page counts, banned patterns for excluded topics and never-claimed
   skills, required text such as frozen date ranges). Write regexes with
   word boundaries so short terms do not match inside words.
5. **Story bank.** Seed three or more stories from the resume with the user,
   and record approved claims (numbers the user confirms are shareable).
6. **Discovery.** Fill the tokens file with employers the user wants
   swept; verify each token answers on its API before keeping it
   (`job-sweep` `references/ats-apis.md`). Write the location regex for the
   location policy and test it against a few known postings.
7. **Agent pointer.** If the harness runs from a parent folder (for example
   a vault root), add a `## Job Search` section to that folder's `AGENTS.md`
   naming the `JOBSEARCH.md` path, with the user's approval. For Claude Code,
   `CLAUDE.md` should import it (`@AGENTS.md`).
8. **Install reminder.** The harness installs per workspace from its repo
   with `python sync.py --target <folder>`, where the folder is where the
   agent is launched.

## Audit

Check and report each item; fix only with the user's approval:

- Every contract heading from `## Harness Conventions` to `## Approvals`
  present, with no `<FILL:` marker left in any workspace file (`&lt;FILL:`
  in HTML), and `## Harness Conventions` matching
  `assets/workspace/JOBSEARCH.md`.
- Every path in § Workspace and § Master Record exists.
- The master HTML parses under the resume contract and renders to the page
  count in the checks file; the checks file is valid JSON and its regexes
  compile.
- The tokens file parses; a sample of tokens answers on its API.
- The pipeline table has the § Pipeline columns; note statuses use the
  mapped values.
- § Approvals still includes the default minimum list.
- § Search Criteria Decisions are dated and newest first.

## Report

Files created or skipped, sections filled and still open, audit findings
with fixes applied or proposed, and the next skill to run (usually
`job-sweep`).
