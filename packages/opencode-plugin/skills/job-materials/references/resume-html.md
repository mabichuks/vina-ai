# Resume HTML Contract

The master resume's HTML render source and every variant share one structure
so tailoring edits stay mechanical and `job-review`'s
`compare_resume.py` can diff a variant against the master. A resume that
does not follow this contract still renders, but the comparison reports it
as unparseable and the reviewer must diff by hand.

## Required elements

| Element | Markup | Tailoring |
|---|---|---|
| Name | `<header><h1>` | never |
| Tagline | `<div class="tagline">` inside `<header>` | per role |
| Contact | `<div class="contact">` inside `<header>` | never, except location wording the user approved |
| Summary | `<p class="summary">` | per role, within the summary conventions |
| Highlights | `<ul class="highlights">` of `<li>` | per role, facts only |
| Skills | `<dl class="stack">` of `<dt>` category, `<dd>` list | order and emphasis; additions only if backed by a role |
| Roles | `<article class="role" data-employer="..." data-frozen="true|false">` inside `<section id="experience">` | see below |
| Education | `<section id="education">` | never |
| Certifications | `<section id="certifications">` | never |

Inside each role:

```html
<article class="role" data-employer="Northwind Traders" data-frozen="true">
  <div class="role-head">
    <h3 class="role-title">Staff Software Engineer</h3>
    <span class="co">Northwind Traders</span>
    <span class="loc">Austin, Texas</span>
    <span class="dates">Jan 2023 to Present</span>
  </div>
  <div class="tech">Java, Kotlin, PostgreSQL, Kafka, AWS</div>
  <ul class="duties">
    <li>...</li>
  </ul>
</article>
```

- `data-employer`, `.role-title`, `.co`, `.loc`, and `.dates` never change in
  a variant. Their text must match the master exactly.
- `data-frozen="true"` marks a role whose `.tech` line and duty set are
  frozen (usually the most recent roles). Duties may be reordered, never
  reworded, added, or removed.
- On a role with `data-frozen="false"`, the `.tech` line may be re-pointed to
  the target's technologies when every added technology existed during the
  role's dates (see `tech-release-dates.md`) and is not a never-claimed
  skill. Duties may be reordered; rewording is allowed only when the meaning
  and outcome stay the same.
- Variants keep the master's role count and order.

## Print setup

- `@page { size: letter; margin: ... }` (or `A4`), with screen styles that
  mirror the printed box.
- No external fonts or scripts: the renderer runs headless and offline.
- `print-color-adjust: exact` so rules and accents survive printing.
- Avoid page breaks inside a role (`break-inside: avoid`) unless a single
  role exceeds a page.
