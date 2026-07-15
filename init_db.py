"""Create the schema, the one teacher account, and a starter invite code.

    python init_db.py           schema + teacher + invite code
    python init_db.py --demo    also seeds a demo course, lessons and a student

Safe to re-run: the schema is CREATE TABLE IF NOT EXISTS and the seeds upsert.
"""
import sys

from dotenv import load_dotenv

load_dotenv()

import os
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from werkzeug.security import generate_password_hash

TEACHER_ID = "u_teacher"
STARTER_CLASS = ("cls_sunflowers", "Sunflowers", "cat_kids1")
STARTER_CODE = "SUNFLOWERS-0001"


def main():
    demo = "--demo" in sys.argv
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(open("schema.sql", encoding="utf-8").read())
            print("schema ok")

            email = os.environ["ADMIN_EMAIL"].lower()
            cur.execute(
                """INSERT INTO users (id, role, name, email, password_hash)
                   VALUES (%s, 'teacher', 'Mama Lucy', %s, %s)
                   ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
                                                  password_hash = EXCLUDED.password_hash""",
                (TEACHER_ID, email, generate_password_hash(os.environ["ADMIN_PASSWORD"])),
            )
            print(f"teacher ok -> {email}")

            # Every code belongs to a class, so the starter code needs a starter class.
            class_id, class_name, class_level = STARTER_CLASS
            cur.execute(
                """INSERT INTO classes (id, name, category_id) VALUES (%s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
                                                  category_id = EXCLUDED.category_id""",
                STARTER_CLASS,
            )
            # The class-less EXPLORER code predates classes. Retire it, but only after
            # detaching any student who joined with it — their account survives, they
            # just land in the Unassigned bucket for the teacher to place.
            cur.execute(
                """UPDATE users SET invite_code_id = NULL
                    WHERE invite_code_id IN (SELECT id FROM invite_codes WHERE code = 'EXPLORER')"""
            )
            cur.execute("DELETE FROM invite_codes WHERE code = 'EXPLORER'")
            cur.execute(
                """INSERT INTO invite_codes (id, code, note, class_id)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET code     = EXCLUDED.code,
                                                  note     = EXCLUDED.note,
                                                  class_id = EXCLUDED.class_id""",
                ("ic_starter", STARTER_CODE, "Starter code", class_id),
            )
            print(f"class ok -> {class_name} ({class_level})")
            print(f"invite code ok -> {STARTER_CODE}")

            if demo:
                seed_demo(cur)
        conn.commit()
    print("done")


def seed_demo(cur):
    course_id = "c_demo"
    cur.execute(
        """INSERT INTO courses (id, title, category_id, overview, goals, published, sort_order)
           VALUES (%s, %s, 'cat_kids1', %s, %s, true, 0)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
                                          overview = EXCLUDED.overview,
                                          goals = EXCLUDED.goals,
                                          published = true""",
        (course_id, "Colours & Shapes",
         "Learn your first colour and shape words, and use them to describe things "
         "around you. By the end you can name ten colours and five shapes out loud.",
         Jsonb([
             "Name ten colours out loud",
             "Name five shapes and count their sides",
             "Describe an object using both a colour and a shape",
         ])),
    )

    lessons = [
        ("l_demo1", "1-1", "Preview", "Meet the Colours", 0, {"blocks": [
            {"id": "b_t1", "type": "title", "text": "Colours Around Us"},
            {"id": "b_x1", "type": "text",
             "text": "Say each colour out loud as you read it. Red, blue, yellow, green."},
            {"id": "b_p1", "type": "prompt", "text": "Find something red in your room."},
            {"id": "b_q1", "type": "quiz_mc",
             "question": "What colour is the sky on a sunny day?",
             "options": [{"id": "o1", "text": "Blue"}, {"id": "o2", "text": "Red"},
                         {"id": "o3", "text": "Green"}],
             "correctId": "o1",
             "feedbackCorrect": "Yes! The sky is blue.",
             "feedbackWrong": "Look up outside — try again!"},
            {"id": "b_q2", "type": "quiz_open",
             "question": "Write three things that are red."},
        ]}),
        ("l_demo2", "1-2", "Main", "Shapes We See", 1, {"blocks": [
            {"id": "b_t2", "type": "title", "text": "Circles, Squares, Triangles"},
            {"id": "b_x2", "type": "text",
             "text": "A circle is round. A square has four equal sides."},
            {"id": "b_v2", "type": "video", "url": "https://www.youtube.com/watch?v=OEbRDtCAFdU",
             "label": "The Shapes Song"},
            {"id": "b_q3", "type": "quiz_mc",
             "question": "How many sides does a triangle have?",
             "options": [{"id": "o1", "text": "Three"}, {"id": "o2", "text": "Four"}],
             "correctId": "o1",
             "feedbackCorrect": "Correct — tri means three!",
             "feedbackWrong": "Count the corners again."},
        ]}),
        ("l_demo3", "1-3", "Review", "Colour & Shape Review", 2, {"blocks": [
            {"id": "b_t3", "type": "title", "text": "Let's Review"},
            {"id": "b_q4", "type": "quiz_open",
             "question": "Describe your favourite toy using a colour and a shape."},
        ]}),
    ]
    for lid, code, kind, title, order, content in lessons:
        cur.execute(
            """INSERT INTO lessons (id, course_id, code, kind, title, sort_order, content_json)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
                                              content_json = EXCLUDED.content_json,
                                              updated_at = now()""",
            (lid, course_id, code, kind, title, order, Jsonb(content)),
        )

    cur.execute(
        """INSERT INTO testimonials (id, course_id, author_name, body, sort_order)
           VALUES (%s, %s, %s, %s, 0) ON CONFLICT (id) DO NOTHING""",
        ("t_demo1", course_id, "Ping's mum",
         "My daughter asks to do her English lesson before dinner now. Thank you!"),
    )

    student_id = "u_demo_student"
    cur.execute(
        """INSERT INTO users (id, role, name, email, password_hash, class_id, invite_code_id)
           VALUES (%s, 'student', 'Demo Student', 'student@example.com', %s, %s, 'ic_starter')
           ON CONFLICT (id) DO UPDATE SET password_hash  = EXCLUDED.password_hash,
                                          class_id       = EXCLUDED.class_id,
                                          invite_code_id = EXCLUDED.invite_code_id""",
        (student_id, generate_password_hash("student123"), STARTER_CLASS[0]),
    )
    cur.execute(
        """INSERT INTO enrollments (id, user_id, course_id) VALUES (%s, %s, %s)
           ON CONFLICT (user_id, course_id) DO NOTHING""",
        ("e_demo", student_id, course_id),
    )
    print(f"demo course + student ok -> student@example.com / student123 "
          f"(class {STARTER_CLASS[1]})")


if __name__ == "__main__":
    main()
