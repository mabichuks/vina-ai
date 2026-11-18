# Interview Studio Data

The Interview Studio is an optional interactive companion to a prep note: one
tab per interview, a pitch timer, story cards, a practice drill, questions to
ask, logistics, and a checklist and notes that persist in the browser. It is
plain HTML, CSS, and JavaScript that opens from a `file://` URL with no build
step and no network requests.

## Create one

```text
python <skill-dir>/scripts/scaffold_studio.py "<interviews-dir>/<YYYY-MM-DD> Studio" --title "Interview prep, week of <date>" --tab <id>:<Company>[:<Role>] [--tab ...]
```

The destination must be empty or new and its parent must exist. The script
copies `index.html`, `styles.css`, and `app.js` from `assets/studio/`, writes a
`data.js` skeleton, and prints the `file://` URL to open. Keep the folder's
files together. Edit only `data.js`; the other three files are shared assets.

Values that still look like `<placeholder>` render with a hatched highlight so
an unfilled field is obvious. Replace or delete every one before relying on
the page.

## Schema

`data.js` assigns one object to `window.STUDIO`. It is JSON-compatible: keep
it valid JSON after the `window.STUDIO = ` prefix so it can be regenerated
and diffed. Every field except a tab's `id` and `company` is optional; a
missing or empty field hides its section.

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Masthead title and browser tab title. |
| `subtitle` | string | One line under the title: who, which interviews, when. |
| `storageKey` | string | `localStorage` key for checklists and notes. Use a new key per prep round so old progress does not carry over. |
| `tabs` | array | One object per interview, in date order. |

Each tab:

| Field | Type | Meaning |
|---|---|---|
| `id` | string, `[a-z0-9-]+`, unique | Hash route (`index.html#<id>`) and DOM id prefix. |
| `company` | string | Employer name as it appears in the application note. |
| `role` | string | Role title as posted. |
| `kicker` | string | Short label: number and interview type, for example `01 / Recruiter screen`. |
| `headline` | string | One-line theme for the conversation. |
| `summary` | string | What this interview assesses and what to show. |
| `session.when` | string | Day, date, and local start and end times. |
| `session.timezone` | string | IANA zone and abbreviation of the times shown, for example `America/Chicago (CST)`. Recompute after a DST change. |
| `session.format` | string | Interview type and medium. |
| `session.people` | string array | Interviewer names and titles, as given by the employer. |
| `session.join` | string | Meeting URL (http, https, or file only; others render as text). |
| `session.location` | string | Remote, phone (who calls whom), or the address and arrival note. |
| `facts` | `[label, value]` array | Positioning, prep time, the recorded band, and similar facts. |
| `pitch.text` | string | The opening pitch, written to be spoken. |
| `pitch.targetSeconds` | number | Rehearsal target for the timer. Default 90. |
| `mission` | `[title, text]` array | Two or three goals for this conversation. |
| `stories` | object array | See below. |
| `questions` | `[question, guide]` array | Likely questions with an answer guide, used by the practice drill. |
| `ask` | string array | Questions to ask them. |
| `logistics` | `[label, value]` array | Before, during, and after: links, documents to have open, compensation and availability policy. |
| `checks` | string array | Readiness checklist; progress persists in the browser. |
| `sources` | `[label, url]` array | Application note, posting, research; open in a new tab. |

Each story:

| Field | Meaning |
|---|---|
| `label` | Number and theme, for example `02 / Failure and recovery`. |
| `metric` | A short tag. Use an approved claim or a qualitative tag, never an invented number. |
| `title` | The story's name. |
| `text` | One or two sentences of what happened. |
| `guide` | How to tell it: problem, personal decision, tradeoff, supported outcome, lesson. |
| `probe` | The follow-up question it most likely draws. |
| `avoid` | The overclaim or trap to stay clear of. |

## Filling it from a prep note

- **One tab per interview**, ordered by date, even when two interviews are at
  the same company. Copy `session` facts from the verified calendar event and
  the application note, not from memory.
- **Stories come from the story bank** named in `JOBSEARCH.md` § Master
  Record. Choose the three to five that map to the posting's requirements and
  the interview format. Do not write a story the bank and master record do
  not support.
- **Never invent metrics.** `metric`, `facts`, and `pitch.text` use only
  approved claims from § Master Record. When no number is approved, use a
  qualitative tag.
- **Hypotheticals are framed as such.** Answer guides for design or scenario
  questions say "I would", never present a hypothetical as past work.
- **Flexed resume content is fair game.** If the submitted resume emphasized
  a technology on a flexible role, add a question that rehearses it.
- **Compensation and availability** point to the approved policy in
  § Standing Answers rather than restating a number in the page.
- **Respect employer rules**, for example a stated no-AI-tools policy during
  interviews, by noting it in `logistics`.
- The studio is a study aid. The prep note remains the record; the debrief
  goes in the application note, not the studio's browser-only notes.
