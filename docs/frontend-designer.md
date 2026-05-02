# Frontend Design — `packages/web`

React 18 + Vite + TypeScript + TailwindCSS + shadcn/ui. Served as static files by the Fastify server.

## 1. Folder Layout

```
packages/web/
├── src/
│   ├── main.tsx                 # Vite entrypoint
│   ├── App.tsx                  # Router + global providers
│   ├── routes/                  # one folder per route, each exports a default component
│   │   ├── onboarding/
│   │   ├── dashboard/
│   │   ├── jobs/
│   │   ├── applications/
│   │   ├── ready-to-apply/
│   │   ├── alerts/
│   │   ├── chat/
│   │   ├── settings/
│   │   └── profile/
│   ├── components/
│   │   ├── ui/                  # shadcn/ui generated components
│   │   ├── layout/              # AppShell, Sidebar, Topbar
│   │   ├── jobs/
│   │   ├── applications/
│   │   ├── ready-to-apply/
│   │   ├── alerts/
│   │   ├── chat/
│   │   └── shared/              # MatchScore, EmptyState, ConfirmDialog, etc.
│   ├── api/
│   │   ├── client.ts            # fetch wrapper with bearer token
│   │   ├── ws.ts                # WebSocket hook
│   │   └── hooks/               # one hook per resource: useProfile, useJobs, useReadyToApply, ...
│   ├── store/
│   │   ├── ui-store.ts          # Zustand: sidebar collapsed, active filters, toasts
│   │   └── auth-store.ts        # bearer token in memory
│   ├── lib/
│   │   ├── format.ts            # date, money, etc.
│   │   ├── score.ts             # match-score colour scales
│   │   └── routes.ts            # path constants
│   └── styles/
│       └── globals.css
├── index.html
├── tailwind.config.ts
└── vite.config.ts
```

## 2. Routing

Use `react-router-dom`. Top-level routes:

| Path                | Page                        | Notes                                                  |
| ------------------- | --------------------------- | ------------------------------------------------------ |
| `/onboarding/*`     | OnboardingWizard            | Shown when `onboarded === false` from `/api/bootstrap` |
| `/`                 | Dashboard                   |                                                        |
| `/jobs`             | Jobs list                   | Filterable by source, apply method                     |
| `/jobs/:id`         | Job detail                  | Drawer or full page                                    |
| `/applications`     | Applications list           |                                                        |
| `/applications/:id` | Application detail          | Includes timeline, tailored CV viewer                  |
| `/ready-to-apply`   | Ready to Apply list         | All manual-apply applications awaiting user submission |
| `/alerts`           | Alerts                      |                                                        |
| `/chat`             | Chatbot                     |                                                        |
| `/profile`          | Profile, CVs, cover letters |                                                        |
| `/settings`         | Settings                    |                                                        |

The chatbot is also accessible as a slide-over panel on every page (a bottom-right floating button).

## 3. Layout

```
┌─────────────────────────────────────────────────────────┐
│  Topbar: vina · status indicator · pause toggle · [chat] │
├──────────┬──────────────────────────────────────────────┤
│ Sidebar  │                                              │
│ Dashboard │                                            │
│ Jobs     │                                              │
│ Apps     │             Page content                     │
│ Ready    │                                              │
│ Alerts   │                                              │
│ Profile  │                                              │
│ Settings │                                              │
│          │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- The status indicator is green when the scheduler is running, amber when paused, red when there's a system error
- The pause toggle calls `POST /api/system/pause` or `/resume`
- The alerts nav item shows a badge with the count of open `action_required` alerts
- The "Ready" nav item shows a badge with the count of `ready_for_manual_apply` applications

## 4. State Management

Two layers:

1. **Server state** via TanStack Query
   - One hook per resource: `useProfile`, `useJobs(filters)`, `useApplication(id)`, `useReadyToApply`, `useAlerts(filter)`, `useChatMessages`, `useSettings`, `useSites`, `useLLMProviders`
   - Mutations for writes: `useCreateProfile`, `useApproveApplication`, `useMarkApplied`, `useResolveAlert`, etc.
   - Query keys are stable arrays: `['jobs', filters]`. Mutations invalidate or optimistic-update relevant keys
   - WebSocket events trigger targeted invalidations: `application:updated` invalidates `['application', id]` and `['applications']`; `application:ready_for_manual_apply` additionally invalidates `['ready-to-apply']`; `application:applied_manually` invalidates the same plus `['applications']`

2. **UI state** via Zustand
   - Sidebar collapsed
   - Toast queue
   - Active filter state for jobs/applications lists (preserved across navigation)
   - The chat slide-over open/closed
   - Bearer token (kept in memory only — never persisted)

## 5. WebSocket Integration

A single WebSocket connection lives at app level:

```ts
const ws = useWebSocket(token);
useEffect(() => {
  const off = ws.subscribe('application:updated', (p) => {
    queryClient.invalidateQueries({ queryKey: ['application', p.id] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
  });
  const off2 = ws.subscribe('application:ready_for_manual_apply', (p) => {
    queryClient.invalidateQueries({ queryKey: ['ready-to-apply'] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
    toast({
      title: 'Ready to apply',
      description: `${p.title} at ${p.company} is ready for you to apply manually.`,
    });
  });
  return () => {
    off();
    off2();
  };
}, []);
```

Reconnect on close with exponential backoff up to 30s. Show a small banner if disconnected for more than 5s.

## 6. Onboarding Wizard

Steps, each as a separate route under `/onboarding/`:

1. **Welcome** — what Vina does, privacy posture, "Get started"
2. **Profile** — name, email, phone, location (only required fields gating progression: name + email)
3. **LLM Provider** — pick Anthropic / OpenAI / Ollama → enter model + key (or base URL for Ollama). Validation call before progressing
4. **Upload CV** — required; one CV minimum, can label
5. **Cover Letter** — optional, can skip
6. **Search Preferences** — prose description + structured fields
7. **Sources** — toggle LinkedIn, Indeed, and Google Jobs:
   - For LinkedIn / Indeed: a "Log in" button that:
     - Calls `POST /api/sites/:id/login`
     - Subscribes to `site:login_status`
     - Shows a "browser window opened — please log in" message
     - Marks complete when status is `completed`
   - For Google Jobs: an inline SerpAPI key input field with a "Validate" button that calls `POST /api/sites/google/test`. Includes a small explainer link about what SerpAPI is and where to get a key (with mention of the free tier)
8. **Schedule** — pick frequency (every 6h / 12h / 24h / custom cron)
9. **Mode** — autonomous vs supervised; auto-apply vs review-first
10. **Done** — "you're all set; first search will run at <time>"

The wizard saves progress so the user can drop out and resume. A header progress bar shows step N of 10.

## 7. Page Designs

### 7.1 Dashboard

- Four stat cards: Jobs Found (week), Applications Submitted (auto, week), Applied Manually (week), Awaiting Action
- Activity timeline: most recent application events, newest first
- Quick actions: "Search now", "Pause/Resume scheduler"
- A "Ready to Apply" preview card: count + top 3, with a link to the full list

### 7.2 Jobs

- Filter row: source multiselect (LinkedIn / Indeed / Google Jobs), apply method (auto / manual), status multiselect, score slider (min), search input
- Sort dropdown: newest, score desc, score asc
- Table columns: Title, Company, Location, Source, Apply method (chip: "Auto" or "Manual"), Score (colored chip), Status, Action
- Manual-apply rows include the original source label (e.g. "Google · via Greenhouse") in the Source column
- In supervised mode each row has an "Apply" button — for auto rows it triggers an apply task, for manual rows it triggers a `prepare_manual_apply` task
- Clicking a row opens the detail drawer with full description, match justification, and an "Apply" button (if applicable)

### 7.3 Applications

- Filter row: status multiselect (including `ready_for_manual_apply` and `applied_manually`), source multiselect, apply method
- Table columns: Job, Company, Source, Apply method, Status (chip), CV used, Started, Submitted / Applied
- Row click opens the detail page

#### Application detail

- Header: job title, company, link out (= `external_apply_url` for manual, `url` for auto), status chip, action buttons (Approve / Reject / Retry / Cancel / Mark applied based on state)
- Tabs: **Overview**, **Tailored CV**, **Tailored cover letter** (if any), **Timeline**, **Source**
- Tailored CV tab embeds a DOCX preview (via `mammoth` to render to HTML)
- Timeline lists each `application_event` with icons, timestamps, and screenshots inline when present
- For manual-apply applications the action area surfaces:
  - Download CV button
  - Download cover letter button (if present)
  - Open external apply page button (opens `external_apply_url` in a new tab)
  - **Mark as applied** button with optional notes textarea

### 7.4 Ready to Apply

A dedicated page focused on manual-apply applications awaiting user action.

- Single column of cards, newest first
- Each card shows:
  - Title, company, location, source label ("Google · via Greenhouse", or "LinkedIn · external", etc.)
  - Match score chip and one-line justification
  - Three action buttons in a row: **Download CV** · **Download cover letter** (greyed if none) · **Open apply page** (external link)
  - A primary **Mark as applied** button at the bottom, with an optional notes field that opens on click
  - A secondary **Skip** action which calls `POST /api/applications/:id/cancel`
- Empty state: editorial Fraunces line — "Nothing waiting on you. Vina will surface manual applications here as it prepares them."

This page is a denormalised view of `applications` filtered to `status='ready_for_manual_apply'`. It's distinct from the Applications page because its tone is action-oriented rather than reference-oriented.

### 7.5 Alerts

- Single column list, severity-colored
- Each row has the title, description, source (job/application/site), and an inline action area appropriate to the kind:
  - `missing_field` → text input with the prompt as label, plus "Save for future" checkbox, plus "Resolve"
  - `captcha` → "I solved it" button + "Cancel application" button
  - `awaiting_approval` → buttons: Approve, Reject (with optional instruction text area), View tailored CV
  - `session_expired` → "Log in again" button (calls site login flow)
  - `apply_failed` → "Retry" / "Dismiss"
  - `ready_for_manual_apply` → "Open apply page" button + "Mark as applied" button + a link to the full Ready to Apply card
- Filter tabs: All, Action required, Info, Resolved

### 7.6 Chat

- Standard chat layout
- Streaming assistant output (typewriter) via `chat:token` WS events
- Open alerts pinned at the top of the conversation as inline cards the user can interact with — including `ready_for_manual_apply` cards that expose the same action buttons as the Ready to Apply page
- A "Pause everything" / "Resume" command shortcut bar at the bottom
- Input box with Cmd/Ctrl+Enter to send

### 7.7 Profile

- Three sub-sections (tabs or stacked):
  - Identity (single form)
  - CVs (list with default toggle, label, download, delete)
  - Cover letters (same shape)
- A "Saved answers" section below shows `profile_answers` rows; each editable and deletable

### 7.8 Settings

- Mode and approval radios
- Schedule editor (cron field + presets)
- Active LLM provider with switcher
- **SerpAPI configuration** — input field with masked display, "Test" button (calls `POST /api/sites/google/test`), "Clear key" button (calls `DELETE /api/settings/serpapi-key`). Toggle for enabling/disabling Google Jobs source
- Sources status with "Log in again" / "Sign out" per browser-kind site
- Browser visibility toggle
- Danger zone: Export data, Reset all data

## 8. Component Conventions

- All shadcn/ui primitives live under `components/ui/`
- Domain components (e.g. `JobCard`, `ApplicationStatusChip`, `MatchScore`, `ApplyMethodChip`, `SourceLabel`) live in `components/<domain>/`
- Forms use `react-hook-form` with zod resolvers — same schemas as the server, imported from `@vina/shared`
- Toasts via shadcn's `useToast` — server errors automatically toast via the API client's interceptor

## 9. Design Tokens

The visual design system — colours, typography, spacing, motion — is fully specified in [`docs/theme.md`](./theme.md). That file is the source of truth. The Tailwind config maps every token to a utility class so components consume them as `bg-surface-base`, `text-ink-primary`, `font-display`, etc. **No hardcoded hex values, no inline colours, no ad-hoc spacing in components.**

Match-score colour mapping (per `theme.md`):

- `< 50` → `--color-danger`
- `50–69` → `--color-warning`
- `70–84` → `--color-success`
- `85+` → `--color-accent` (only score range that uses the signature accent)

Apply method chip colouring:

- `auto` → uses `--color-success-soft` background with `--color-success` text
- `manual` → uses `--color-info-soft` background with `--color-info` text

Dark mode is supported via the `[data-theme="dark"]` selector and a topbar toggle; persistence in `ui-store`.

## 10. Accessibility

- All interactive elements keyboard-reachable
- shadcn/ui primitives are already accessible — preserve their `aria-` props
- Match score chips have an `aria-label` like "Match score 82 out of 100"
- Apply method chips have `aria-label` like "Auto-apply" or "Manual apply"
- Toasts have `role="status"`
- Modals trap focus

## 11. Error and Loading States

- Every list page: skeleton rows while loading, empty state with a helpful CTA when empty
- Every detail page: skeleton header + content
- Mutation errors surface as toasts with the server's `message` and a "Retry" action where applicable
- Network down: a global banner appears

## 12. Build

- `vite build` produces static files into `packages/server/public/`
- The server serves them via `@fastify/static` with index fallback to `index.html` for client-side routing

## 13. Testing

- Component tests with Vitest + React Testing Library
- A small set of Playwright tests in `tests/e2e/web/` driving the UI against a fully running server with a temp database
- Specifically test the Ready to Apply page: card renders, mark-as-applied flow, external link opens correctly

## 14. Bundle Size Discipline

- No moment.js (use `date-fns`)
- No lodash (use native or specific `lodash-es` imports)
- DOCX preview via `mammoth` is heavy (~1MB) — lazy-load only on the tailored-CV tab
- Split each top-level route via `React.lazy`
