"""create files and file operation logs tables

Revision ID: 20260421_0005
Revises: 20260421_0004
Create Date: 2026-04-21 20:40:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0005"
down_revision = "20260421_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "files",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("external_file_id", sa.String(length=128), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_ext", sa.String(length=20), nullable=True),
        sa.Column("mime_type", sa.String(length=100), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("storage_provider", sa.String(length=20), nullable=False, server_default="local"),
        sa.Column(
            "bucket_name",
            sa.String(length=100),
            nullable=False,
            server_default="geoyun-local-drive",
        ),
        sa.Column("object_key", sa.String(length=500), nullable=False),
        sa.Column("file_url", sa.String(length=1000), nullable=True),
        sa.Column(
            "access_level",
            sa.String(length=20),
            nullable=False,
            server_default="project_shared",
        ),
        sa.Column("checksum_md5", sa.String(length=64), nullable=True),
        sa.Column("checksum_sha256", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column("owner_type", sa.String(length=50), nullable=False, server_default="project"),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "uploaded_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("upload_ip", sa.String(length=64), nullable=True),
        sa.Column("storage_class", sa.String(length=50), nullable=True),
        sa.Column("version_no", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("external_file_id", name="uq_files_external_file_id"),
    )
    op.create_index("ix_files_external_file_id", "files", ["external_file_id"], unique=True)
    op.create_index("ix_files_owner_id", "files", ["owner_id"], unique=False)
    op.create_index("ix_files_owner_type", "files", ["owner_type"], unique=False)
    op.create_index("ix_files_status", "files", ["status"], unique=False)
    op.create_index("ix_files_uploaded_by", "files", ["uploaded_by"], unique=False)

    op.create_table(
        "file_operation_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "file_id",
            sa.Integer(),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "operator_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("operation_type", sa.String(length=50), nullable=False),
        sa.Column("result", sa.String(length=20), nullable=False, server_default="success"),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("extra_data", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_file_operation_logs_file_id",
        "file_operation_logs",
        ["file_id"],
        unique=False,
    )
    op.create_index(
        "ix_file_operation_logs_operator_id",
        "file_operation_logs",
        ["operator_id"],
        unique=False,
    )
    op.create_index(
        "ix_file_operation_logs_operation_type",
        "file_operation_logs",
        ["operation_type"],
        unique=False,
    )
    op.create_index(
        "ix_file_operation_logs_result",
        "file_operation_logs",
        ["result"],
        unique=False,
    )
    op.create_index(
        "ix_file_operation_logs_created_at",
        "file_operation_logs",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_file_operation_logs_created_at", table_name="file_operation_logs")
    op.drop_index("ix_file_operation_logs_result", table_name="file_operation_logs")
    op.drop_index("ix_file_operation_logs_operation_type", table_name="file_operation_logs")
    op.drop_index("ix_file_operation_logs_operator_id", table_name="file_operation_logs")
    op.drop_index("ix_file_operation_logs_file_id", table_name="file_operation_logs")
    op.drop_table("file_operation_logs")

    op.drop_index("ix_files_uploaded_by", table_name="files")
    op.drop_index("ix_files_status", table_name="files")
    op.drop_index("ix_files_owner_type", table_name="files")
    op.drop_index("ix_files_owner_id", table_name="files")
    op.drop_index("ix_files_external_file_id", table_name="files")
    op.drop_table("files")
