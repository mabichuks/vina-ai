# Application Note Format

One note per role, in the folder `JOBSEARCH.md` § Workspace names (default
`Applications/<Company>/<Role>/<Company> <Short Role> Application.md`). The
note is the role's full record; the pipeline row is its one-line summary and
must agree with it. Worked example: `examples/workspace/Applications/Litware/`
in the harness repository.

```markdown
---
creation_date: YYYY-MM-DD
tags:
  - job-search
  - application
status: draft
---

# <Company> <Short Role> Application

## Role

- **<Exact title>**, <ATS> req <id>.
- **Location:** <as posted>. Evidence: <posting or form text that proves eligibility>.
- **Pay:** "<verbatim>". <Currency only if stated. Floor verdict: clears, offer-dependent, or unpublished.>
- **Apply:** <URL>
- **Source:** [[Job Leads YYYY-MM-DD]]; pipeline: [[Job Search Plan]].
- **JD summary:** <responsibilities, required and preferred skills, stated interview or AI-use rules>.

## Fit And Gaps

- **Fit:** <requirement> maps to <record evidence>.
- **Gap:** <requirement> is not in the record; <how it will be handled honestly>.

## Materials

- `Resume - <Company> <Short Role>.html`, tailored from the master.
- `<PDF name>`: **N pages**; verify_pdf result; preview inspected.
- PDF SHA-256: `<hash>`.
- **Focus:** <what was foregrounded>.
- **Liberties applied:** <additions to flexible roles, or "none">.
- Cover letter: <file, or "none" and why>.

## Form Answers

| Field | Answer | Source |
| --- | --- | --- |
| <field as labeled on the form> | <exact answer> | standing / record / confirmed YYYY-MM-DD / drafted |

## Fact Gaps

- **Open (YYYY-MM-DD):** <question for the user>.
- **Resolved YYYY-MM-DD:** <question>. <User's answer, and where it was recorded for reuse>.

## Review

### Round 1 (YYYY-MM-DD)

**Verdict: pass | blocked.**

- **Critical | High | Medium | Low:** <finding, evidence, fix>.

## Confirmation

- **Submitted YYYY-MM-DD at HH:MM <zone>.**
- **Authorization:** <who, when, exact words or batch ledger link>.
- <What was re-read before the click.>
- **Confirmation page:** "<verbatim text>". URL `<url>`.
- **Receipt:** "<subject>", from <sender>, <time>, message `<id>`.

## Interviews

### YYYY-MM-DD <Stage>

- **People:** <names and roles>.
- **Questions asked:** <list>.
- **Went well:** <...>.
- **To improve:** <...>.
- **Commitments:** <anything said about availability, other processes, or pay>.
- **Next steps:** <...>.

## Log

- **YYYY-MM-DD:** <event>. Newest first.
```

## Rules

- **Source column:** `standing` (from § Standing Answers), `record` (master
  resume or story bank), `confirmed YYYY-MM-DD` (the user confirmed it for
  this role), or `drafted` (written by the agent, not yet confirmed; a
  drafted answer blocks submission).
- Write answers exactly as they will be entered, with the character count
  when the field has a limit.
- `status:` moves `draft` (preparing) to `ready` (review passed) to `applied`
  (confirmation recorded), then follows the pipeline stage.
- Review rounds are appended, never rewritten; the reviewer's findings are
  recorded by the caller, since the reviewer role does not edit.
- `## Confirmation` is filled only from evidence on screen and in the
  mailbox; a submission without a recorded confirmation is not Applied.
