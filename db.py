"""Postgres access. Pooled connections, raw SQL, dict rows.

The database is in Neon, not on the app host, so every connection costs a TLS round
trip (a good fraction of a second). The pool keeps a few open and hands one to each
request; without it, a single-query page waits that long before it starts working.

Neon also hangs up on connections that sit idle, and this app idles a lot (the Render
free tier sleeps after ~15 min). So the pool can hold a socket that is already dead.
That failure always surfaces on the *first* statement of a request — the connection
died while it was idle in the pool, not while we were using it — so the first
statement, and only the first, is retried on a fresh connection. Retrying any later
statement would risk re-running half of a transaction, so those errors are raised.
"""
import os
import secrets

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from flask import g

_pool = None


def pool():
    global _pool
    if _pool is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL is not set")
        _pool = ConnectionPool(
            url, min_size=1, max_size=8, timeout=15, max_idle=300,
            kwargs={"row_factory": dict_row},
            open=True,
        )
    return _pool


def conn():
    """The request-scoped connection, borrowed from the pool."""
    if "db" not in g:
        g.db = pool().getconn()
        g.db_used = False        # no statement has run on it yet
    return g.db


def _discard():
    """Throw away a connection that was dead on arrival. Handing a closed connection
    back to the pool makes the pool drop it and open a replacement."""
    broken = g.pop("db", None)
    g.pop("db_used", None)
    if broken is None:
        return
    try:
        broken.close()
    except Exception:
        pass
    try:
        pool().putconn(broken)
    except Exception:
        pass


def close_conn(exc=None):
    db = g.pop("db", None)
    g.pop("db_used", None)
    if db is None:
        return
    try:
        if exc is None:
            db.commit()
        else:
            db.rollback()
    except psycopg.Error:
        pass
    finally:
        pool().putconn(db)


def _attempt(sql, params, mode):
    with conn().cursor() as cur:
        cur.execute(sql, params)
        g.db_used = True
        if mode == "all":
            return cur.fetchall()
        if mode == "one":
            return cur.fetchone()
        return cur.rowcount


def _run(sql, params, mode):
    try:
        return _attempt(sql, params, mode)
    except psycopg.OperationalError:
        if g.get("db_used", True):
            raise        # it died mid-request: a real failure, not a stale socket
        _discard()
        return _attempt(sql, params, mode)


def query(sql, params=()):
    return _run(sql, params, "all")


def one(sql, params=()):
    return _run(sql, params, "one")


def execute(sql, params=()):
    return _run(sql, params, "rowcount")


def new_id(prefix):
    return f"{prefix}_{secrets.token_hex(6)}"
