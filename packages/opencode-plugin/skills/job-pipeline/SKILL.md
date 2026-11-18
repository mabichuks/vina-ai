---
name: job-pipeline
description: Report the job pipeline's state, find stale or inconsistent records, and archive closed opportunities. Use for a pipeline review, status update, follow-up check, or archiving closed applications.
---

# Job Pipeline

Owner of § Recording Changes: every skill that changes a stage, a note
status, or a log follows it.

Facts from `JOBSEARCH.md` (the path given; else the working directory or its
nearest ancestor; else `AGENTS.md` § Job Search): **§ Harness Conventions**,
**§ Workspace**, **§ Pipeline**. Missing or placeholder section: name it and
stop.

## Recording Changes

- **Pipeline row.** Change `Stage` only on evidence. Lead `Next Step` with a
  bold dated event (for example `**Rejected 2026-10-22.**`), then the new
  next action, then `Original:` and the prior text. Never delete history.
  Link the application note.
- **Application note.** Set `status:` to the mapped value from § Pipeline and
  add a dated `## Log` line naming the evidence (sender, subject, message id,
  confirmation text, or "user statement").
- **Plan log.** One `### YYYY-MM-DD (<event>)` entry per session of changes,
  in the § Workspace log order: what changed and why, each item linked, then
  one line of counts by stage computed from the table, never hand-tallied.
- **Closing.** Allowed only on an explicit rejection, a filled or withdrawn
  notice, or a user decision. Record which, with the date and evidence, and
  quote no reason that was not given. A requisition that vanished from the
  board is "likely closed, no email yet", not Closed. Never reopen a closed
  row from a stale message; a genuinely new opportunity is a new row.
- **Several applications at one company.** Attribute a message by subject
  line, requisition id, or which requisition left the board; record how it
  was attributed. If it cannot be attributed, say so in both rows.
- **New files.** Never write to an existing dated filename; frontmatter and
  link style per § Workspace; targeted edits only.

## Review

1. Read the pipeline table, closed index, open application notes, upcoming
   interviews, and the plan log tail.
2. **Counts** by stage, computed from the table.
3. **Upcoming:** interviews and calls with local times and prep status.
4. **Awaiting response:** applied rows with days since applying. Silence is
   not a signal; list long-silent rows as follow-up candidates only.
5. **Follow-ups:** unanswered recruiter threads and promised replies
   (drafts go through `job-inbox` § Reply).
6. **Holds:** researching rows waiting on a fact, and the fact.
7. **Consistency:** stage versus note `status:` mismatches, applied rows
   without confirmation evidence, broken links, rows missing from either
   file, an open `Screen`, `Interview` or `Onsite` row whose date has no
   matching calendar event, and tasks overdue in `## Tasks`.
8. **Harness feedback:** recurring review findings, form traps, or evidence
   gaps worth an amendment to `JOBSEARCH.md`, the tailoring rules, or a
   skill. Propose; never apply silently.

Fix only mechanical inconsistencies the evidence settles (for example a
status lagging a recorded confirmation), and list each fix.

## Archive

Only when the user asks or confirms. Move closed rows into the closed index
with their full record, and move each closed role's dedicated folder into the
archive folder. Keep shared materials at a company that still has a live
role. Update links, log the archive with counts moved, and never delete a
note or attachment.

## Report

Counts, upcoming events, awaiting response with ages, follow-up candidates,
holds, inconsistencies fixed and outstanding, archive results, and proposed
harness amendments.
