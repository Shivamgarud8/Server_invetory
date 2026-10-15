import csv
import io
from datetime import datetime

from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Environment, Tag


def get_tags(db: Session, ids: list[int]) -> list[Tag]:
    if not ids:
        return []
    tags = list(db.scalars(select(Tag).where(Tag.id.in_(ids))))
    if len(tags) != len(set(ids)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown tag")
    return tags


def get_env(db: Session, env_id: int) -> Environment:
    env = db.get(Environment, env_id)
    if not env:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown environment")
    return env


def scope(query, column, env_ids: set[int] | None):
    return query if env_ids is None else query.where(column.in_(env_ids or {-1}))


def like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _safe_cell(v) -> str:
    """Neutralise spreadsheet formula injection in exported values."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def csv_response(filename: str, header: list[str], rows: list[list]) -> StreamingResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow([_safe_cell(v) for v in r])
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}-{stamp}.csv"'},
    )
