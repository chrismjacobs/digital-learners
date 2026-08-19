-- Culture Studies — schema (see CLAUDE.md §4)
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('teacher','student')),
  name          text NOT NULL,
  email         text UNIQUE,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,   -- teacher can turn a student off
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id         text PRIMARY KEY,
  code       text UNIQUE NOT NULL,
  note       text,
  max_uses   integer,
  uses       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_categories (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A named group of students sitting at exactly one level (category). A class owns its
-- registration codes, and a student's level is derived through their class — never
-- stored on the user (see CLAUDE.md §3C).
CREATE TABLE IF NOT EXISTS classes (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  category_id text NOT NULL REFERENCES course_categories(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)          -- names prefix the codes, so they must be unambiguous
);

CREATE TABLE IF NOT EXISTS courses (
  id             text PRIMARY KEY,
  title          text NOT NULL,
  category_id    text REFERENCES course_categories(id),
  overview       text,
  goals          jsonb NOT NULL DEFAULT '[]'::jsonb,
  title_card_key text,
  sort_order     integer NOT NULL DEFAULT 0,
  published      boolean NOT NULL DEFAULT false,  -- enrolled students can access it
  promoted       boolean NOT NULL DEFAULT false,  -- its info page is public (marketing)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollments (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS lessons (
  id           text PRIMARY KEY,
  course_id    text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code         text NOT NULL,
  kind         text NOT NULL,
  title        text NOT NULL,
  sort_order   integer NOT NULL,
  is_open      boolean NOT NULL DEFAULT false,   -- teacher releases lessons; closed until opened
  content_json jsonb NOT NULL DEFAULT '{"blocks": []}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS testimonials (
  id          text PRIMARY KEY,
  course_id   text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author_name text NOT NULL,
  body        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Extra promo photos for a course (a gallery). The card/hero image stays courses.title_card_key;
-- these are additional. Binaries live in S3; only the key is stored here.
CREATE TABLE IF NOT EXISTS course_images (
  id         text PRIMARY KEY,
  course_id  text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  key        text NOT NULL,
  caption    text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS responses (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id   text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  block_id    text NOT NULL,
  kind        text NOT NULL,
  option_id   text,
  value_text  text,
  media_key   text,
  score       real,
  feedback    text,
  status      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, block_id)
);

CREATE TABLE IF NOT EXISTS lesson_completions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

-- Migrations for databases created before classes/goals existed. Idempotent, so a
-- re-run of init_db.py brings an existing Neon database up to date in place.
ALTER TABLE lessons      ADD COLUMN IF NOT EXISTS is_open        boolean NOT NULL DEFAULT false;
ALTER TABLE users        ADD COLUMN IF NOT EXISTS active         boolean NOT NULL DEFAULT true;
ALTER TABLE courses      ADD COLUMN IF NOT EXISTS goals          jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE courses      ADD COLUMN IF NOT EXISTS promoted       boolean NOT NULL DEFAULT false;
ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS class_id       text REFERENCES classes(id) ON DELETE CASCADE;
ALTER TABLE users        ADD COLUMN IF NOT EXISTS class_id       text REFERENCES classes(id) ON DELETE SET NULL;
ALTER TABLE users        ADD COLUMN IF NOT EXISTS invite_code_id text REFERENCES invite_codes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS course_images_course_idx     ON course_images (course_id, sort_order);
CREATE INDEX IF NOT EXISTS classes_category_idx         ON classes (category_id);
CREATE INDEX IF NOT EXISTS users_class_idx              ON users (class_id);
CREATE INDEX IF NOT EXISTS courses_category_sort_idx    ON courses (category_id, sort_order);
CREATE INDEX IF NOT EXISTS enrollments_course_idx       ON enrollments (course_id);
CREATE INDEX IF NOT EXISTS lessons_course_sort_idx      ON lessons (course_id, sort_order);
CREATE INDEX IF NOT EXISTS responses_lesson_idx         ON responses (lesson_id);
CREATE INDEX IF NOT EXISTS completions_user_idx         ON lesson_completions (user_id);

INSERT INTO course_categories (id, name, sort_order) VALUES
  ('cat_culture', 'Culture Studies', 0)
ON CONFLICT (id) DO NOTHING;
