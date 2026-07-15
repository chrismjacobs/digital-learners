"""Session-cookie auth. One teacher (owner), everyone else a student."""
from functools import wraps

from flask import session, jsonify, g

import db


def current_user():
    """The logged-in user row, or None. Cached per request."""
    if "user" in g:
        return g.user
    uid = session.get("user_id")
    g.user = db.one(
        "SELECT id, role, name, email, active, created_at FROM users WHERE id = %s", (uid,)
    ) if uid else None
    return g.user


DISABLED_MESSAGE = "Your access has been turned off. Please ask your teacher."


def login_user(user):
    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True
    g.user = user


def logout_user():
    session.clear()
    g.pop("user", None)


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return jsonify(error="Please sign in."), 401
        if not user["active"]:
            return jsonify(error=DISABLED_MESSAGE), 403
        return fn(*args, **kwargs)
    return wrapper


def owner_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return jsonify(error="Please sign in."), 401
        if user["role"] != "teacher":
            return jsonify(error="Teacher only."), 403
        return fn(*args, **kwargs)
    return wrapper


def is_teacher():
    user = current_user()
    return user is not None and user["role"] == "teacher"


def is_enrolled(user_id, course_id):
    return db.one(
        "SELECT 1 FROM enrollments WHERE user_id = %s AND course_id = %s",
        (user_id, course_id),
    ) is not None


def can_view_course(course_id):
    """Teacher sees everything; a student sees only courses they're enrolled in."""
    user = current_user()
    if user is None:
        return False
    if user["role"] == "teacher":
        return True
    return is_enrolled(user["id"], course_id)
