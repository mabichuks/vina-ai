# Mail Queries

Gmail search syntax; adapt the operators for another provider. Run several
targeted queries over the window rather than one broad term, fetch headers
and snippets first, and pull full bodies only when a snippet is ambiguous.

`<date>` is the window start as `YYYY/MM/DD`. `-in:chats` drops chat noise.
Employer mail often lands in an updates or promotions category, so do not
restrict the search to the primary inbox. Check spam once per review.

## Outcomes

```text
(unfortunately OR "not moving forward" OR "not to move forward" OR "move forward with other" OR "other candidates" OR "unable to move forward" OR "we regret" OR "not selected" OR "position has been filled" OR "no longer hiring" OR "decided to pursue") after:<date> -in:chats
```

## ATS senders

```text
from:(greenhouse.io OR greenhouse-mail.io OR ashbyhq.com OR hire.lever.co OR lever.co OR myworkday.com OR workday.com OR smartrecruiters.com OR icims.com OR workable.com OR eightfold.ai OR teamtailor.com OR dayforcehcm.com) after:<date> -in:chats
```

Employers also send from their own domains (for example `gh-mail.<company>.com`
or `careers@<company>.com`); add the domains of open applications.

## Interviews and scheduling

```text
(interview OR "phone screen" OR "next steps" OR schedule OR availability OR "book a time" OR calendly OR "assessment" OR "take-home" OR karat OR hackerrank OR codesignal) after:<date> -in:chats
```

## Per open application

```text
(<company> OR subject:<company>) after:<date> -in:chats
```

This catches a template rejection no keyword matched. Run it for every
company with a live application.

## Recruiters

```text
(recruiter OR "talent acquisition" OR "came across your profile" OR opportunity OR "open to") after:<date> -in:chats -category:promotions
```

## Noise to ignore

Job-board digests, newsletters, marketing, premium-subscription mail, and
"jobs you may like" alerts. They never change a stage.
