# Digital Learners

A private, invite-only LMS for one teacher. Flask + Vue (via CDN, no build step),
Postgres on Neon, media on S3. Architecture and data model: see [CLAUDE.md](CLAUDE.md).


## Run it locally

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt

python init_db.py --demo        # schema + teacher + invite code + a demo course
python app.py                   # http://127.0.0.1:5000
```

`.env` supplies `DATABASE_URL` (Neon), the S3 keys, `SECRET_KEY`, and the teacher's
`ADMIN_EMAIL` / `ADMIN_PASSWORD`. It is never committed.

`init_db.py` is safe to re-run: the schema is `CREATE TABLE IF NOT EXISTS` and the
seeds upsert. Drop `--demo` to skip the sample course and student.

### Accounts after `init_db.py --demo`

| Who | Sign in with |
|-----|--------------|
| Teacher (owner) | `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` |
| Demo student | `student@example.com` / `student123` (class **General**) |
| New students | register with the code `GENERAL-0001` |

Registration codes belong to a **class** (a named group at one level — currently just
Culture Studies), and the class name is the code's prefix. Whoever registers with
`GENERAL-0001` joins General, and so sits at the Culture Studies level. The teacher mints
new codes and classes from **Students → Classes & codes**.

## The files

| File | What it holds |
|------|---------------|
| `app.py` | Flask entrypoint, config, session cookie, the SPA route |
| `api.py` | Every `/api` route. All access control lives here |
| `auth.py` | Session auth, `@login_required` / `@owner_required`, enrollment checks |
| `db.py` | Pooled Postgres access, raw SQL, `new_id()` |
| `storage.py` | S3 upload, signed URLs, type/size limits |
| `schema.sql` | The tables (§4 of CLAUDE.md) |
| `static/js/blocks.js` | The block registry: one editor + one renderer per block type |
| `static/js/app.js` | The client: hash router and the seven screens |

**Adding a block type** is two edits in `blocks.js` (an entry in `BLOCK_TYPES`, a branch
in the renderer and the editor). Nothing else special-cases a type.

## Deploying to Render

Diskless — nothing is written to the local filesystem. Set the same environment
variables in the Render dashboard (never commit `.env`), point staging at its own Neon
branch, and run:

```
Build:  pip install -r requirements.txt
Start:  gunicorn app:app
```

Run `python init_db.py` once against each new database. Free web services sleep after
~15 min idle; `/healthz` is there for a keep-alive ping.
