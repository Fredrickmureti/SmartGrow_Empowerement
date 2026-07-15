
## Part 1 — Why /demo is empty for logged-out visitors

The RLS policy on `platform_demo_videos` is correct (`is_published = true` for everyone), but the table has **zero GRANTs**. Supabase's Data API needs an explicit `GRANT SELECT` to the `anon` role or the request 401s before RLS even runs. That's exactly what the network log shows:

```
GET /rest/v1/platform_demo_videos?is_published=eq.true → 401
"permission denied for function is_platform_admin"
```

(The error text is misleading — the real cause is missing table-level grants; PostgREST surfaces the first permission failure it hits while resolving the policy chain.)

**Fix (migration):**

```sql
GRANT SELECT ON public.platform_demo_videos TO anon;
GRANT SELECT ON public.platform_demo_videos TO authenticated;
GRANT ALL   ON public.platform_demo_videos TO service_role;
```

That's it — the existing "Anyone can view published demo videos" policy will then work for signed-out visitors.

---

## Part 2 — Enterprise pattern for in-app learning resources

### How big platforms handle this
- **Stripe / Linear / Notion / Intercom** all ship a persistent **Help / Resources launcher** — usually a `?` button in the top bar, opening a slide-over panel. Never a nav item screaming "TUTORIALS" in the sidebar.
- Content is **categorized by product area** (in our case: by app — Sales, POS, Payroll, Inventory…), plus a "Getting started" track.
- **Contextual surfacing:** when the user is inside an app, the panel pre-filters to that app's videos. When on the dashboard, it shows the "Getting started" track.
- A **dedicated `/resources` page** exists for deep browsing (search, filters, full library) — the launcher is the fast path, `/resources` is the library.
- Public marketing page (`/demo`) reuses the **same content** but only the videos flagged for public visibility.

### What we build

**1. Data model — light additions to `platform_demo_videos`**
   - `app_key text` — which app the video belongs to (`"sales"`, `"pos"`, `"payroll"`, `null` for platform-wide/getting-started).
   - `audience text` (default `'public'`) — `'public' | 'authenticated'`. Public videos show on `/demo` and in-app; authenticated-only videos show only in-app.
   - `difficulty text` — `'intro' | 'deep-dive'` (optional, nice-to-have for tracks).
   - Keep existing `category` for cross-cutting tags (e.g. "Setup", "Reporting").

**2. New surfaces**
   - **`ResourceCenterLauncher`** — global `?` button injected into `PlatformShell` topbar. Opens a `Sheet` (right side, 480px), reuses `DetailSheet` primitive for consistency.
     - Header: search input + app filter chips
     - Body: grouped list (Getting started, then per current-app videos, then everything else), each row is a thumbnail + title + duration
     - Footer: link to `/resources`
   - **`/resources` page** — full library, routed under the dashboard workspace. Uses `PageHeader` + `PageBody`, grid of video cards grouped by app, search, filter by app/difficulty.
   - **`/resources/:id`** — single-video player page with description, related videos, "mark as watched" (localStorage, no schema needed for v1).
   - **Contextual hook** on empty states: existing `EmptyState` gets an optional "Watch a quick tour" action that deep-links into the launcher pre-filtered.

**3. Public `/demo` page**
   - Same source of truth, but query is `is_published = true AND audience = 'public'`.
   - After the grant fix, this works for anon.

**4. Platform admin uploader upgrades** (`/admin-management/…` — wherever demo videos are managed today)
   - Add fields to the upload form for the new columns: **App**, **Audience**, **Difficulty**, keep **Category** and **Sort order**.
   - Enforce a **thumbnail** (required) and **duration** (auto-detected from the uploaded MP4 via `<video>.duration` in the browser, or a manual override). No more untitled thumbnailless entries — they look unprofessional in the launcher.
   - Add a **preview** panel in the admin form showing exactly how the card will render in the launcher and on `/demo`, so admins publish with confidence.

**5. Not doing in this pass** (call out so we agree)
   - Progress tracking per user in the DB (localStorage is enough for v1).
   - Learning paths / course sequencing (we already have `training_courses` for formal L&D — resource center is for lightweight product tours).
   - i18n of video captions.

### Technical section

```text
src/
  features/resources/
    ResourceCenterLauncher.tsx      # ? button + Sheet
    ResourceCenterPanel.tsx         # inner content, shared with /resources
    useDemoVideos.ts                # react-query hook, filters by audience/app
    videoCard.tsx
  pages/resources/
    ResourcesIndex.tsx              # /resources
    ResourceDetail.tsx              # /resources/:id
  apps/platform-admin/…             # add fields to existing demo video form
```

Migration:
```sql
ALTER TABLE public.platform_demo_videos
  ADD COLUMN IF NOT EXISTS app_key   text,
  ADD COLUMN IF NOT EXISTS audience  text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS difficulty text;

GRANT SELECT ON public.platform_demo_videos TO anon;
GRANT SELECT ON public.platform_demo_videos TO authenticated;
GRANT ALL   ON public.platform_demo_videos TO service_role;

-- Tighten the public-read policy to respect the audience flag
DROP POLICY IF EXISTS "Anyone can view published demo videos" ON public.platform_demo_videos;
CREATE POLICY "Public can view published public videos"
  ON public.platform_demo_videos FOR SELECT
  TO anon
  USING (is_published = true AND audience = 'public');
CREATE POLICY "Authenticated users can view all published videos"
  ON public.platform_demo_videos FOR SELECT
  TO authenticated
  USING (is_published = true);
```

Launcher mount: single injection in `PlatformShell`'s topbar action slot, so every tenant app (Sales, POS, Payroll, Inventory, ESS, Dashboard) gets it for free — no per-app wiring.

### Rollout order
1. Grants + audience column migration → unblocks `/demo` immediately.
2. Admin form upgrades (app, audience, thumbnail required, duration auto-detect, live preview).
3. `ResourceCenterLauncher` + topbar mount.
4. `/resources` library page + detail page.
5. Wire contextual "Watch a quick tour" into 3–4 flagship empty states (Sales dashboard, POS setup, Payroll first-run, ESS home).

Say the word and I'll switch to build mode and start at step 1.
