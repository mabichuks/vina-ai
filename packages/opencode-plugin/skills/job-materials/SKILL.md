---
name: job-materials
description: Build the application package for one role (folder, tailored resume, optional cover letter, drafted form answers, application note), render and verify its PDFs, and fix review findings. Use to prepare an application, tailor or render a resume or cover letter, or revise materials.
---

# Job Materials

The writer's skill: builds and fixes materials, never submits, sends, or
reviews its own output (`job-review` audits it; `job-apply` submits it).
Tailoring emphasizes true experience for a role; it never invents,
inflates, or redates it. Owner of § Fact Gaps and § Render And Verify.

Facts from `JOBSEARCH.md` (the path given; else the working directory or its
nearest ancestor; else `AGENTS.md` § Job Search): **§ Harness Conventions**,
**§ Candidate**, **§ Search Criteria**, **§ Workspace**, **§ Master Record**,
**§ Standing Answers**. Missing or placeholder section: name it and stop.

Read before editing: the tailoring rules file, the checks file, the master
resume HTML, `references/resume-html.md` (the structure every variant
keeps), and `references/tech-release-dates.md`. Asked for a resume or cover
letter alone, run § Tailor and § Render And Verify only.

## Package

1. **Confirm the lead.** It must have a Retain verdict from `job-sweep`
   § Evaluate. Re-check that the requisition is still live before investing
   time; a closed requisition stops here with a note.
2. **Folder.** Create the role folder per § Workspace (one folder per
   requisition, even at the same company). If a folder exists, read it first;
   an application note with status `applied` or later means the materials are
   submitted and immutable: stop and report.
3. **Capture the role.** Save the job description summary, requirements
   (required versus preferred), location and pay evidence from the lead, and
   every form question. Greenhouse exposes questions through the job API
   (`?questions=true`); Ashby, Lever, and Workday forms are read in the
   browser, read-only, under `job-apply` § Browser Rules.
4. **Resume** per § Tailor.
5. **Cover letter** only when the form requires one or the user asks. Same
   truth rules as the resume: every claim traces to § Master Record files;
   excluded topics stay out; company and role names are checked twice.
   Render and verify it with the `cover-letter` checks profile.
6. **Answers.** For each form question, take the answer in this order:
   § Standing Answers, then an answer the user approved in an earlier
   application note (cite it), then a draft built only from the record. Mark
   each answer's source. Respect character limits and count them. Anything
   the record cannot answer is a fact gap.
7. **Application note** from `references/application-note.md`, status
   `draft`. Materials list each file with page count and hash.
8. **Hand off** for review (`job-review`, always a fresh context). After a
   clean review the caller sets status `ready`.

## Tailor

1. **Start from the master HTML.** Earlier variants may borrow wording only
   after checking it against the current master; stale variants carry stale
   dates and excluded topics.
2. **Plan the tailoring** against the role's top requirements: tagline,
   summary, four or so highlights, skills ordering, and duty ordering. Write
   the plan into the application note's `## Materials` as "focus".
3. **Edit within the rules:**
   - Employers, titles, locations, dates, and outcomes never change.
   - Frozen roles (`data-frozen="true"`): duties may be reordered only.
   - Flexible roles: the technology line may be re-pointed to the target's
     stack when each addition existed during the role
     (`tech-release-dates.md`), is not a never-claimed skill, and is
     something the candidate can discuss in an interview. Duty rewording
     keeps meaning and outcome.
   - A skill added to the skills list must be backed by a role entry.
   - Numbers come only from the master record or § Master Record approved
     claims. Excluded topics never appear.
   - Summary conventions from the tailoring rules (lead with level and
     specialization, no personality adjectives, present tense only for the
     current role).
4. **Log liberties** in the tailoring rules' per-role liberties table: what
   was added to which flexible role, so interview prep knows what is fair
   game.
5. Never modify the master during tailoring. A master correction is a
   separate change the user approves.

## Render And Verify

Owner section; every PDF the harness produces goes through it.

```text
python <skill-dir>/scripts/render_pdf.py "<variant>.html" "<output>.pdf"
python <skill-dir>/scripts/verify_pdf.py "<output>.pdf" --checks <checks-file> --profile resume --preview "<scratch>/<name>.png" --unique-in "<applications-folder>"
```

- The renderer finds Chrome, Chromium, or Edge (override with `--browser`
  or `JOBSEARCH_BROWSER`), prints with an isolated profile, and waits for
  the file: browsers often finish writing a moment after exit. It refuses to
  replace an existing PDF; pass `--force` only for an unsubmitted draft.
- The verifier checks page count, banned patterns (excluded topics,
  never-claimed skills, product names), required text (for example frozen
  dates), forbidden characters, text outside the page box, extractable text,
  and that the PDF is not a duplicate of another variant. Exit 1 is a
  failure to fix, not to explain away.
- Look at the preview image. Check for overflowing lines, orphaned headings,
  a near-empty last page, and broken characters.
- Write the PDF filename per § Master Record's pattern, and record pages and
  the SHA-256 in the application note.

## Fact Gaps

Owner section: how missing facts are handled everywhere.

- A fact gap is any statement the materials or answers would need that is
  not in § Master Record files, § Standing Answers, or an earlier explicit
  user confirmation: tenure in a specialty, a tool used in production, a
  reason for interest, a current-employer field, a salary figure.
- Never guess, generalize, or relabel to fill one (for example, total years
  of software work are not years in a specialty the form asks about).
- Collect all gaps for the role (or the batch) and ask once, with the exact
  form wording, the options offered, and what the record does say. As a
  subagent, return them as questions.
- Record each answer in the application note's `## Fact Gaps` with the date
  and the user's words. When it will recur, propose adding it to § Standing
  Answers or the story bank; write it there only with the user's approval.
- Fields marked as requiring the applicant's own words get the user's text,
  lightly joined only with approval.

## Revision

Fix only the enumerated findings, then re-render and re-verify. A finding
you believe is wrong is contested with the reason, never silently skipped.
Submitted materials and the master record never change.

## Report

Folder path, files with pages and hashes, verifier output, answers by
source, open fact gaps (as questions), the tailoring focus, liberties
applied, residual risks for the reviewer, and for a revision what changed
per finding.
