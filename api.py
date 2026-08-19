"""The whole HTTP API. Session-cookie auth; access control is enforced here, never
in the client. See CLAUDE.md §6 for the route list."""
import re
import secrets

from flask import Blueprint, request, jsonify, session
from psycopg.types.json import Jsonb
from werkzeug.security import generate_password_hash, check_password_hash

import db
import storage
from auth import (
    current_user, login_user, logout_user, login_required, owner_required,
    is_teacher, is_enrolled, can_view_course, DISABLED_MESSAGE,
)

api = Blueprint("api", __name__, url_prefix="/api")

INTERACTIVE_TYPES = {"quiz_mc", "quiz_open", "upload"}


# ---------------------------------------------------------------- helpers

def body():
    return request.get_json(silent=True) or {}


def need(data, *fields):
    """Returns the named fields, or raises Invalid naming the first missing one."""
    out = []
    for f in fields:
        value = data.get(f)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise Invalid(f"{f} is required")
        out.append(value.strip() if isinstance(value, str) else value)
    return out


class Invalid(Exception):
    pass


@api.errorhandler(Invalid)
def on_invalid(exc):
    return jsonify(error=str(exc)), 400


MAX_GOALS = 12
MAX_GOAL_LEN = 200


def clean_goals(value):
    """Course goals: a plain list of short strings. Blank rows are dropped, so the
    editor can leave an empty input lying around without persisting it."""
    if not isinstance(value, list):
        raise Invalid("Goals must be a list.")
    goals = []
    for goal in value:
        if not isinstance(goal, str):
            raise Invalid("Each goal must be text.")
        goal = goal.strip()
        if not goal:
            continue
        if len(goal) > MAX_GOAL_LEN:
            raise Invalid(f"A goal must be under {MAX_GOAL_LEN} characters.")
        goals.append(goal)
    if len(goals) > MAX_GOALS:
        raise Invalid(f"A course can have at most {MAX_GOALS} goals.")
    return goals


def public_user(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}


def image_json(row):
    """A gallery image for the client. `url` is a signed link derived on read; the raw S3
    key is never sent out."""
    return {
        "id": row["id"],
        "url": storage.signed_url(row["key"]),
        "caption": row["caption"],
        "sort_order": row["sort_order"],
    }


def course_images(course_id):
    return db.query(
        "SELECT * FROM course_images WHERE course_id = %s ORDER BY sort_order, created_at",
        (course_id,),
    )


def blocks_of(lesson_row):
    content = lesson_row["content_json"] or {}
    return content.get("blocks") or []


def hydrate_blocks(blocks):
    """Attach signed URLs to uploaded media. Derived on read; never stored. A block that
    carries a `key` is a stored file (image/audio/video), so `url` is its signed link. A
    video with no key is an embed whose `url` is the link the teacher typed — left as is."""
    out = []
    for block in blocks:
        block = dict(block)
        if block.get("key"):
            block["url"] = storage.signed_url(block["key"])
        out.append(block)
    return out


def _ext_of(key):
    return key.rsplit(".", 1)[-1] if key and "." in key else "bin"


def duplicate_content(content, new_lesson_id):
    """Deep-copy a lesson's content_json for duplication. Every block id and every
    quiz_mc option id is regenerated (and correctId remapped) — mandatory, because
    responses are keyed UNIQUE(user_id, block_id) globally, so a reused id would collide
    across the original and the copy (CLAUDE.md §3B). Any uploaded-media block gets its
    own S3 copy under the new lesson/block path, so the copy never shares the original's
    object. Signed `url`s are dropped (derived on read, never stored)."""
    blocks = []
    for old in (content or {}).get("blocks", []):
        block = dict(old)
        block.pop("url", None)
        new_block_id = db.new_id("b")
        block["id"] = new_block_id

        if block.get("type") == "quiz_mc" and isinstance(block.get("options"), list):
            id_map, new_options = {}, []
            for opt in block["options"]:
                opt = dict(opt)
                new_oid = db.new_id("o")
                id_map[opt.get("id")] = new_oid
                opt["id"] = new_oid
                new_options.append(opt)
            block["options"] = new_options
            if block.get("correctId") in id_map:
                block["correctId"] = id_map[block["correctId"]]

        if block.get("key"):
            new_key = f"lessons/{new_lesson_id}/{new_block_id}.{_ext_of(block['key'])}"
            # If the copy fails (source gone), keep the old key — a shared reference is
            # less bad than a key pointing at nothing.
            block["key"] = storage.copy(block["key"], new_key) or block["key"]

        blocks.append(block)
    return {"blocks": blocks}


def lessons_with_state(user, course_id):
    """This course's lessons in order, each carrying `completed` and `unlocked` for this
    user. One query — the database is remote, so round trips are the thing to spend
    carefully.

    A lesson is unlocked for a student iff the teacher has opened it (`is_open`) — the
    teacher releases lessons manually; there is no automatic ordering. The teacher sees
    every lesson unlocked so they can edit and preview. `completed` (from
    lesson_completions) is kept for progress only; it no longer gates. Computed live on
    every read (CLAUDE.md §3C) — never cached, never stored.
    """
    lessons = db.query(
        """SELECT l.*, (lc.id IS NOT NULL) AS completed
             FROM lessons l
             LEFT JOIN lesson_completions lc
                    ON lc.lesson_id = l.id AND lc.user_id = %s
            WHERE l.course_id = %s
            ORDER BY l.sort_order, l.code""",
        (user["id"], course_id),
    )
    teacher = user["role"] == "teacher"
    for lesson in lessons:
        lesson["unlocked"] = True if teacher else lesson["is_open"]
    return lessons


def lesson_lock_state(user, course_id):
    """{lesson_id: {"unlocked": bool, "completed": bool}} — the gate checks."""
    return {
        l["id"]: {"unlocked": l["unlocked"], "completed": l["completed"]}
        for l in lessons_with_state(user, course_id)
    }


def course_json(row, progress=None):
    return {
        "id": row["id"],
        "title": row["title"],
        "category_id": row["category_id"],
        "overview": row["overview"],
        "goals": row["goals"] or [],
        "title_card_url": storage.signed_url(row["title_card_key"]),
        "sort_order": row["sort_order"],
        "published": row["published"],
        "promoted": row["promoted"],
        "progress": progress,
    }


def progress_for_courses(user_id, course_ids):
    """{course_id: {done, total}} in one query — the per-course version is an N+1."""
    if not course_ids:
        return {}
    rows = db.query(
        """SELECT l.course_id,
                  count(*) AS total,
                  count(lc.id) AS done
             FROM lessons l
             LEFT JOIN lesson_completions lc
                    ON lc.lesson_id = l.id AND lc.user_id = %s
            WHERE l.course_id = ANY(%s)
            GROUP BY l.course_id""",
        (user_id, list(course_ids)),
    )
    found = {r["course_id"]: {"done": r["done"], "total": r["total"]} for r in rows}
    return {cid: found.get(cid, {"done": 0, "total": 0}) for cid in course_ids}


# ---------------------------------------------------------------- auth

@api.post("/register")
def register():
    data = body()
    code, name, email, password = need(data, "code", "name", "email", "password")
    email = email.lower()

    if len(password) < 6:
        raise Invalid("Password must be at least 6 characters.")
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise Invalid("That doesn't look like an email address.")

    invite = db.one(
        "SELECT * FROM invite_codes WHERE lower(code) = lower(%s) FOR UPDATE", (code,)
    )
    if invite is None or not invite["active"]:
        raise Invalid("That registration code isn't valid.")
    if invite["max_uses"] is not None and invite["uses"] >= invite["max_uses"]:
        raise Invalid("That registration code has been used up.")
    if db.one("SELECT 1 FROM users WHERE email = %s", (email,)):
        raise Invalid("An account with that email already exists.")

    # The code carries the class, and the class carries the level. That's how a student
    # gets both without ever choosing them.
    user_id = db.new_id("u")
    db.execute(
        """INSERT INTO users (id, role, name, email, password_hash, class_id, invite_code_id)
           VALUES (%s, 'student', %s, %s, %s, %s, %s)""",
        (user_id, name, email, generate_password_hash(password),
         invite["class_id"], invite["id"]),
    )
    db.execute("UPDATE invite_codes SET uses = uses + 1 WHERE id = %s", (invite["id"],))

    user = db.one("SELECT * FROM users WHERE id = %s", (user_id,))
    login_user(user)
    return jsonify(user=public_user(user)), 201


@api.post("/login")
def login():
    data = body()
    email, password = need(data, "email", "password")
    user = db.one("SELECT * FROM users WHERE email = %s", (email.lower(),))
    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify(error="Wrong email or password."), 401
    if not user["active"]:
        return jsonify(error=DISABLED_MESSAGE), 403
    login_user(user)
    return jsonify(user=public_user(user))


@api.post("/logout")
def logout():
    logout_user()
    return jsonify(ok=True)


@api.get("/me")
def me():
    user = current_user()
    # A student disabled mid-session reads as logged-out, so the client shows sign-in
    # (where the login attempt is then refused with a clear message) rather than a
    # half-broken shell whose every data call 403s.
    if user and not user["active"]:
        return jsonify(user=None)
    return jsonify(user=public_user(user) if user else None)


# ---------------------------------------------------------------- categories

@api.get("/categories")
@login_required
def list_categories():
    rows = db.query("SELECT * FROM course_categories ORDER BY sort_order, name")
    return jsonify(categories=[
        {"id": r["id"], "name": r["name"], "sort_order": r["sort_order"]} for r in rows
    ])


@api.post("/categories")
@owner_required
def create_category():
    data = body()
    (name,) = need(data, "name")
    cat_id = db.new_id("cat")
    db.execute(
        "INSERT INTO course_categories (id, name, sort_order) VALUES (%s, %s, %s)",
        (cat_id, name, int(data.get("sort_order") or 0)),
    )
    return jsonify(id=cat_id), 201


@api.patch("/categories/<cat_id>")
@owner_required
def update_category(cat_id):
    data = body()
    sets, params = [], []
    if "name" in data:
        sets.append("name = %s")
        params.append(data["name"])
    if "sort_order" in data:
        sets.append("sort_order = %s")
        params.append(int(data["sort_order"]))
    if not sets:
        return jsonify(ok=True)
    params.append(cat_id)
    db.execute(f"UPDATE course_categories SET {', '.join(sets)} WHERE id = %s", params)
    return jsonify(ok=True)


@api.delete("/categories/<cat_id>")
@owner_required
def delete_category(cat_id):
    if db.one("SELECT 1 FROM courses WHERE category_id = %s", (cat_id,)):
        raise Invalid("Move or delete that category's courses first.")
    if db.one("SELECT 1 FROM classes WHERE category_id = %s", (cat_id,)):
        raise Invalid("Move or delete that level's classes first.")
    db.execute("DELETE FROM course_categories WHERE id = %s", (cat_id,))
    return jsonify(ok=True)


# ---------------------------------------------------------------- classes

@api.get("/classes")
@owner_required
def list_classes():
    rows = db.query(
        """SELECT c.*,
                  (SELECT count(*) FROM users u WHERE u.class_id = c.id) AS student_count
             FROM classes c ORDER BY c.name""",
    )
    return jsonify(classes=[{
        "id": r["id"], "name": r["name"], "category_id": r["category_id"],
        "student_count": r["student_count"],
    } for r in rows])


@api.post("/classes")
@owner_required
def create_class():
    data = body()
    name, category_id = need(data, "name", "category_id")
    if db.one("SELECT 1 FROM course_categories WHERE id = %s", (category_id,)) is None:
        raise Invalid("That level doesn't exist.")
    if db.one("SELECT 1 FROM classes WHERE lower(name) = lower(%s)", (name,)):
        raise Invalid("A class with that name already exists.")

    class_id = db.new_id("cls")
    db.execute(
        "INSERT INTO classes (id, name, category_id) VALUES (%s, %s, %s)",
        (class_id, name, category_id),
    )
    return jsonify(id=class_id, name=name, category_id=category_id), 201


@api.patch("/classes/<class_id>")
@owner_required
def update_class(class_id):
    data = body()
    sets, params = [], []
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise Invalid("A class needs a name.")
        clash = db.one(
            "SELECT 1 FROM classes WHERE lower(name) = lower(%s) AND id <> %s",
            (name, class_id),
        )
        if clash:
            raise Invalid("A class with that name already exists.")
        sets.append("name = %s")
        params.append(name)
    if "category_id" in data:
        sets.append("category_id = %s")
        params.append(data["category_id"])
    if not sets:
        return jsonify(ok=True)
    params.append(class_id)
    db.execute(f"UPDATE classes SET {', '.join(sets)} WHERE id = %s", params)
    return jsonify(ok=True)


@api.delete("/classes/<class_id>")
@owner_required
def delete_class(class_id):
    if db.one("SELECT 1 FROM users WHERE class_id = %s", (class_id,)):
        raise Invalid("Move that class's students to another class first.")
    db.execute("DELETE FROM classes WHERE id = %s", (class_id,))
    return jsonify(ok=True)


# ---------------------------------------------------------------- courses

@api.get("/courses")
@owner_required
def list_all_courses():
    rows = db.query("SELECT * FROM courses ORDER BY sort_order, title")
    return jsonify(courses=[course_json(r) for r in rows])


@api.get("/my/courses")
@login_required
def my_courses():
    """Home page + all-courses page. Students see only enrolled courses."""
    user = current_user()
    category = request.args.get("category")

    where = ["true"]
    params = []
    if user["role"] == "teacher":
        sql = "SELECT c.* FROM courses c"
    else:
        sql = """SELECT c.* FROM courses c
                 JOIN enrollments e ON e.course_id = c.id AND e.user_id = %s"""
        params.append(user["id"])
        where.append("c.published")
    if category:
        where.append("c.category_id = %s")
        params.append(category)

    sql += f" WHERE {' AND '.join(where)} ORDER BY c.sort_order, c.title"
    rows = db.query(sql, params)
    progress = progress_for_courses(user["id"], [r["id"] for r in rows])
    return jsonify(courses=[course_json(r, progress[r["id"]]) for r in rows])


@api.post("/courses")
@owner_required
def create_course():
    data = body()
    (title,) = need(data, "title")
    course_id = db.new_id("c")
    db.execute(
        """INSERT INTO courses (id, title, category_id, overview, goals, sort_order)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (course_id, title, data.get("category_id"), data.get("overview"),
         Jsonb(clean_goals(data.get("goals") or [])), int(data.get("sort_order") or 0)),
    )
    return jsonify(id=course_id), 201


@api.patch("/courses/<course_id>")
@owner_required
def update_course(course_id):
    data = body()
    allowed = {"title", "category_id", "overview", "published", "promoted", "sort_order"}
    sets, params = [], []
    for field in allowed & set(data):
        sets.append(f"{field} = %s")
        params.append(data[field])
    if "goals" in data:
        sets.append("goals = %s")
        params.append(Jsonb(clean_goals(data["goals"])))
    if not sets:
        return jsonify(ok=True)
    params.append(course_id)
    db.execute(f"UPDATE courses SET {', '.join(sets)} WHERE id = %s", params)
    return jsonify(ok=True)


@api.delete("/courses/<course_id>")
@owner_required
def delete_course(course_id):
    db.execute("DELETE FROM courses WHERE id = %s", (course_id,))
    return jsonify(ok=True)


@api.post("/courses/<course_id>/duplicate")
@owner_required
def duplicate_course(course_id):
    """Copy a course and everything that describes it — lessons (deep-copied), title card,
    gallery photos, testimonials — into a new course. The copy starts unpublished,
    unpromoted, and with every lesson closed. Per-student data (enrollments, responses,
    completions) is deliberately NOT copied. Runs in the request transaction, so a failure
    rolls the whole thing back (leaving at most a few orphaned S3 copies, which are harmless)."""
    src = db.one("SELECT * FROM courses WHERE id = %s", (course_id,))
    if src is None:
        return jsonify(error="No such course."), 404

    new_id = db.new_id("c")

    new_card_key = None
    if src["title_card_key"]:
        new_card_key = storage.copy(
            src["title_card_key"], f"courses/{new_id}/title-card.{_ext_of(src['title_card_key'])}"
        )

    db.execute(
        """INSERT INTO courses (id, title, category_id, overview, goals, title_card_key,
                                sort_order, published, promoted)
           VALUES (%s, %s, %s, %s, %s, %s, %s, false, false)""",
        (new_id, src["title"] + " (copy)", src["category_id"], src["overview"],
         Jsonb(src["goals"] or []), new_card_key, src["sort_order"]),
    )

    for t in db.query(
        "SELECT * FROM testimonials WHERE course_id = %s ORDER BY sort_order, created_at",
        (course_id,),
    ):
        db.execute(
            """INSERT INTO testimonials (id, course_id, author_name, body, sort_order)
               VALUES (%s, %s, %s, %s, %s)""",
            (db.new_id("t"), new_id, t["author_name"], t["body"], t["sort_order"]),
        )

    for img in course_images(course_id):
        new_img_id = db.new_id("cimg")
        new_key = storage.copy(
            img["key"], f"courses/{new_id}/gallery/{new_img_id}.{_ext_of(img['key'])}"
        )
        if new_key:
            db.execute(
                """INSERT INTO course_images (id, course_id, key, caption, sort_order)
                   VALUES (%s, %s, %s, %s, %s)""",
                (new_img_id, new_id, new_key, img["caption"], img["sort_order"]),
            )

    for lesson in db.query(
        "SELECT * FROM lessons WHERE course_id = %s ORDER BY sort_order, code", (course_id,)
    ):
        new_lesson_id = db.new_id("l")
        content = duplicate_content(lesson["content_json"], new_lesson_id)
        db.execute(
            """INSERT INTO lessons (id, course_id, code, kind, title, sort_order, is_open, content_json)
               VALUES (%s, %s, %s, %s, %s, %s, false, %s)""",
            (new_lesson_id, new_id, lesson["code"], lesson["kind"], lesson["title"],
             lesson["sort_order"], Jsonb(content)),
        )

    return jsonify(id=new_id), 201


@api.post("/courses/<course_id>/title-card")
@owner_required
def upload_title_card(course_id):
    file = request.files.get("file")
    if file is None:
        raise Invalid("No file was sent.")
    course = db.one("SELECT * FROM courses WHERE id = %s", (course_id,))
    if course is None:
        return jsonify(error="No such course."), 404

    ext = storage.extension_for(file.filename, file.mimetype)
    key = f"courses/{course_id}/title-card.{ext}"
    try:
        storage.put(file, key, storage.IMAGE_TYPES)
    except ValueError as exc:
        raise Invalid(str(exc))

    if course["title_card_key"] and course["title_card_key"] != key:
        storage.delete(course["title_card_key"])
    db.execute("UPDATE courses SET title_card_key = %s WHERE id = %s", (key, course_id))
    return jsonify(key=key, url=storage.signed_url(key))


# ---------------------------------------------------------------- course photo gallery

@api.post("/courses/<course_id>/images")
@owner_required
def add_course_image(course_id):
    """Upload one extra promo photo for a course. Mirrors upload_title_card, but appends a
    row to course_images instead of replacing a single key."""
    file = request.files.get("file")
    if file is None:
        raise Invalid("No file was sent.")
    if db.one("SELECT 1 FROM courses WHERE id = %s", (course_id,)) is None:
        return jsonify(error="No such course."), 404

    image_id = db.new_id("cimg")
    ext = storage.extension_for(file.filename, file.mimetype)
    key = f"courses/{course_id}/gallery/{image_id}.{ext}"
    try:
        storage.put(file, key, storage.IMAGE_TYPES)
    except ValueError as exc:
        raise Invalid(str(exc))

    nxt = db.one(
        "SELECT coalesce(max(sort_order), -1) + 1 AS n FROM course_images WHERE course_id = %s",
        (course_id,),
    )["n"]
    db.execute(
        """INSERT INTO course_images (id, course_id, key, caption, sort_order)
           VALUES (%s, %s, %s, %s, %s)""",
        (image_id, course_id, key, (request.form.get("caption") or "").strip() or None, nxt),
    )
    return jsonify(id=image_id, url=storage.signed_url(key),
                   caption=request.form.get("caption")), 201


@api.patch("/courses/<course_id>/images/<image_id>")
@owner_required
def update_course_image(course_id, image_id):
    data = body()
    sets, params = [], []
    if "caption" in data:
        sets.append("caption = %s")
        params.append((data["caption"] or "").strip() or None)
    if "sort_order" in data:
        sets.append("sort_order = %s")
        params.append(int(data["sort_order"]))
    if not sets:
        return jsonify(ok=True)
    params += [image_id, course_id]
    db.execute(
        f"UPDATE course_images SET {', '.join(sets)} WHERE id = %s AND course_id = %s", params
    )
    return jsonify(ok=True)


@api.delete("/courses/<course_id>/images/<image_id>")
@owner_required
def delete_course_image(course_id, image_id):
    row = db.one(
        "SELECT * FROM course_images WHERE id = %s AND course_id = %s", (image_id, course_id)
    )
    if row is None:
        return jsonify(error="No such image."), 404
    storage.delete(row["key"])
    db.execute("DELETE FROM course_images WHERE id = %s", (image_id,))
    return jsonify(ok=True)


@api.get("/courses/<course_id>")
@login_required
def course_detail(course_id):
    user = current_user()
    course = db.one("SELECT * FROM courses WHERE id = %s", (course_id,))
    if course is None:
        return jsonify(error="No such course."), 404
    if not can_view_course(course_id):
        return jsonify(error="You don't have access to this course."), 403

    lessons = lessons_with_state(user, course_id)
    testimonials = db.query(
        "SELECT * FROM testimonials WHERE course_id = %s ORDER BY sort_order, created_at",
        (course_id,),
    )
    # Progress falls out of the rows we already have — no extra round trip.
    progress = {
        "done": sum(1 for l in lessons if l["completed"]),
        "total": len(lessons),
    }

    return jsonify(
        course=course_json(course, progress),
        lessons=[{
            "id": l["id"], "code": l["code"], "kind": l["kind"], "title": l["title"],
            "sort_order": l["sort_order"],
            "block_count": len(blocks_of(l)),
            "is_open": l["is_open"],
            "unlocked": l["unlocked"],
            "completed": l["completed"],
        } for l in lessons],
        testimonials=[{
            "id": t["id"], "author_name": t["author_name"], "body": t["body"],
            "sort_order": t["sort_order"],
        } for t in testimonials],
        images=[image_json(r) for r in course_images(course_id)],
    )


# ---------------------------------------------------------------- public (no login)
# Promotion surface for website visitors. These are the ONLY routes reachable without a
# session, so they must expose marketing info alone — never lesson content, lock state,
# responses, enrollments, or anything about a student. Everything here reads only from
# promoted courses (WHERE c.promoted) and hand-picks the safe fields.

def public_course_json(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "overview": row["overview"],
        "goals": row["goals"] or [],
        "title_card_url": storage.signed_url(row["title_card_key"]),
    }


@api.get("/public/courses")
def public_courses():
    rows = db.query(
        """SELECT c.*, cat.name AS category_name, cat.sort_order AS cat_order
             FROM courses c
             LEFT JOIN course_categories cat ON cat.id = c.category_id
            WHERE c.promoted
            ORDER BY coalesce(cat.sort_order, 999), c.sort_order, c.title"""
    )
    groups = []
    for r in rows:
        key = r["category_id"] or "__none__"
        name = r["category_name"] or "Courses"
        if not groups or groups[-1]["key"] != key:
            groups.append({"key": key, "category_name": name, "courses": []})
        groups[-1]["courses"].append(public_course_json(r))
    return jsonify(groups=groups)


@api.get("/public/courses/<course_id>")
def public_course_detail(course_id):
    # Only promoted courses resolve; anything else is 404 to a visitor.
    course = db.one("SELECT * FROM courses WHERE id = %s AND promoted", (course_id,))
    if course is None:
        return jsonify(error="No such course."), 404
    # Lesson titles only — the promotional syllabus. No content, no counts of answers.
    lessons = db.query(
        "SELECT code, kind, title FROM lessons WHERE course_id = %s ORDER BY sort_order, code",
        (course_id,),
    )
    testimonials = db.query(
        """SELECT author_name, body FROM testimonials WHERE course_id = %s
            ORDER BY sort_order, created_at""",
        (course_id,),
    )
    return jsonify(
        course=public_course_json(course),
        lessons=[{"code": l["code"], "kind": l["kind"], "title": l["title"]} for l in lessons],
        testimonials=[{"author_name": t["author_name"], "body": t["body"]} for t in testimonials],
        images=[{"url": storage.signed_url(r["key"]), "caption": r["caption"]}
                for r in course_images(course_id)],
    )


# ---------------------------------------------------------------- lessons

@api.post("/courses/<course_id>/lessons")
@owner_required
def create_lesson(course_id):
    data = body()
    (title,) = need(data, "title")
    nxt = db.one(
        "SELECT coalesce(max(sort_order), -1) + 1 AS n FROM lessons WHERE course_id = %s",
        (course_id,),
    )["n"]
    lesson_id = db.new_id("l")
    db.execute(
        """INSERT INTO lessons (id, course_id, code, kind, title, sort_order)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (lesson_id, course_id, data.get("code") or f"{nxt + 1}",
         data.get("kind") or "Main", title, nxt),
    )
    return jsonify(id=lesson_id), 201


@api.get("/lessons/<lesson_id>")
@login_required
def get_lesson(lesson_id):
    user = current_user()
    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404
    if not can_view_course(lesson["course_id"]):
        return jsonify(error="You don't have access to this course."), 403

    state = lesson_lock_state(user, lesson["course_id"])[lesson_id]
    if not state["unlocked"]:
        return jsonify(error="This lesson isn't open yet."), 403

    course = db.one("SELECT id, title FROM courses WHERE id = %s", (lesson["course_id"],))
    answers = {
        r["block_id"]: {
            "option_id": r["option_id"], "value_text": r["value_text"],
            "media_url": storage.signed_url(r["media_key"]),
        }
        for r in db.query(
            "SELECT * FROM responses WHERE user_id = %s AND lesson_id = %s",
            (user["id"], lesson_id),
        )
    }

    return jsonify(
        lesson={
            "id": lesson["id"], "code": lesson["code"], "kind": lesson["kind"],
            "title": lesson["title"], "course_id": lesson["course_id"],
            "course_title": course["title"],
            "blocks": hydrate_blocks(blocks_of(lesson)),
        },
        completed=state["completed"],
        answers=answers,
    )


@api.patch("/lessons/<lesson_id>")
@owner_required
def update_lesson(lesson_id):
    data = body()
    sets, params = [], []
    for field in {"title", "code", "kind", "sort_order"} & set(data):
        sets.append(f"{field} = %s")
        params.append(data[field])
    if "is_open" in data:
        sets.append("is_open = %s")
        params.append(bool(data["is_open"]))
    if "content_json" in data:
        content = data["content_json"]
        if not isinstance(content, dict) or not isinstance(content.get("blocks"), list):
            raise Invalid("content_json must be an object with a blocks array.")
        for block in content["blocks"]:
            if not block.get("id") or not block.get("type"):
                raise Invalid("Every block needs a stable id and a type.")
        sets.append("content_json = %s")
        params.append(Jsonb(content))
    if not sets:
        return jsonify(ok=True)

    sets.append("updated_at = now()")
    params.append(lesson_id)
    db.execute(f"UPDATE lessons SET {', '.join(sets)} WHERE id = %s", params)
    return jsonify(ok=True)


@api.delete("/lessons/<lesson_id>")
@owner_required
def delete_lesson(lesson_id):
    db.execute("DELETE FROM lessons WHERE id = %s", (lesson_id,))
    return jsonify(ok=True)


@api.post("/lessons/<lesson_id>/duplicate")
@owner_required
def duplicate_lesson(lesson_id):
    """Copy a lesson within its course. Fresh block ids + media; starts closed."""
    src = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if src is None:
        return jsonify(error="No such lesson."), 404

    new_id = db.new_id("l")
    nxt = db.one(
        "SELECT coalesce(max(sort_order), -1) + 1 AS n FROM lessons WHERE course_id = %s",
        (src["course_id"],),
    )["n"]
    content = duplicate_content(src["content_json"], new_id)
    db.execute(
        """INSERT INTO lessons (id, course_id, code, kind, title, sort_order, is_open, content_json)
           VALUES (%s, %s, %s, %s, %s, %s, false, %s)""",
        (new_id, src["course_id"], src["code"], src["kind"], src["title"] + " (copy)",
         nxt, Jsonb(content)),
    )
    return jsonify(id=new_id), 201


# Per-kind upload rules: which content types are allowed, and the size cap in MB.
UPLOAD_KINDS = {
    "image": (storage.IMAGE_TYPES, 15),
    "audio": (storage.AUDIO_TYPES, 30),
    "video": (storage.VIDEO_TYPES, 200),
}


@api.post("/uploads")
@owner_required
def upload_media():
    """Lesson content media (image, audio, video). Returns the S3 key to store in the
    block; the block never holds the binary, only the key (CLAUDE.md §9)."""
    file = request.files.get("file")
    lesson_id = request.form.get("lesson_id")
    block_id = request.form.get("block_id")
    kind = request.form.get("kind", "image")
    if file is None or not lesson_id or not block_id:
        raise Invalid("file, lesson_id and block_id are all required.")
    if kind not in UPLOAD_KINDS:
        raise Invalid("Unknown upload kind.")
    allowed_types, cap_mb = UPLOAD_KINDS[kind]

    ext = storage.extension_for(file.filename, file.mimetype)
    key = f"lessons/{lesson_id}/{block_id}.{ext}"
    try:
        storage.put(file, key, allowed_types, max_bytes=cap_mb * 1024 * 1024)
    except ValueError as exc:
        raise Invalid(str(exc))
    return jsonify(key=key, url=storage.signed_url(key))


@api.post("/my/uploads")
@login_required
def upload_my_media():
    """A student's answer to an `upload` block: audio or a photo. Stored under a key keyed
    to (user, block) — the stable id an `upload` block never loses (CLAUDE.md §3B) — so a
    resubmit overwrites the same response row and, once uploaded, the same-shaped file."""
    user = current_user()
    file = request.files.get("file")
    lesson_id = request.form.get("lesson_id")
    block_id = request.form.get("block_id")
    if file is None or not lesson_id or not block_id:
        raise Invalid("file, lesson_id and block_id are all required.")

    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404
    if not can_view_course(lesson["course_id"]):
        return jsonify(error="You don't have access to this course."), 403
    if not lesson_lock_state(user, lesson["course_id"])[lesson_id]["unlocked"]:
        return jsonify(error="This lesson isn't open yet."), 403

    block = next((b for b in blocks_of(lesson) if b.get("id") == block_id), None)
    if block is None or block.get("type") != "upload":
        raise Invalid("That upload prompt is no longer part of this lesson.")

    accept = [k for k in (block.get("accept") or ["audio", "image"]) if k in UPLOAD_KINDS]
    content_type = (file.mimetype or "").lower()
    kind = next((k for k in accept if content_type in UPLOAD_KINDS[k][0]), None)
    if kind is None:
        raise Invalid("That file type isn't accepted here.")
    allowed_types, cap_mb = UPLOAD_KINDS[kind]

    ext = storage.extension_for(file.filename, file.mimetype)
    key = f"uploads/{user['id']}/{block_id}.{ext}"

    existing = db.one(
        "SELECT media_key FROM responses WHERE user_id = %s AND block_id = %s",
        (user["id"], block_id),
    )
    try:
        storage.put(file, key, allowed_types, max_bytes=cap_mb * 1024 * 1024)
    except ValueError as exc:
        raise Invalid(str(exc))
    if existing and existing["media_key"] and existing["media_key"] != key:
        storage.delete(existing["media_key"])  # extension changed; drop the old object

    db.execute(
        """INSERT INTO responses (id, user_id, lesson_id, block_id, kind, media_key, status, updated_at)
           VALUES (%s, %s, %s, %s, 'upload', %s, 'submitted', now())
           ON CONFLICT (user_id, block_id)
           DO UPDATE SET media_key = EXCLUDED.media_key,
                         lesson_id = EXCLUDED.lesson_id,
                         kind      = 'upload',
                         status    = 'submitted',
                         updated_at = now()""",
        (db.new_id("r"), user["id"], lesson_id, block_id, key),
    )
    return jsonify(key=key, url=storage.signed_url(key)), 201


# ---------------------------------------------------------------- responses & completion

@api.post("/lessons/<lesson_id>/responses")
@login_required
def submit_response(lesson_id):
    user = current_user()
    data = body()
    block_id, kind = need(data, "block_id", "kind")
    if kind not in INTERACTIVE_TYPES:
        raise Invalid("Unknown answer type.")

    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404
    if not can_view_course(lesson["course_id"]):
        return jsonify(error="You don't have access to this course."), 403
    if not lesson_lock_state(user, lesson["course_id"])[lesson_id]["unlocked"]:
        return jsonify(error="This lesson isn't open yet."), 403

    block = next((b for b in blocks_of(lesson) if b.get("id") == block_id), None)
    if block is None:
        raise Invalid("That question is no longer part of this lesson.")

    db.execute(
        """INSERT INTO responses (id, user_id, lesson_id, block_id, kind,
                                  option_id, value_text, status, updated_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, 'submitted', now())
           ON CONFLICT (user_id, block_id)
           DO UPDATE SET option_id  = EXCLUDED.option_id,
                         value_text = EXCLUDED.value_text,
                         lesson_id  = EXCLUDED.lesson_id,
                         updated_at = now()""",
        (db.new_id("r"), user["id"], lesson_id, block_id, kind,
         data.get("option_id"), data.get("value_text")),
    )
    return jsonify(ok=True)


@api.post("/lessons/<lesson_id>/complete")
@login_required
def complete_lesson(lesson_id):
    user = current_user()
    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404
    if not can_view_course(lesson["course_id"]):
        return jsonify(error="You don't have access to this course."), 403
    if not lesson_lock_state(user, lesson["course_id"])[lesson_id]["unlocked"]:
        return jsonify(error="This lesson isn't open yet."), 403

    db.execute(
        """INSERT INTO lesson_completions (id, user_id, lesson_id)
           VALUES (%s, %s, %s) ON CONFLICT (user_id, lesson_id) DO NOTHING""",
        (db.new_id("lc"), user["id"], lesson_id),
    )
    return jsonify(ok=True)


# ---------------------------------------------------------------- testimonials

@api.get("/courses/<course_id>/testimonials")
@login_required
def list_testimonials(course_id):
    if not can_view_course(course_id):
        return jsonify(error="You don't have access to this course."), 403
    rows = db.query(
        "SELECT * FROM testimonials WHERE course_id = %s ORDER BY sort_order, created_at",
        (course_id,),
    )
    return jsonify(testimonials=[
        {"id": r["id"], "author_name": r["author_name"], "body": r["body"]} for r in rows
    ])


@api.post("/courses/<course_id>/testimonials")
@owner_required
def create_testimonial(course_id):
    data = body()
    author, text = need(data, "author_name", "body")
    tid = db.new_id("t")
    nxt = db.one(
        "SELECT coalesce(max(sort_order), -1) + 1 AS n FROM testimonials WHERE course_id = %s",
        (course_id,),
    )["n"]
    db.execute(
        """INSERT INTO testimonials (id, course_id, author_name, body, sort_order)
           VALUES (%s, %s, %s, %s, %s)""",
        (tid, course_id, author, text, nxt),
    )
    return jsonify(id=tid), 201


@api.delete("/testimonials/<tid>")
@owner_required
def delete_testimonial(tid):
    db.execute("DELETE FROM testimonials WHERE id = %s", (tid,))
    return jsonify(ok=True)


# ---------------------------------------------------------------- students (teacher)

@api.get("/students")
@owner_required
def list_students():
    """The table shows exactly one level at a time — that's what keeps the course-assign
    grid narrow. `level=none` is the bucket for students who have no class yet."""
    q = (request.args.get("q") or "").strip()
    level = request.args.get("level")
    class_id = request.args.get("class_id")

    sql = """SELECT u.*, cl.name AS class_name, cl.category_id, ic.code AS invite_code
               FROM users u
               LEFT JOIN classes cl ON cl.id = u.class_id
               LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
              WHERE u.role = 'student'"""
    params = []

    if level == "none":
        sql += " AND u.class_id IS NULL"
    elif level:
        sql += " AND cl.category_id = %s"
        params.append(level)
    if class_id:
        sql += " AND u.class_id = %s"
        params.append(class_id)
    if q:
        # The registration code is searchable too, not just a column.
        sql += " AND (u.name ILIKE %s OR u.email ILIKE %s OR ic.code ILIKE %s)"
        params += [f"%{q}%", f"%{q}%", f"%{q}%"]
    sql += " ORDER BY u.name"

    students = db.query(sql, params)

    enrolled = {}
    for row in db.query("SELECT user_id, course_id FROM enrollments"):
        enrolled.setdefault(row["user_id"], []).append(row["course_id"])
    completed = {
        r["user_id"]: r["n"] for r in db.query(
            "SELECT user_id, count(*) AS n FROM lesson_completions GROUP BY user_id"
        )
    }

    return jsonify(students=[{
        "id": s["id"], "name": s["name"], "email": s["email"],
        "created_at": s["created_at"].isoformat(),
        "active": s["active"],
        "class_id": s["class_id"], "class_name": s["class_name"],
        "category_id": s["category_id"], "invite_code": s["invite_code"],
        "course_ids": enrolled.get(s["id"], []),
        "lessons_completed": completed.get(s["id"], 0),
    } for s in students])


@api.get("/students/counts")
@owner_required
def student_counts():
    """How many students sit at each level. Drives the tab badges, whether the
    'Unassigned' tab appears at all, and which level the dashboard opens on."""
    rows = db.query(
        """SELECT cl.category_id, count(*) AS n
             FROM users u
             LEFT JOIN classes cl ON cl.id = u.class_id
            WHERE u.role = 'student'
            GROUP BY cl.category_id"""
    )
    levels = {r["category_id"]: r["n"] for r in rows if r["category_id"]}
    unassigned = next((r["n"] for r in rows if r["category_id"] is None), 0)
    return jsonify(levels=levels, unassigned=unassigned)


@api.patch("/students/<student_id>")
@owner_required
def update_student(student_id):
    """Move a student to another class (which moves their level), and/or turn their
    access on or off. Moving a class leaves course access alone — nothing is revoked
    behind their back. Turning access off blocks login but keeps the account and answers.
    """
    data = body()
    sets, params = [], []

    if "class_id" in data:
        class_id = data["class_id"] or None
        if class_id and db.one("SELECT 1 FROM classes WHERE id = %s", (class_id,)) is None:
            raise Invalid("That class doesn't exist.")
        sets.append("class_id = %s")
        params.append(class_id)

    if "active" in data:
        sets.append("active = %s")
        params.append(bool(data["active"]))

    if not sets:
        return jsonify(ok=True)

    params.append(student_id)
    changed = db.execute(
        f"UPDATE users SET {', '.join(sets)} WHERE id = %s AND role = 'student'", params
    )
    if not changed:
        return jsonify(error="No such student."), 404
    return jsonify(ok=True)


@api.get("/students/<student_id>")
@owner_required
def student_detail(student_id):
    student = db.one(
        "SELECT * FROM users WHERE id = %s AND role = 'student'", (student_id,)
    )
    if student is None:
        return jsonify(error="No such student."), 404

    courses = db.query(
        """SELECT c.* FROM courses c
           JOIN enrollments e ON e.course_id = c.id AND e.user_id = %s
           ORDER BY c.sort_order, c.title""",
        (student_id,),
    )
    answers = db.query(
        """SELECT r.*, l.title AS lesson_title, l.id AS lid
           FROM responses r JOIN lessons l ON l.id = r.lesson_id
           WHERE r.user_id = %s ORDER BY r.updated_at DESC""",
        (student_id,),
    )
    progress = progress_for_courses(student_id, [c["id"] for c in courses])
    return jsonify(
        student=public_user(student),
        courses=[course_json(c, progress[c["id"]]) for c in courses],
        answers=[{
            "block_id": a["block_id"], "kind": a["kind"], "lesson_id": a["lid"],
            "lesson_title": a["lesson_title"], "option_id": a["option_id"],
            "value_text": a["value_text"],
            "updated_at": a["updated_at"].isoformat(),
        } for a in answers],
    )


@api.post("/courses/<course_id>/enrollments")
@owner_required
def enroll(course_id):
    data = body()
    (user_id,) = need(data, "user_id")
    db.execute(
        """INSERT INTO enrollments (id, user_id, course_id) VALUES (%s, %s, %s)
           ON CONFLICT (user_id, course_id) DO NOTHING""",
        (db.new_id("e"), user_id, course_id),
    )
    return jsonify(ok=True), 201


@api.delete("/courses/<course_id>/enrollments/<user_id>")
@owner_required
def unenroll(course_id, user_id):
    db.execute(
        "DELETE FROM enrollments WHERE course_id = %s AND user_id = %s",
        (course_id, user_id),
    )
    return jsonify(ok=True)


# ---------------------------------------------------------------- invite codes

@api.get("/invite-codes")
@owner_required
def list_invite_codes():
    # Only codes still usable — active, and not a single-use code that's been redeemed.
    # A redeemed one-per-student code has done its job; showing it just clutters the list.
    rows = db.query(
        """SELECT ic.*, cl.name AS class_name, cl.category_id
             FROM invite_codes ic
             LEFT JOIN classes cl ON cl.id = ic.class_id
            WHERE ic.active AND (ic.max_uses IS NULL OR ic.uses < ic.max_uses)
            ORDER BY cl.name, ic.created_at DESC"""
    )
    return jsonify(codes=[{
        "id": r["id"], "code": r["code"], "note": r["note"],
        "max_uses": r["max_uses"], "uses": r["uses"], "active": r["active"],
        "class_id": r["class_id"], "class_name": r["class_name"],
        "category_id": r["category_id"],
    } for r in rows])


def code_slug(name):
    """General -> GENERAL, Group A/B -> GROUPAB. Letters and digits only, so the
    code stays easy to read out over the phone."""
    slug = re.sub(r"[^A-Za-z0-9]", "", name).upper()
    return slug[:16] or "CLASS"


@api.post("/invite-codes")
@owner_required
def create_invite_code():
    data = body()
    (class_id,) = need(data, "class_id")
    klass = db.one("SELECT * FROM classes WHERE id = %s", (class_id,))
    if klass is None:
        raise Invalid("Pick the class this code is for.")

    # The class name prefixes the code, so the teacher can tell at a glance who it's for.
    for _ in range(5):
        code = f"{code_slug(klass['name'])}-{secrets.token_hex(2).upper()}"
        if not db.one("SELECT 1 FROM invite_codes WHERE lower(code) = lower(%s)", (code,)):
            break
    else:
        raise Invalid("Couldn't mint a unique code — try again.")

    max_uses = data.get("max_uses")
    db.execute(
        """INSERT INTO invite_codes (id, code, note, max_uses, class_id)
           VALUES (%s, %s, %s, %s, %s)""",
        (db.new_id("ic"), code, data.get("note"),
         int(max_uses) if max_uses not in (None, "", 0) else None, class_id),
    )
    return jsonify(code=code, class_name=klass["name"]), 201


@api.patch("/invite-codes/<code_id>")
@owner_required
def update_invite_code(code_id):
    data = body()
    if "active" in data:
        db.execute(
            "UPDATE invite_codes SET active = %s WHERE id = %s",
            (bool(data["active"]), code_id),
        )
    return jsonify(ok=True)


# ---------------------------------------------------------------- response views (teacher)

@api.get("/lessons/<lesson_id>/responses")
@owner_required
def lesson_responses(lesson_id):
    """Every interactive block in the lesson, each with its respondent count."""
    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404

    counts = {
        r["block_id"]: r["n"] for r in db.query(
            "SELECT block_id, count(*) AS n FROM responses WHERE lesson_id = %s "
            "GROUP BY block_id",
            (lesson_id,),
        )
    }
    quizzes = [{
        "block_id": b["id"],
        "type": b["type"],
        "question": b.get("question") or b.get("prompt") or "(untitled)",
        "respondents": counts.get(b["id"], 0),
    } for b in blocks_of(lesson) if b.get("type") in INTERACTIVE_TYPES]

    return jsonify(
        lesson={"id": lesson["id"], "title": lesson["title"], "code": lesson["code"]},
        quizzes=quizzes,
    )


@api.get("/lessons/<lesson_id>/blocks/<block_id>/responses")
@owner_required
def block_responses(lesson_id, block_id):
    """Answer-sharing view for one question."""
    lesson = db.one("SELECT * FROM lessons WHERE id = %s", (lesson_id,))
    if lesson is None:
        return jsonify(error="No such lesson."), 404
    block = next((b for b in blocks_of(lesson) if b.get("id") == block_id), None)
    if block is None:
        return jsonify(error="No such question."), 404

    options = {o["id"]: o["text"] for o in (block.get("options") or [])}
    rows = db.query(
        """SELECT r.*, u.name FROM responses r JOIN users u ON u.id = r.user_id
           WHERE r.lesson_id = %s AND r.block_id = %s ORDER BY r.updated_at DESC""",
        (lesson_id, block_id),
    )

    answers = []
    for r in rows:
        # An option the teacher has since deleted no longer resolves — say so, don't crash.
        option_text = options.get(r["option_id"], "(removed option)") \
            if r["option_id"] else None
        answers.append({
            "student_id": r["user_id"], "student_name": r["name"],
            "option_id": r["option_id"], "option_text": option_text,
            "correct": (r["option_id"] == block.get("correctId")) if r["option_id"] else None,
            "value_text": r["value_text"],
            "media_url": storage.signed_url(r["media_key"]),
            "updated_at": r["updated_at"].isoformat(),
        })

    return jsonify(block=hydrate_blocks([block])[0], answers=answers)


@api.get("/courses/<course_id>/responses")
@owner_required
def course_responses(course_id):
    """Every quiz in the course, grouped by lesson — the dashboard's Responses section."""
    lessons = db.query(
        "SELECT * FROM lessons WHERE course_id = %s ORDER BY sort_order, code",
        (course_id,),
    )
    counts = {}
    for r in db.query(
        """SELECT r.block_id, count(*) AS n FROM responses r
           JOIN lessons l ON l.id = r.lesson_id
           WHERE l.course_id = %s GROUP BY r.block_id""",
        (course_id,),
    ):
        counts[r["block_id"]] = r["n"]

    out = []
    for lesson in lessons:
        quizzes = [{
            "block_id": b["id"], "type": b["type"],
            "question": b.get("question") or b.get("prompt") or "(untitled)",
            "respondents": counts.get(b["id"], 0),
        } for b in blocks_of(lesson) if b.get("type") in INTERACTIVE_TYPES]
        if quizzes:
            out.append({
                "lesson_id": lesson["id"], "lesson_title": lesson["title"],
                "lesson_code": lesson["code"], "quizzes": quizzes,
            })
    return jsonify(lessons=out)
