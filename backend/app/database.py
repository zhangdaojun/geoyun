from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import get_settings

Base = declarative_base()


def _create_engine(database_url: str):
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    return create_engine(database_url, future=True, pool_pre_ping=True, connect_args=connect_args)


settings = get_settings()
engine = _create_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def configure_database(database_url: str):
    global engine, SessionLocal
    engine = _create_engine(database_url)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def ensure_runtime_schema():
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "survey_points" not in table_names:
        return

    existing_columns = {column["name"] for column in inspector.get_columns("survey_points")}
    alter_statements = []
    if "source_coord_file_id" not in existing_columns:
        alter_statements.append(
            "ALTER TABLE survey_points ADD COLUMN source_coord_file_id VARCHAR(128)"
        )
    if "source_coord_file_name" not in existing_columns:
        alter_statements.append(
            "ALTER TABLE survey_points ADD COLUMN source_coord_file_name VARCHAR(255)"
        )
    if "matched_data_paths_json" not in existing_columns:
        alter_statements.append(
            "ALTER TABLE survey_points ADD COLUMN matched_data_paths_json JSON"
        )
    if "matched_file_ids_json" not in existing_columns:
        alter_statements.append(
            "ALTER TABLE survey_points ADD COLUMN matched_file_ids_json JSON"
        )

    if not alter_statements:
        return

    with engine.begin() as connection:
        for statement in alter_statements:
            connection.execute(text(statement))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def db_session():
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
