# ATS Form Traps

Field-tested failure modes when an agent fills applicant-tracking forms. Each
one has cost a real submission time or nearly sent a wrong answer.

## Any form

- **Read back, do not trust the write.** A field can display the typed value
  while the page's framework never registered it. Confirm each field from a
  fresh snapshot, and confirm the form shows no validation error, before the
  read-back summary.
- **Autocomplete fields** (location, school, employer) need a suggestion
  selected, not free text. Pick the entry that matches the contract's
  location exactly.
- **Character limits** are enforced silently by some forms (text cut off) and
  loudly by others. Count before pasting; read the stored value back in full.
- **Uploads:** use the file chooser with the exact absolute path of the
  approved PDF; confirm the filename (and size where shown) on the page. A
  form that parses the resume may overwrite fields you already filled;
  re-check them after upload.
- **"No AI responses" fields:** the user writes the substance. The agent may
  only transcribe or lightly join what the user supplied, with approval.
- **Demographic and self-identification questions:** use § Standing Answers
  only. Never infer.
- **Legal text** (arbitration, background-check consent, attestations,
  non-compete or AI-use pledges): open it, summarize it, and get the user's
  explicit approval before checking the box.
- **Several tabs open:** re-read the page URL and the role title immediately
  before the final click. A tab mix-up once nearly submitted the wrong form.
- **Double submission:** never click submit twice. After a timeout or error,
  look for a confirmation page or receipt email before any retry.

## Ashby

- React-controlled inputs ignore programmatic value setters: a field reads
  back correctly yet is reported missing on submit. Type with real
  keystrokes; clear first with select-all and delete.
- Yes/No buttons and radios can render selected without registering. Use a
  real click (or a snapshot-ref click) and confirm `aria-pressed` or
  `:checked` before moving on.
- Success shows on the same URL; capture the success text, then the receipt.

## Greenhouse

- Submission can fail with HTTP 428 (`captcha-failed`). Greenhouse then
  emails an 8-character code typed into eight auto-advancing boxes. Get the
  code as the § Integrations browser policy allows (from the candidate's
  mail, or from the user), type it with real keystrokes, and resubmit once.
- Embedded forms live in an iframe; open the hosted board or embed URL
  instead of scripting through the employer page.
- The confirmation URL ends in `/confirmation`; keep it as evidence.

## Lever

- One page with an "Additional information" box; the cover-letter-shaped
  box is optional unless marked required.
- Location and "current company" are often free text: use the contract
  wording exactly.

## Workday

- Usually requires creating an employer account: that is an approval item.
- A five-or-more-step typed flow, not a single upload. The resume parser
  garbles work history; re-enter each role and read every one back.
- Date spinbuttons may ignore typed digits after a parse; click the month
  and use the arrow keys, then read back.
- Per-row delete controls sit one level above the row heading; confirm which
  row disappears.
- Some employers cap the number of roles you may list; keep the most recent
  and say so in the application note.

## LinkedIn Easy Apply

- The modal lives in a shadow root: use role locators or snapshot refs, not
  document queries.
- Upload through the file chooser; confirm the attached resume is the
  approved variant, not a previously uploaded default.
- Prefilled answers from earlier applications may be stale; check each.
