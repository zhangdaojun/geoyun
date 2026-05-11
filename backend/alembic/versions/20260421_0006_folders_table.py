"""add folders table

Revision ID: 20260421_0006
Revises: 20260421_0005
Create Date: 2026-04-21 17:20:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0006"
down_revision = "20260421_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "folders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("external_folder_id", sa.String(length=128), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("parent_external_folder_id", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=True),
        sa.Column("task_name", sa.String(length=128), nullable=True),
        sa.Column("survey_method", sa.String(length=128), nullable=True),
        sa.Column("instrument_type", sa.String(length=64), nullable=True),
        sa.Column("instrument_label", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "external_folder_id", name="uq_folders_project_external"),
    )
    op.create_index("ix_folders_external_folder_id", "folders", ["external_folder_id"])
    op.create_index("ix_folders_project_id", "folders", ["project_id"])
    op.create_index(
        "ix_folders_parent_external_folder_id",
        "folders",
        ["parent_external_folder_id"],
    )
    op.create_index("ix_folders_category", "folders", ["category"])
    op.create_index("ix_folders_status", "folders", ["status"])


def downgrade() -> None:
    op.drop_index("ix_folders_status", table_name="folders")
    op.drop_index("ix_folders_category", table_name="folders")
    op.drop_index("ix_folders_parent_external_folder_id", table_name="folders")
    op.drop_index("ix_folders_project_id", table_name="folders")
    op.drop_index("ix_folders_external_folder_id", table_name="folders")
    op.drop_table("folders")
