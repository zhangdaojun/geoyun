"""create admin user management tables

Revision ID: 20260421_0001
Revises:
Create Date: 2026-04-21 00:00:01
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("account", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("company", sa.String(length=128), nullable=False),
        sa.Column("phone", sa.String(length=20), nullable=False),
        sa.Column("email", sa.String(length=128), nullable=True),
        sa.Column("backend_role", sa.String(length=32), nullable=False, server_default="user"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.Column("disabled_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_users_account", "users", ["account"], unique=True)
    op.create_index("ix_users_phone", "users", ["phone"], unique=True)
    op.create_index("ix_users_status", "users", ["status"], unique=False)

    op.create_table(
        "user_login_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("login_type", sa.String(length=32), nullable=False),
        sa.Column("login_status", sa.String(length=32), nullable=False, server_default="success"),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_user_login_logs_user_id", "user_login_logs", ["user_id"], unique=False)
    op.create_index(
        "ix_user_login_logs_created_at",
        "user_login_logs",
        ["created_at"],
        unique=False,
    )

    op.create_table(
        "admin_operation_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "admin_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_admin_operation_logs_admin_user_id",
        "admin_operation_logs",
        ["admin_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_admin_operation_logs_target_user_id",
        "admin_operation_logs",
        ["target_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_admin_operation_logs_action",
        "admin_operation_logs",
        ["action"],
        unique=False,
    )
    op.create_index(
        "ix_admin_operation_logs_created_at",
        "admin_operation_logs",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_admin_operation_logs_created_at", table_name="admin_operation_logs")
    op.drop_index("ix_admin_operation_logs_action", table_name="admin_operation_logs")
    op.drop_index("ix_admin_operation_logs_target_user_id", table_name="admin_operation_logs")
    op.drop_index("ix_admin_operation_logs_admin_user_id", table_name="admin_operation_logs")
    op.drop_table("admin_operation_logs")

    op.drop_index("ix_user_login_logs_created_at", table_name="user_login_logs")
    op.drop_index("ix_user_login_logs_user_id", table_name="user_login_logs")
    op.drop_table("user_login_logs")

    op.drop_index("ix_users_status", table_name="users")
    op.drop_index("ix_users_phone", table_name="users")
    op.drop_index("ix_users_account", table_name="users")
    op.drop_table("users")
