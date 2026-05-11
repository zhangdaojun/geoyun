from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path


def _load_dotenv_file() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
    ]
    env_path = next((path for path in candidates if path.exists()), None)
    if env_path is None:
        return

    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv_file()


class Settings:
    def __init__(self) -> None:
        data_dir = Path(tempfile.gettempdir()) / "geoyun-admin"
        data_dir.mkdir(parents=True, exist_ok=True)
        default_sqlite = data_dir / "dev-admin.sqlite3"

        self.app_name = os.getenv("ADMIN_APP_NAME", "GeoYun Admin API")
        self.api_prefix = os.getenv("ADMIN_API_PREFIX", "")
        self.database_url = os.getenv(
            "ADMIN_DATABASE_URL",
            f"sqlite:///{default_sqlite.as_posix()}",
        )
        self.test_database_url = os.getenv(
            "ADMIN_TEST_DATABASE_URL",
            "sqlite+pysqlite:///:memory:",
        )
        self.echo_sql = os.getenv("ADMIN_SQL_ECHO", "0") == "1"
        self.seed_admin_account = os.getenv("ADMIN_SEED_ACCOUNT", "admin")
        self.seed_admin_phone = os.getenv("ADMIN_SEED_PHONE", "13800000000")
        self.seed_admin_name = os.getenv("ADMIN_SEED_NAME", "超级管理员")
        self.seed_admin_company = os.getenv("ADMIN_SEED_COMPANY", "吉云科技")
        self.expose_sms_debug_code = os.getenv("ADMIN_EXPOSE_SMS_DEBUG_CODE", "1") == "1"
        self.redis_url = os.getenv("ADMIN_REDIS_URL", "redis://127.0.0.1:6379/0")
        self.celery_result_expires = int(os.getenv("ADMIN_CELERY_RESULT_EXPIRES", "86400"))
        self.celery_task_always_eager = os.getenv("ADMIN_CELERY_TASK_ALWAYS_EAGER", "0") == "1"

        self.emap1_engine = os.getenv("ADMIN_EMAP1_ENGINE", "auto").strip().lower() or "auto"
        self.aurora_command = os.getenv("ADMIN_AURORA_COMMAND", "").strip()
        self.aurora_args = os.getenv("ADMIN_AURORA_ARGS", "").strip()
        self.aurora_workdir = os.getenv("ADMIN_AURORA_WORKDIR", "").strip() or None
        self.aurora_timeout_sec = float(os.getenv("ADMIN_AURORA_TIMEOUT_SEC", "120"))
        self.aurora_fallback_to_legacy = (
            os.getenv("ADMIN_AURORA_FALLBACK_TO_LEGACY", "1") == "1"
        )

        aurora_runtime_dir = Path(tempfile.gettempdir()) / "geoyun-admin" / "aurora-runtime"
        aurora_runtime_dir.mkdir(parents=True, exist_ok=True)
        self.aurora_runtime_dir = Path(
            os.getenv("ADMIN_AURORA_RUNTIME_DIR", str(aurora_runtime_dir))
        )
        self.aurora_runtime_dir.mkdir(parents=True, exist_ok=True)

        # 阿里云 OSS 配置
        self.oss_access_key_id = os.getenv("OSS_ACCESS_KEY_ID", "")
        self.oss_access_key_secret = os.getenv("OSS_ACCESS_KEY_SECRET", "")
        self.oss_endpoint = os.getenv("OSS_ENDPOINT", "")
        self.oss_bucket_name = os.getenv("OSS_BUCKET_NAME", "")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
