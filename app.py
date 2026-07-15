"""Mama Lucy's English Explorers — Flask entrypoint.

Local:  python app.py
Render: gunicorn app:app
"""
import os
from datetime import timedelta

from dotenv import load_dotenv
from flask import Flask, render_template, jsonify

load_dotenv()

import db  # noqa: E402  (must come after load_dotenv)
from api import api  # noqa: E402

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ["SECRET_KEY"],
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Render terminates TLS; locally we're on plain http.
    SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV") != "development",
    # Must clear the largest per-kind upload cap in api.UPLOAD_KINDS (video, 200MB),
    # since Flask rejects an over-size request before our handler's own check runs.
    MAX_CONTENT_LENGTH=210 * 1024 * 1024,
    JSON_SORT_KEYS=False,
)
app.teardown_appcontext(db.close_conn)
app.register_blueprint(api)


@app.errorhandler(413)
def too_large(_exc):
    return jsonify(error="That file is too big to upload."), 413


@app.errorhandler(500)
def server_error(_exc):
    return jsonify(error="Something went wrong on our end."), 500


@app.get("/healthz")
def healthz():
    db.one("SELECT 1")
    return jsonify(ok=True)


@app.get("/")
@app.get("/<path:client_route>")
def index(client_route=None):
    """The client is a single page; it does its own hash routing. Unknown /api paths
    must still answer as the API, not with the page."""
    if client_route and client_route.startswith("api/"):
        return jsonify(error="No such endpoint."), 404
    return render_template("index.html")


if __name__ == "__main__":
    os.environ.setdefault("FLASK_ENV", "development")
    app.config["SESSION_COOKIE_SECURE"] = False
    app.run(host="127.0.0.1", port=5000, debug=True)
