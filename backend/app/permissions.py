BACKEND_ROLE_VALUES = {"super_admin", "admin", "support", "user"}
BACKEND_ADMIN_ACCESS_ROLES = {"super_admin", "admin", "support"}
PROJECT_ROLE_VALUES = {"owner", "manager", "operator", "reviewer", "viewer"}
PROJECT_WRITE_ROLES = {"owner", "manager", "operator"}

LEGACY_BACKEND_ROLE_MAP = {
    "admin": "super_admin",
    "manager": "admin",
    "operator": "admin",
    "reviewer": "support",
    "viewer": "user",
    "platform_admin": "admin",
    "security_auditor": "support",
}


def normalize_backend_role(role: str | None) -> str:
    raw = str(role or "").strip()
    if raw in BACKEND_ROLE_VALUES:
        return raw
    return LEGACY_BACKEND_ROLE_MAP.get(raw, "user")
