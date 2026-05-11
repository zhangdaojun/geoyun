"""add survey point import metadata

Revision ID: 20260422_0007
Revises: 20260421_0006
Create Date: 2026-04-22 10:30:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260422_0007"
down_revision = "20260421_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "survey_points",
        sa.Column("source_coord_file_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "survey_points",
        sa.Column("source_coord_file_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "survey_points",
        sa.Column("matched_data_paths_json", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_survey_points_source_coord_file_id",
        "survey_points",
        ["source_coord_file_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_survey_points_source_coord_file_id", table_name="survey_points")
    op.drop_column("survey_points", "matched_data_paths_json")
    op.drop_column("survey_points", "source_coord_file_name")
    op.drop_column("survey_points", "source_coord_file_id")
