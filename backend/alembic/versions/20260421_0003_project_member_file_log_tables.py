"""create project member file and activity log tables

Revision ID: 20260421_0003
Revises: 20260421_0002
Create Date: 2026-04-21 15:55:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0003"
down_revision = "20260421_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_members",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("account", sa.String(length=64), nullable=True),
        sa.Column("project_role", sa.String(length=32), nullable=False, server_default="viewer"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("invited_at", sa.String(length=64), nullable=True),
        sa.Column("invited_by", sa.String(length=64), nullable=True),
        sa.Column("joined_at", sa.String(length=64), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
    )
    op.create_index(
        "ix_project_members_project_id", "project_members", ["project_id"], unique=False
    )
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"], unique=False)
    op.create_index("ix_project_members_status", "project_members", ["status"], unique=False)

    op.create_table(
        "project_files",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("file_id", sa.String(length=128), nullable=False),
        sa.Column("parent_id", sa.String(length=128), nullable=True),
        sa.Column("item_type", sa.String(length=32), nullable=False, server_default="file"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("date", sa.String(length=64), nullable=True),
        sa.Column("size", sa.String(length=64), nullable=True),
        sa.Column("ext", sa.String(length=64), nullable=True),
        sa.Column("category", sa.String(length=64), nullable=True),
        sa.Column("task_name", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=64), nullable=True),
        sa.Column("persisted_blob_id", sa.String(length=128), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("project_id", "file_id", name="uq_project_files_project_file"),
    )
    op.create_index("ix_project_files_project_id", "project_files", ["project_id"], unique=False)
    op.create_index("ix_project_files_parent_id", "project_files", ["parent_id"], unique=False)
    op.create_index("ix_project_files_item_type", "project_files", ["item_type"], unique=False)
    op.create_index("ix_project_files_category", "project_files", ["category"], unique=False)

    op.create_table(
        "project_activity_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("log_id", sa.String(length=128), nullable=False),
        sa.Column("node_id", sa.String(length=64), nullable=True),
        sa.Column("node_name", sa.String(length=128), nullable=True),
        sa.Column("level", sa.String(length=32), nullable=False, server_default="info"),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("node_status", sa.String(length=64), nullable=True),
        sa.Column("actor_name", sa.String(length=64), nullable=True),
        sa.Column("event_time", sa.String(length=64), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_project_activity_logs_project_id",
        "project_activity_logs",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        "ix_project_activity_logs_log_id", "project_activity_logs", ["log_id"], unique=False
    )
    op.create_index(
        "ix_project_activity_logs_created_at",
        "project_activity_logs",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_project_activity_logs_created_at", table_name="project_activity_logs")
    op.drop_index("ix_project_activity_logs_log_id", table_name="project_activity_logs")
    op.drop_index("ix_project_activity_logs_project_id", table_name="project_activity_logs")
    op.drop_table("project_activity_logs")

    op.drop_index("ix_project_files_category", table_name="project_files")
    op.drop_index("ix_project_files_item_type", table_name="project_files")
    op.drop_index("ix_project_files_parent_id", table_name="project_files")
    op.drop_index("ix_project_files_project_id", table_name="project_files")
    op.drop_table("project_files")

    op.drop_index("ix_project_members_status", table_name="project_members")
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")
