# English Explorers LMS — Build Guide (CLAUDE.md)

Orientation file for Claude Code. Read this first before making changes.


---

## 1. What this is

A private, invite-only learning platform for **one teacher** running online English
lessons. Students register with a teacher-issued code, get assigned to courses, work
through gated lessons, and submit answers. The teacher builds lessons visually,
manages students, and reviews responses.

**Guiding principle: feature-rich but low points of failure.** The teacher (and any
non-technical helper) must be able to run day-to-day operations without touching code.
When choosing between a clever solution and a simple one, choose simple. Prefer fewer
moving parts over fewer clicks.

**Single owner.** There is one teacher/owner account. Everyone else is a student.
Do not build multi-teacher features unless asked.

The clickable prototype (`english-explorers-lms.jsx`) is the **UI source of truth** for
screens and flows. This document is the source of truth for data, auth, storage, and
architecture. Where they disagree, ask.

Title: Mama Lucy's English Explorers

---

## 2. Stack

- **Backend:** Flask (Python), served on Render.
- **Frontend:** Vue.js via CDN (no build step), plain `.js`/`.html`. Keep it buildless.
- **DB:** Neon (managed Postgres). Connection string in the env file.
- **Storage:** AWS S3 for all media (images, title cards, logo, student uploads).
  Bucket + credentials in the env file.
- **Deploy:** Render — production and staging environments.

**Hosting notes.** The database lives in Neon, not on the Render instance, so the Render
service is **diskless** — no persistent disk to configure, and the free tier is viable for
the app process itself. Consequence: never write data to the local filesystem expecting it
to survive; it's ephemeral and resets on every deploy. All state goes to Neon or S3. Free
web services also spin down after ~15 min idle (cold start on next hit); a keep-alive ping
service handles that separately. Production and staging are separate Render services, each
with its **own Neon database/branch** — Neon branching is a clean way to give staging an
isolated copy. Both read config (Neon URL, S3 keys) from environment variables; never commit
the env file.

Keep dependencies minimal. Every added library is a thing the teacher's helper must
later understand.

---

## 3. Core architecture — read this before touching data

Three invariants hold the whole system together. Breaking any one creates the exact
fragility we're avoiding.

**(A) Lesson content and student responses are stored separately.**
A lesson's content is one JSON document (an ordered list of "blocks"). Student answers
are individual rows in a `responses` table. The content JSON never contains student
data. This is why the lesson editor can never corrupt student results, and why the same
lesson renders identically whether or not anyone has answered.

**(B) Everything interactive has a stable ID that survives edits.**
Every block carries an `id`; every multiple-choice option carries an `id`. A response
row references `block_id` (and `option_id` for multiple choice), never a position.
Generate an ID once, at creation, and never reuse or renumber it. This is what lets the
teacher reorder, edit, or delete blocks without stranding old responses. **If you ever
find yourself keying anything to "the 3rd block," stop — use the ID.**

**(C) Derived state is computed, never stored.**
A lesson's locked/unlocked state, a student's progress, the list of quizzes in a course,
**a student's level** — all computed on read from the tables below. A student's level is
`classes.category_id` reached through their `class_id`; it is never copied onto the user
row, so moving a class between levels can't leave a student stranded at the old one.
Don't cache "unlocked up to lesson N." Compute it live so edits can't leave it stale.

---

## 4. Data model (Postgres / Neon)

IDs are minted app-side as `text` (keeps parity with how the code already generates them).
If you'd rather the DB mint them, switch `id` to `uuid DEFAULT gen_random_uuid()` — pick one
convention and hold it everywhere. `updated_at` is not auto-managed by Postgres; set it in
the app on write (or add a trigger if you prefer — one small trigger, teacher's helper never
sees it).

```sql
-- Accounts. One teacher, many students.
-- A student belongs to a class; their LEVEL is derived through it (classes.category_id)
-- and is never stored here. invite_code_id records the code they actually joined with,
-- which the teacher sees in the student table.
CREATE TABLE users (
  id             text PRIMARY KEY,
  role           text NOT NULL CHECK (role IN ('teacher','student')),
  name           text NOT NULL,
  email          text UNIQUE,
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,   -- teacher can turn a student off;
                                                  -- false blocks login, keeps the account
  class_id       text REFERENCES classes(id) ON DELETE SET NULL,       -- NULL = unassigned
  invite_code_id text REFERENCES invite_codes(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A named group of students (e.g. "Sunflowers") sitting at exactly one level. A class
-- owns its registration codes, and joining one is what gives a student their level.
-- This is what keeps the student dashboard's course-assign grid narrow: the table shows
-- one level at a time, so only that level's courses become columns.
CREATE TABLE classes (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  category_id text NOT NULL REFERENCES course_categories(id),   -- the level
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)          -- the name prefixes its codes, so it must be unambiguous
);

-- Registration codes the teacher hands out. Every code belongs to a class, and the code
-- string is the class name plus a random suffix: SUNFLOWERS-7K2Q. Registering with it
-- puts the student in that class (and so at that level).
CREATE TABLE invite_codes (
  id         text PRIMARY KEY,
  code       text UNIQUE NOT NULL,
  class_id   text REFERENCES classes(id) ON DELETE CASCADE,
  note       text,                 -- e.g. "Spring cohort"
  max_uses   integer,              -- NULL = unlimited
  uses       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Course categories (e.g. Adult, Kids Level 1, Kids Level 2). A lookup table, not a
-- CHECK enum, so new categories are a row the teacher adds — never a schema migration.
-- The home page groups courses by these and renders them in sort_order.
CREATE TABLE course_categories (
  id         text PRIMARY KEY,
  name       text NOT NULL,          -- display label, e.g. "Kids Level 1"
  sort_order integer NOT NULL DEFAULT 0,  -- controls section order on the home page
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the starting set. Add more rows later; no migration needed.
INSERT INTO course_categories (id, name, sort_order) VALUES
  ('cat_adult', 'Adult',        0),
  ('cat_kids1', 'Kids Level 1', 1),
  ('cat_kids2', 'Kids Level 2', 2),
  ('cat_home',  'Home Class',   3);

-- Courses. category_id + title_card_key + overview + goals + testimonials drive the
-- home/detail pages.
CREATE TABLE courses (
  id             text PRIMARY KEY,
  title          text NOT NULL,
  category_id    text REFERENCES course_categories(id),  -- which home-page group it belongs to
  overview       text,             -- free prose, shown on the course detail page
  goals          jsonb NOT NULL DEFAULT '[]'::jsonb,     -- ["Name ten colours", ...]
                                   -- rendered as the "What you'll be able to do" ticks
  title_card_key text,             -- S3 key for the home-page card image
  sort_order     integer NOT NULL DEFAULT 0,  -- order within its category
  published      boolean NOT NULL DEFAULT false,  -- enrolled students can open it
  promoted       boolean NOT NULL DEFAULT false,  -- its info page is public (marketing);
                                   -- independent of published — a course can be promoted
                                   -- ("coming soon") without being open to students
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Which student can access which course. This IS the "assign access" mechanism.
CREATE TABLE enrollments (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

-- Lessons. content_json holds the ordered blocks (see §5). Gating is by sort_order.
CREATE TABLE lessons (
  id           text PRIMARY KEY,
  course_id    text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code         text NOT NULL,      -- "1-1", "1-2" ... display + ordering aid
  kind         text NOT NULL,      -- "Preview" | "Main" | "Review" (label only)
  title        text NOT NULL,
  sort_order   integer NOT NULL,   -- display order within the course
  is_open      boolean NOT NULL DEFAULT false,  -- teacher releases it; students see open only
  content_json jsonb NOT NULL DEFAULT '{"blocks": []}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Teacher-curated course testimonials (shown on the course detail page).
CREATE TABLE testimonials (
  id          text PRIMARY KEY,
  course_id   text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author_name text NOT NULL,
  body        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Extra promo photos for a course (a gallery). The single card/hero image stays
-- courses.title_card_key; these are additional and optional. Same shape as testimonials.
-- Binary lives in S3; only the key is stored. Signed URL is derived on read, never stored.
CREATE TABLE course_images (
  id          text PRIMARY KEY,
  course_id   text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  key         text NOT NULL,        -- S3 key (courses/{course_id}/gallery/{image_id}.{ext})
  caption     text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per student per interactive block. Keyed to stable block_id.
CREATE TABLE responses (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id   text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  block_id    text NOT NULL,       -- references a block id inside the lesson JSON
  kind        text NOT NULL,       -- "quiz_mc" | "quiz_open" | "upload"
  option_id   text,                -- multiple choice: the chosen option's stable id
  value_text  text,                -- open answer text
  media_key   text,                -- S3 key for uploaded audio/photo (phase 2)
  -- Present but unused today. Lets grading be added later with zero migration:
  score       real,
  feedback    text,
  status      text,                -- e.g. "submitted" | "reviewed"
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, block_id)       -- one answer per student per block; upsert on resubmit
);

-- The completed-set. Drives both gating and dashboard progress.
CREATE TABLE lesson_completions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

-- Helpful indexes for the common lookups.
CREATE INDEX ON classes (category_id);
CREATE INDEX ON users (class_id);
CREATE INDEX ON courses (category_id, sort_order);
CREATE INDEX ON enrollments (course_id);
CREATE INDEX ON lessons (course_id, sort_order);
CREATE INDEX ON responses (lesson_id);
CREATE INDEX ON lesson_completions (user_id);
```

> **Note on the `score`/`feedback`/`status` columns:** nothing writes to them yet. Quizzes
> are answer-sharing forms, not graded work. The columns exist so that if the teacher
> later wants grading, it's added without a migration or disruption to existing data.
> Leave them in.

**Upsert pattern** (resubmitting an answer overwrites the old one, thanks to the
`UNIQUE (user_id, block_id)` constraint):

```sql
INSERT INTO responses (id, user_id, lesson_id, block_id, kind, option_id, value_text, updated_at)
VALUES (%s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (user_id, block_id)
DO UPDATE SET option_id = EXCLUDED.option_id,
              value_text = EXCLUDED.value_text,
              updated_at = now();
```

---

## 5. Lesson content JSON (the block model)

`lessons.content_json` is the whole lesson body — a `jsonb` column (see §4). The teacher
builds it in the visual editor; the student view renders it top to bottom. Read/write it as
one whole document: with psycopg the column comes back already parsed as a Python dict, and
on write you wrap the dict (`Jsonb(lesson_dict)`) so it's stored as real JSON, not a
double-encoded string. `jsonb` validates the JSON on write, so a malformed body is rejected
by the database instead of silently stored.

```json
{
  "blocks": [
    { "id": "b_a1", "type": "title",  "text": "Colours Around Us" },
    { "id": "b_a2", "type": "text",   "text": "Say each colour out loud." },
    { "id": "b_a3", "type": "image",  "key": "lessons/l1/b_a3.jpg", "caption": "A red apple" },
    { "id": "b_a4", "type": "video",  "url": "https://...", "label": "The Colours Song" },
    { "id": "b_a5", "type": "embed",  "url": "https://docs.google.com/...", "label": "Slides" },
    { "id": "b_a6", "type": "link",   "url": "https://...", "label": "Practice page" },
    { "id": "b_a7", "type": "prompt", "text": "Find something red in your room." },
    {
      "id": "b_q1", "type": "quiz_mc",
      "question": "What colour is the sky on a sunny day?",
      "options": [
        { "id": "o1", "text": "Blue" },
        { "id": "o2", "text": "Red" }
      ],
      "correctId": "o1",
      "feedbackCorrect": "Yes! The sky is blue.",
      "feedbackWrong": "Look up outside — try again!"
    },
    { "id": "b_q2", "type": "quiz_open", "question": "Write three things that are red." },
    { "id": "b_u1", "type": "upload", "prompt": "Record yourself saying the colours.",
      "accept": ["audio", "image"] }
  ]
}
```

**Block types** (registry — adding a type = one editor component + one renderer, nothing else):

| type        | fields                                                        | interactive |
|-------------|---------------------------------------------------------------|-------------|
| `title`     | `text`                                                        | no          |
| `text`      | `text`                                                        | no          |
| `image`     | `key` (S3), `caption`                                          | no          |
| `video`     | `url` (YouTube/Vimeo link) **or** `key` (uploaded file), `label` | no        |
| `audio`     | `key` (uploaded file), `caption`                              | no          |
| `embed`     | `url`, `label` (Google Slides / Drive frame)                  | no          |
| `link`      | `url`, `label`                                                 | no          |
| `prompt`    | `text` (thought / exercise, not collected)                    | no          |
| `quiz_mc`   | `question`, `options[{id,text}]`, `correctId`, `feedbackCorrect`, `feedbackWrong` | yes |
| `quiz_open` | `question`                                                    | yes         |
| `upload`    | `prompt`, `accept[]` — **phase 2**, audio/photo to S3         | yes         |

**Uploaded media vs. links (`key` vs. `url`).** A block that carries a **`key`** is a file in
S3 (image, audio, or an uploaded video); its `url` is a signed link **derived on read** and
must never be persisted into `content_json`. A `video` with **no `key`** is an embed whose
`url` **is** the content the teacher typed — that one is stored. The rule the client and API
both follow: *strip `url` on save iff the block has a `key`; hydrate `url` from `key` on read.*
Getting this wrong silently wipes the field (it once did — for embed links).

**Editing a quiz after answers exist:** allowed, no versioning. Because responses key to
stable `block_id`/`option_id`, old answers survive edits. If the teacher deletes an option
that a student had chosen, that response's `option_id` no longer resolves — render it as
"(removed option)" rather than crashing. Never renumber option IDs on edit.

**Enumerating quizzes for the dashboard:** parse `content_json` in Python and collect the
interactive blocks. Do not add a separate quiz table. With this scale, scanning lesson JSON
on read is simpler and has fewer failure points than keeping an index in sync. (If it ever
grows large, query into the `jsonb` directly with Postgres path operators — e.g.
`jsonb_path_query` / `jsonb_array_elements` — and add a GIN index on `content_json`. Not
before.)

---

## 6. API routes (Flask)

All under `/api`. Session-cookie auth. `@owner_required` = teacher only;
`@login_required` = any authenticated user. **Access control is enforced server-side; never
trust the client for lock state or enrollment.**

**Auth**
```
POST /api/register        {code, name, email, password}  -> validates invite_code, makes student
POST /api/login           {email, password}   -> 403 if the student's access is turned off
POST /api/logout
GET  /api/me
```

**Public — no login** (the only unauthenticated routes; marketing surface for visitors)
```
GET  /api/public/courses            promoted courses, grouped by category. Safe fields only
                                    (title, overview, goals, title-card) — never the flags.
GET  /api/public/courses/:id        a promoted course's info: overview, goals, gallery photos
                                    (url+caption only), testimonials, and lesson TITLES only
                                    (code/kind/title). 404 unless promoted. No lesson content,
                                    lock state, or student data.
```
These must stay strictly read-only and leak nothing beyond promoted-course marketing info —
they are the app's only doorway that skips auth. Everything reads `WHERE promoted` and
hand-picks fields; don't reuse the authenticated `course_json` here (it carries the flags).

**Teacher — courses & content** (`@owner_required`)
```
GET    /api/courses
POST   /api/courses                         {title, category_id, overview}
PATCH  /api/courses/:id                      {title?, category_id?, overview?, published?, sort_order?}
POST   /api/courses/:id/title-card           (multipart) -> uploads to S3, sets title_card_key
DELETE /api/courses/:id

POST   /api/courses/:id/images               (multipart: file, caption?) -> gallery photo,
                                             appends a course_images row, returns {id, url}
PATCH  /api/courses/:id/images/:img_id        {caption?, sort_order?}   edit caption / reorder
DELETE /api/courses/:id/images/:img_id                                  removes S3 object + row

GET    /api/categories                       list categories (ordered) — feeds the group headers + filter
POST   /api/categories                       {name, sort_order?}   add a new category
PATCH  /api/categories/:id                    {name?, sort_order?}
DELETE /api/categories/:id                    (block/deny if any course still references it)

GET    /api/courses/:id/lessons
POST   /api/courses/:id/lessons              {code, kind, title}
PATCH  /api/lessons/:id                       {title?, code?, content_json?, sort_order?, is_open?}
DELETE /api/lessons/:id
POST   /api/lessons/:id/duplicate            copy a lesson within its course
POST   /api/courses/:id/duplicate            copy a whole course (lessons, media, testimonials)

# Duplication regenerates every block id and quiz-mc option id (responses key on block_id
# globally — §3B) and copies each block's/course's media to fresh S3 keys. Copies start
# published=false, promoted=false, all lessons is_open=false; no per-student data is copied.

GET    /api/courses/:id/testimonials
POST   /api/courses/:id/testimonials         {author_name, body}
PATCH  /api/testimonials/:id
DELETE /api/testimonials/:id

POST   /api/uploads                           (multipart) -> {key}  (lesson images etc.)
```

**Teacher — classes** (`@owner_required`)
```
GET    /api/classes                  id, name, category_id, student_count
POST   /api/classes                  {name, category_id}
PATCH  /api/classes/:id              {name?, category_id?}
DELETE /api/classes/:id              refused (400) while any student is still in it
```

**Teacher — students & responses** (`@owner_required`)
```
GET  /api/students?level=&class_id=&q=   the table. `level` is a category_id, or "none"
                                         for students with no class yet. Exactly one
                                         level at a time — there is no "all levels".
                                         `q` matches name, email, or registration code.
GET  /api/students/counts                {levels: {cat_id: n}, unassigned: n} — tab badges
GET  /api/students/:id                   profile + progress + their answers
PATCH /api/students/:id                  {class_id?, active?}  move to another class (and
                                         level), and/or turn access off/on. Enrollments
                                         are left untouched either way. active=false blocks
                                         the student's login; the account and answers stay.
POST /api/courses/:id/enrollments        {user_id}     assign access
DELETE /api/courses/:id/enrollments/:user_id           unassign
GET  /api/invite-codes                   only PENDING codes (active and not yet exhausted;
                                         a used single-use code has done its job), each
                                         with its class_name + category_id
POST /api/invite-codes                   {class_id, note?, max_uses?}  class_id REQUIRED;
                                         the code is minted as CLASSNAME-XXXX
GET  /api/lessons/:id/responses                all answers for a lesson
GET  /api/lessons/:id/blocks/:block_id/responses   answer-sharing view for one quiz
```

**Student** (`@login_required`, must be enrolled)
```
GET  /api/my/courses                           enrolled courses, each with its category — the
                                               client groups by category for the home page
GET  /api/my/courses?category=:id              same, filtered to one category (the all-courses page)
GET  /api/courses/:id                          detail: overview, testimonials, lessons + lock state
GET  /api/lessons/:id                          content — 403 if lesson is locked for this user
POST /api/lessons/:id/responses                {block_id, kind, option_id?, value_text?}  upsert
POST /api/lessons/:id/complete                 marks lesson_completions
POST /api/my/uploads                           (multipart) student audio/photo — phase 2
```

---

## 7. Gating & progress (server-side)

Gating is **teacher-controlled**, not automatic. A lesson is **unlocked** for a student iff
`lessons.is_open` is true — the teacher releases lessons by opening them; there is no required
order, so among open lessons a student may work in any order. New lessons default to **closed**
(`is_open = false`); the teacher opens each one to release it. The teacher always sees every
lesson unlocked (to edit and preview). The single gate is `lessons_with_state`; a lesson that
isn't open returns `403` (not its content) from `GET /api/lessons/:id`, `POST .../responses`,
and `POST .../complete`.

Progress on the dashboard = count of `lesson_completions` for the student in that course, over
total lessons. Same table, two readers. Do not store a separate progress counter.

Completion is self-serve (`POST .../complete` needs no teacher action) but is **progress only** —
it no longer unlocks anything. Releasing the next lesson is the teacher's open/close switch.
(Earlier versions gated sequentially on completion; that was replaced by manual open/close so the
teacher can hold lessons back even from a student who has finished the prerequisites.)

---

## 8. Screens (see prototype for exact layout)

**Public landing (visitors, not logged in).** Instead of jumping straight to the login form,
a not-logged-in visitor gets a marketing landing: a hero with a "Sign in or register" call to
action and the **promoted** courses grouped by category. Clicking one opens a read-only public
course page (overview, goals, lesson titles as a syllabus, testimonials, and a register CTA) —
no lock state, no lesson content. A "Sign in" button in the top bar reaches the auth form,
which has a "Back to courses" link. Whether a course appears here is the **Promote** toggle on
the teacher's course editor (next to Published, and independent of it).

**Home page.** Courses grouped into a section per category (Adult, Kids Level 1, Kids Level 2),
sections ordered by `course_categories.sort_order`. Each section shows a few course cards
(title-card image + title) with a "See all" link into the all-courses page for that category.
Students see only their enrolled courses; the teacher sees all, plus "Add course." Empty
categories render no section. Clicking a card opens the course detail page.

**All courses page.** The dedicated listing: every course the viewer can see, in a table
filterable by category (the filter options come from `GET /api/categories`). This is the
"tabulate all, filterable" surface behind the home-page "See all" links.

**Course detail page.** Title-card hero, `overview` prose, the **goals** list rendered as
ticked bullets under "What you'll be able to do", an optional **Photos** gallery (extra promo
photos), the lesson list (with lock/done state for students), and the testimonials. This is the
"see the course clearly" surface. The teacher edits the goals as an add/remove/reorder list of
rows in the same panel as the overview, and manages gallery photos in the Photos section
(upload / caption / reorder / delete). The same gallery shows on the public promo page.

**Course detail — lesson list (teacher).** Each lesson row has an **Open / Closed** toggle (the
release switch — §7), a small **⧉ duplicate** button, and delete. The course hero has a
**Duplicate course** button next to Edit details / Delete. Students see a "Not open yet" lock on
any closed lesson.

**Teacher guide.** A teacher-only `#/guide` page (nav link "Guide") explaining the model and the
non-obvious parts — class-vs-enrollment, open/close pacing, publish-vs-promote, duplication. Pure
static help content; no data. Keep it in step with behaviour changes.

**Lesson builder (teacher).** Google-Forms-style: an ordered list of blocks, an "Add part"
palette, inline editing, reorder up/down, delete. Saving writes `content_json` via
`PATCH /api/lessons/:id`.

**Student dashboard (teacher).** **Level tabs across the top — the table shows exactly one
level at a time, never "all".** This is the mechanism that keeps the course-assign grid
usable: only the courses belonging to the shown level become checkbox columns, so adding
courses to other levels never widens this table. An extra "Unassigned" tab appears only
while some student has no class. Each tab carries its student count, and the page opens on
a level that actually has students.

Columns: **Student · Class · Code · Access · Lessons done · [one checkbox per course in this
level]**. The class cell is a dropdown that moves the student to another class (and so another
level); their existing course access is deliberately left alone. The **Access** cell is a
turn-off/turn-on toggle: off blocks the student's login (a disabled row renders muted with an
"Off" pill) but keeps the account and answers, so it's reversible. The code column shows the
registration code they actually joined with, and the search box matches name, email, or code.
Below the table, a Responses section lists every quiz with a respondent count that opens the
answer-sharing view.

**Classes & codes (teacher).** A modal off the student dashboard, framed as **pending
invites** — it lists only codes not yet used (a code disappears once a student registers with
it), each with a **Revoke** button to kill an unused invite. There's a form to mint a new code
for a class (the class name becomes the code's prefix) and a form to add a class at a level. A
code cannot exist without a class. To stop a student who has *already* registered, you turn
their Access off in the table, not here.

**Student lesson view.** Renders blocks in order; multiple choice gives instant auto-feedback;
open answers and (phase 2) uploads are captured. "Mark lesson complete" records progress (it no
longer unlocks anything — the teacher's open/close switch controls what's available, §7).

---

## 9. Media & S3

All binaries live in S3. Suggested key layout:

```
logo/logo.png
courses/{course_id}/title-card.{ext}
courses/{course_id}/gallery/{image_id}.{ext}   # extra promo photos (course_images)
lessons/{lesson_id}/{block_id}.{ext}      # content image / audio / video
uploads/{user_id}/{response_id}.{ext}     # student audio/photo (phase 2)
```

Serve via time-limited signed URLs. Validate content type and cap size on upload; the caps
live in `api.UPLOAD_KINDS` (image 15MB, audio 30MB, video 200MB) and `MAX_CONTENT_LENGTH`
in `app.py` must stay above the largest of them. Never store binaries in the database —
they go to S3, and only the S3 key is stored in Postgres.

**A note on big videos.** Teacher video uploads are proxied through the app to S3. That's
fine locally and for short clips, but a large file over a slow uplink can outrun a
production request timeout (e.g. gunicorn's default 30s on Render). For long videos prefer a
YouTube/Vimeo link (the `video` block takes either); revisit direct-to-S3 presigned uploads
only if proxied uploads actually become a problem.

---

## 10. Branding

- Theme: red / white / blue, tying **UK 🇬🇧 + Taiwan 🇹🇼**. Palette from the prototype:
  navy `#0B2A6B`, red `#C8102E`, paper `#F4F7FC`, ink `#14203A`, line `#DCE3F1`.
- The **top banner is navy**, with the logo lockup and nav in white (the active nav item
  inverts to a white pill). Not white/paper.
- The three-stripe (navy/white/red) accent under the top bar is the signature element —
  keep it. Against the navy banner the navy segment blends in, leaving a white+red edge;
  that's intended.
- A `logo.png` will be provided. Use it in the top-bar lockup in place of the placeholder
  icon, and on the login/register screen.

---

## 11. Build order (phases)

1. **Auth + accounts.** Invite-code registration, login/logout, session, owner vs student.
2. **Courses + lessons CRUD** with the block model and the visual builder. Home page +
   course detail + title cards + testimonials.
3. **Student experience.** Enrollment-gated home, sequential lesson gating, answer capture
   for `quiz_mc` / `quiz_open`, lesson completion.
4. **Teacher dashboard.** Student table + filters, course-access assignment, response views.
5. **Phase 2.** Student media uploads (`upload` block, audio/photo to S3). Then, only if
   asked: live-session attendance, quiz grading (columns already exist), reusable quiz bank.

The hard, do-them-carefully parts are **auth, file uploads, and server-side access
control** — the prototype fakes all three, so its simplicity is not a size estimate.
Everything else is largely settled by the prototype.

---

## 12. Guardrails for whoever maintains this

- Keep it buildless and dependency-light. No frontend build step, no ORM if raw SQL stays legible.
- One owner account. Don't add roles/permissions beyond teacher/student without a request.
- Stable IDs are sacred (see §3). Don't renumber block or option IDs on edit.
- Content JSON is the single source of truth for lesson body; responses are the single
  source of truth for answers; derived state is computed. Don't duplicate any of these.
- When adding a block type: add its editor and its renderer, register it, done. Don't
  special-case it elsewhere.
- Production and staging are separate Render services with separate Neon databases
  (or Neon branches) — test on staging first. Config comes from env vars; never commit
  the env file.