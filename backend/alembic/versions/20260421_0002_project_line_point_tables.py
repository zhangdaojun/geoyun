"""create project line and point tables

Revision ID: 20260421_0002
Revises: 20260421_0001
Create Date: 2026-04-21 12:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0002"
down_revision = "20260421_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("external_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("location", sa.String(length=128), nullable=True),
        sa.Column("method", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="planning"),
        sa.Column("manager", sa.String(length=64), nullable=True),
        sa.Column("center_latitude", sa.Float(), nullable=True),
        sa.Column("center_longitude", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_projects_external_id", "projects", ["external_id"], unique=True)
    op.create_index("ix_projects_name", "projects", ["name"], unique=False)
    op.create_index("ix_projects_status", "projects", ["status"], unique=False)

    op.create_table(
        "survey_lines",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("line_code", sa.String(length=64), nullable=False),
        sa.Column("instrument", sa.String(length=32), nullable=False, server_default="EH4"),
        sa.Column("display_name", sa.String(length=128), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "project_id",
            "line_code",
            "instrument",
            name="uq_survey_lines_project_line_instrument",
        ),
    )
    op.create_index("ix_survey_lines_project_id", "survey_lines", ["project_id"], unique=False)
    op.create_index("ix_survey_lines_line_code", "survey_lines", ["line_code"], unique=False)
    op.create_index("ix_survey_lines_instrument", "survey_lines", ["instrument"], unique=False)

    op.create_table(
        "survey_points",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "survey_line_id",
            sa.Integer(),
            sa.ForeignKey("survey_lines.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("point_code", sa.String(length=64), nullable=False),
        sa.Column("instrument", sa.String(length=32), nullable=False, server_default="EH4"),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("elevation", sa.Float(), nullable=True),
        sa.Column("point_status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("matched_data_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("has_existing_data", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("survey_line_id", "point_code", name="uq_survey_points_line_point"),
    )
    op.create_index(
        "ix_survey_points_survey_line_id",
        "survey_points",
        ["survey_line_id"],
        unique=False,
    )
    op.create_index("ix_survey_points_point_code", "survey_points", ["point_code"], unique=False)
    op.create_index("ix_survey_points_instrument", "survey_points", ["instrument"], unique=False)
    op.create_index(
        "ix_survey_points_point_status",
        "survey_points",
        ["point_status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_survey_points_point_status", table_name="survey_points")
    op.drop_index("ix_survey_points_instrument", table_name="survey_points")
    op.drop_index("ix_survey_points_point_code", table_name="survey_points")
    op.drop_index("ix_survey_points_survey_line_id", table_name="survey_points")
    op.drop_table("survey_points")

    op.drop_index("ix_survey_lines_instrument", table_name="survey_lines")
    op.drop_index("ix_survey_lines_line_code", table_name="survey_lines")
    op.drop_index("ix_survey_lines_project_id", table_name="survey_lines")
    op.drop_table("survey_lines")

    op.drop_index("ix_projects_status", table_name="projects")
    op.drop_index("ix_projects_name", table_name="projects")
    op.drop_index("ix_projects_external_id", table_name="projects")
    op.drop_table("projects")
