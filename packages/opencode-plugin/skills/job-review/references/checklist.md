# Materials Review Checklist

Work through every line. Severity defaults are in `SKILL.md` § Severity.

## Resume variant

- [ ] `compare_resume.py` exits 0, or every blocking item is explained by an
      approved change recorded in the application note.
- [ ] Name, contact, education, and certifications match the master.
- [ ] Every role keeps its employer, title, location, and dates.
- [ ] Frozen roles: technology line and duty set unchanged (order may differ).
- [ ] Each technology added to a flexible role existed during that role
      (`job-materials` `references/tech-release-dates.md`) and uses the name
      valid at the time (naming traps).
- [ ] No never-claimed skill anywhere, including the skills list.
- [ ] Every skills-list addition is backed by a role entry.
- [ ] Every number is in the master or the approved claims.
- [ ] No excluded topic, side project, or former employer's confidential
      product name.
- [ ] Summary leads with level and specialization; no personality adjectives;
      present tense only for the current role; "Present" for open ranges.
- [ ] Tailoring targets the role's top requirements (Medium if missed).
- [ ] `verify_pdf.py` passes; page count matches the checks file.
- [ ] Preview image: no overflow, no orphaned heading, no stray characters.
- [ ] PDF filename follows § Master Record's pattern and names the right role.

## Cover letter (if any)

- [ ] Addressed to the right company and role; date is today.
- [ ] Every factual sentence traces to the record or a dated confirmation.
- [ ] Gaps are stated honestly where the letter discusses requirements.
- [ ] Same excluded-topic, never-claimed, and number rules as the resume.
- [ ] Verifier passes with the `cover-letter` profile.

## Form answers

- [ ] Each answer has a source: standing, record, confirmed (dated), or
      drafted from the record.
- [ ] Authorization, sponsorship, and location answers are true for this
      country and match § Candidate exactly.
- [ ] Salary answers follow the § Standing Answers policy; any number not
      pre-approved is flagged as needing approval.
- [ ] Specialty tenure answers are not total tenure relabeled.
- [ ] Character limits respected; long answers read back in full.
- [ ] Demographic answers come only from § Standing Answers.
- [ ] Legal agreements or attestations are listed for explicit approval.

## Package

- [ ] Application note status is `draft` and its role facts match the lead.
- [ ] The requisition id and apply URL in the note match the posting.
- [ ] Open fact gaps are listed; none is silently filled.
