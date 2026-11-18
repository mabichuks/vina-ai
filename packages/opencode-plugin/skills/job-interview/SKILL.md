---
name: job-interview
description: Prepare for an interview stage with a grounded prep note (pitch, stories mapped to the role, technical lens, practice questions, logistics) and an optional studio page, or debrief one afterward into the record and story bank. Use to prep for an interview, screen, or assessment, or after one.
---

# Job Interview

Ground everything in the record. Prep that invents experience fails in the
room, and it can contradict what the application already claimed. Stage
changes follow `job-pipeline` § Recording Changes; any message follows
`job-inbox` § Drafting Rules and is sent only on approval.

Facts from `JOBSEARCH.md` (the path given; else the working directory or its
nearest ancestor; else `AGENTS.md` § Job Search): **§ Harness Conventions**,
**§ Candidate**, **§ Search Criteria**, **§ Workspace**, **§ Master Record**,
**§ Standing Answers**, **§ Integrations** (diagrams), **§ Approvals**.
Missing or placeholder section: name it and stop.

Modes: **Prep** before a stage; **Debrief** after one, or after a feedback
call.

## Prep

1. **Gather.** The application note (role, materials as submitted, form
   answers, earlier `## Interviews` entries), the job description, and the
   resume variant actually sent: prep must match what the employer has
   read. The tailoring rules' per-role liberties (technologies added to
   flexible roles are fair game for questions; prepare to discuss each
   concretely). Session facts from the note or invite: stage, format,
   platform, length, interviewers and their roles, and any rule the employer
   set (for example no AI tools, or what the assessment measures).
2. **Research.** Reuse the company research note or create one from
   `references/company-research.md`, dated, with sources; mark third-party
   data as indicative, never as confirmed.
3. **Write the prep note** from `references/prep-note.md` in the interviews
   folder:
   - **Opening:** a pitch under 90 seconds: level and specialization, two
     strongest relevant stories by name, and why this role.
   - **Stories:** three to five from the story bank, each mapped to a stated
     requirement. Shape: problem, personal decision, tradeoff, supported
     outcome, lesson; about two minutes. For each, a *probe* (the follow-up
     to expect) and an *avoid* (the overclaim to steer clear of). Outcomes
     and numbers only from approved claims.
   - **Technical lens:** the topics this stage tests, with precise answers to
     likely scenarios. Hypotheticals are framed "I would", never as past
     work; state guarantees exactly (what a system does and does not
     promise).
   - **Practice questions** with answer guides, including the role-specific
     "why us", "why this level", and the § Candidate answer for why the last
     role ended.
   - **Questions to ask** that decide fit (scope, first six months, team, the
     process ahead).
   - **Logistics and compensation:** local time and offset, link or address,
     people, the published band as recorded, and the § Standing Answers
     salary policy. No figure beyond the policy without the user's approval.
   - **Checklist:** rehearsal and setup items.
4. **Diagrams.** When a technical-lens topic is clearer as a picture (a retry
   and its idempotency key, a migration's cutover, a system's context), draw
   it with the § Integrations diagram servers; with `none`, describe it in
   prose. Sequence, state, and activity diagrams use PlantUML
   (`curl -X POST --data-binary "@<name>.puml" <plantuml-server>/svg -o <name>.svg`);
   architecture diagrams use draw.io with plain-text labels (`html=0`),
   exported as SVG from the configured editor. Save each source beside its
   `.svg` in the interviews folder and embed the SVG in the prep note. Label
   hypothetical designs as such; never present one as an employer's real
   architecture.
5. **Studio** (optional). For an interactive page, scaffold one and fill its
   `data.js` from the prep note (schema and filling rules in
   `references/studio-data.md`), then open the printed `file://` URL. Leave
   no `<placeholder>` values.

   ```text
   python <skill-dir>/scripts/scaffold_studio.py "<interviews-folder>/<YYYY-MM-DD> Studio" --title "<title>" --tab <id>:<Company>[:<Role>]
   ```

## Debrief

1. **Capture.** Ask the user, in one message, for anything not yet said:
   date, stage, format, and people (names and roles as introduced);
   questions asked, as close to the wording as remembered; what landed, what
   went poorly, and what they would answer differently; commitments by
   either side; compensation or logistics discussed, quoted exactly; and
   stated next steps and timeline. For a rejection feedback call, record the
   feedback in the giver's words and never infer an unstated reason.
2. **Record.** Add `### YYYY-MM-DD <stage>` under the application note's
   `## Interviews` with the captured items. Update the pipeline row's Next
   Step (and the stage only on evidence, such as an invitation to the next
   round), log it, and turn commitments into `## Tasks` items with dates.
3. **Learn.** Propose new stories, sharper versions of ones that landed, and
   notes on probes that caught the user out; write them to the story bank
   only with approval, and facts in a story still need a source. A question
   type or gap that recurs across interviews becomes a proposed prep-note
   addition, tailoring-rule note, or § Standing Answers entry.
4. **Follow-up.** Draft a thank-you or follow-up only if the user wants one,
   specific to what was discussed, through `job-inbox` § Reply.

## Report

Prep: note and studio paths, stories chosen with the requirement each
covers, liberties the user should be ready to discuss, open questions for
the user, and logistics as verified. Debrief: what was recorded and where,
stage or next-step changes, tasks created, proposed story-bank and harness
updates, and any draft awaiting approval.
