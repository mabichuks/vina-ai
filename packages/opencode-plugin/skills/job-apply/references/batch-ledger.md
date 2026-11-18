# Batch Ledger Format

One ledger per batch, in the folder `JOBSEARCH.md` § Workspace names
(default `Batches/Application Batch YYYY-MM-DD.md`). The ledger records the
user's authorization once, the decisions made along the way, and one row per
role. Per-role detail stays in each application note. Worked example:
`examples/workspace/Batches/Application Batch 2026-10-15.md` in the harness
repository.

```markdown
---
creation_date: YYYY-MM-DD
tags:
  - job-search
  - application-batch
status: active
---

# Application Batch, <Month D, YYYY>

**Outcome:** <filled in when the batch closes: prepared, submitted, held>.

## Authorization

- **<User>, YYYY-MM-DD HH:MM <zone>:** "<the user's exact words>".
- **Scope:** <every role by company and title; nothing else is covered>.
- **Overrides:** <for example several roles at one company despite the company history rule, or "none">.
- **Submission pre-authorized:** <yes or no; if yes, the exact conditions, for example "after review passes and the user has seen the summary table">. Legal agreements, new facts, and unanswered form questions always go back to the user.

## Decisions Confirmed

- **<Topic>:** <decision, who made it, when>. <For example an approved salary figure for this batch only, or an agreement the user read and accepted.>

## Submission Ledger

| Company | Role | Note | Status | Confirmation |
| --- | --- | --- | --- | --- |
| <Company> | <Role> | [[<Company> <Short Role> Application]] | Preparing / Ready / Held / Submitted | <success page and receipt id with time> |

## Verification

- <Materials: page counts, unique hashes, preview sheets, compare results.>
- <Reviews: each passed in a fresh context; findings fixed.>
- <Live postings rechecked on the submission date.>
- <Submissions ran one at a time in the single browser session.>

## Next Step

- <What remains, and any later status updates appended with their date.>
```

## Rules

- Write the Authorization section before any preparation starts, quoting the
  user; never paraphrase scope wider than the user's words.
- `status:` is `active` while any row is not Submitted or Held, then
  `completed`.
- Status values in the table: `Preparing`, `Ready` (review passed), `Held`
  (with the reason in Decisions Confirmed), `Submitted` (confirmation
  recorded).
