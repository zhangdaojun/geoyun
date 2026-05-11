"""create project invitation table

Revision ID: 20260421_0004
Revises: 20260421_0003
Create Date: 2026-04-21 16:10:00
"""

import sqlalchemy as sa
from alembic import op

revision = "20260421_0004"
down_revision = "20260421_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_invitations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("invitation_id", sa.String(length=128), nullable=False),
        sa.Column("contact_type", sa.String(length=32), nullable=False, server_default="email"),
        sa.Column("contact_value", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=128), nullable=True),
        sa.Column("project_role", sa.String(length=32), nullable=False, server_default="viewer"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("recipient_status", sa.String(length=32), nullable=True),
        sa.Column("invite_channel", sa.String(length=32), nullable=True),
        sa.Column("invite_code", sa.String(length=64), nullable=True),
        sa.Column("invite_link", sa.String(length=255), nullable=True),
        sa.Column("invited_at", sa.String(length=64), nullable=True),
        sa.Column("expires_at", sa.String(length=64), nullable=True),
        sa.Column("last_sent_at", sa.String(length=64), nullable=True),
        sa.Column("sent_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("invited_by", sa.String(length=64), nullable=True),
        sa.Column("invited_user_id", sa.String(length=64), nullable=True),
        sa.Column("revoked_at", sa.String(length=64), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("invite_logs_json", sa.JSON(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "project_id", "invitation_id", name="uq_project_invitations_project_invite"
        ),
    )
    op.create_index(
        "ix_project_invitations_project_id", "project_invitations", ["project_id"], unique=False
    )
    op.create_index(
        "ix_project_invitations_status", "project_invitations", ["status"], unique=False
    )
    op.create_index(
        "ix_project_invitations_contact_value",
        "project_invitations",
        ["contact_value"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_project_invitations_contact_value", table_name="project_invitations")
    op.drop_index("ix_project_invitations_status", table_name="project_invitations")
    op.drop_index("ix_project_invitations_project_id", table_name="project_invitations")
    op.drop_table("project_invitations")
