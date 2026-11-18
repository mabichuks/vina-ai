# Leads Note Format

Every sweep writes a **new** note named as `JOBSEARCH.md` § Workspace says
(default `Job Leads YYYY-MM-DD.md` at the workspace root). Never write to an
existing filename: a second sweep on the same day uses a descriptive suffix
(`Job Leads YYYY-MM-DD - <descriptor>.md`). Before writing, move the previous
root-level sweep, unchanged, into the leads folder. Worked example:
`examples/workspace/Job Leads 2026-10-20.md` in the harness repository.

```markdown
---
creation_date: YYYY-MM-DD
tags:
  - job-search
  - leads
status: active
---

# Job Leads, <Month D, YYYY>

<One paragraph: how many retained and added to [[Job Search Plan]] as Researching,
how many held and excluded, and the criteria applied (floor, location policy,
any decision that changed them).>

## Retained

### <Company>: <Role>

- **Published:** <date>, <date basis: Greenhouse first_published, Ashby publishedAt, Lever createdAt, or employer page>. <Req id.> <Repost note if a board shows a newer date.>
- **Location:** <as posted>. <Evidence of eligibility.>
- **Pay:** "<verbatim>". <Currency only if stated.> <Clears the floor, offer-dependent, or unpublished.>
- **Apply:** <employer URL>
- **Fit:** <requirements that map to the record>.
- **Gaps:** <requirements not in the record, stated honestly; gates such as a preferred never-claimed skill>.
- **History:** <never approached, or the pipeline or closed-index entry and why it does not apply>.

## Holds

- **<Company>: <Role>.** <What is unknown.> **Resolves when** <evidence that would settle it>. <URL>

## Exclusions

- **<Company>: <Role>.** <Fact.> Excluded by <the rule: knockout, location policy, company history, floor>.

## Coverage And Evidence

- <What was read first: pipeline, closed index, previous sweep, log tail.>
- <Email review window and outcome, or that it was skipped and why.>
- <Sweep command, boards attempted, succeeded, errored; raw matches and in-window counts labeled as discovery counts; output folder.>
- <Overlapping board lists are not summed as unique employers.>
- <Signed-in boards read, with sign-in confirmed first; inbox views read.>
- <Not covered: sources that could not be reached.>

## Log

- **YYYY-MM-DD:** <rows added, previous sweep moved>. Newest first.
```

## Rules

- Order retained leads by the order the user asked for (default: fit, then
  freshness); say which.
- Quote pay verbatim, but write ranges with "to" when the workspace forbids
  dashes, and never convert or name a currency the posting does not state.
- Errors are coverage gaps, not evidence that a board has no openings.
- Later application events for a lead are appended to this note's log; the
  body is not rewritten.
