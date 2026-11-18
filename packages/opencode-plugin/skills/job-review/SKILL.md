---
name: job-review
description: Independently audit an application package (resume variant, cover letter, form answers) for fabrication, rule breaks, and errors before submission. Use when asked to review, check, or audit application materials.
---

# Job Review

Fresh-context audit. Never review materials you wrote or edited in this
session, and never edit the materials: return findings for the writer to
fix. Owner of § Severity.

Facts from `JOBSEARCH.md` (the path given; else the working directory or its
nearest ancestor; else `AGENTS.md` § Job Search): **§ Harness Conventions**,
**§ Candidate**, **§ Search Criteria**, **§ Master Record**,
**§ Standing Answers**. Missing or placeholder section: name it and stop.

Inputs: the role folder (application note, variant HTML, PDFs) and, for a
re-review, the previous round's findings.

## Severity

One ladder for every review. **Critical or High blocks submission.**

| Severity | Meaning | Examples |
|---|---|---|
| Critical | False or unverifiable statement an employer would rely on | changed employer, title, location, or date; a claim with no source in the record; an excluded topic; the wrong company or role named; a dishonest eligibility or authorization answer |
| High | Rule break likely to cost credibility | anachronistic technology; a never-claimed skill; a frozen role altered; a number not in approved claims; page count or verifier failure; wrong file attached or named |
| Medium | Weakens the application | tailoring misses the role's top requirements; tense errors; an answer inconsistent with standing answers in wording only |
| Low | Polish | ordering, phrasing, minor layout |

## Checks

Run every item in `references/checklist.md`. The mechanical ones:

```text
python <skill-dir>/scripts/compare_resume.py "<master>.html" "<variant>.html"
python <job-materials-dir>/scripts/verify_pdf.py "<pdf>" --checks <checks-file> --profile resume --preview "<scratch>/<name>.png"
```

`compare_resume.py` flags changed role facts, altered frozen roles, and any
number absent from the master as blocking; it lists tailorable changes as
`Info` for you to judge against the tailoring rules, the timeline table, and
approved claims. A variant it cannot parse gets a manual diff. Then read the
PDF text and the preview yourself: scripts do not judge meaning.

For each answer and each cover-letter sentence that states a fact, trace it
to its source (master record, story bank, standing answer, or a dated user
confirmation in `## Fact Gaps`). No source is Critical.

## Re-review

Re-check only the previous findings and anything the fix changed. Do not
reopen settled items or add new style preferences; converge.

## Output

Return, for the caller to append to the application note under `## Review`
as `### Round N (YYYY-MM-DD)`:

- Verdict: `pass` (no Critical or High) or `blocked`.
- Findings: severity, location (file and section or line), evidence, and
  the concrete fix.
- Checks run with their outputs (exit codes, failures, preview path).

The `reviewer` role writes nothing in the workspace: its caller records the
review. Run directly in the user's session instead, that session appends the
review to the note itself.
