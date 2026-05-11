from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from .. import schemas
from ..config import get_settings

EMAP1Processor = Callable[[schemas.EMAP1ProcessRequest], schemas.EMAP1ProcessResponse]


def process_with_aurora_adapter(
    payload: schemas.EMAP1ProcessRequest,
    *,
    package_processor: EMAP1Processor,
    fallback: EMAP1Processor,
) -> schemas.EMAP1ProcessResponse:
    settings = get_settings()
    engine = (settings.emap1_engine or "auto").strip().lower()
    should_try_aurora = engine in {"auto", "aurora"}

    if should_try_aurora:
        package_error = None
        external_error = None

        if settings.aurora_command:
            try:
                return _run_external_aurora(payload)
            except Exception as exc:
                external_error = exc

        try:
            return package_processor(payload)
        except Exception as exc:
            package_error = exc

        if engine == "aurora" and not settings.aurora_fallback_to_legacy:
            raise RuntimeError(
                "Aurora processing failed via installed package"
                + (f": {package_error}" if package_error else "")
                + (
                    f"; external command also failed: {external_error}"
                    if external_error is not None
                    else ""
                )
            )
        if engine == "aurora" or settings.aurora_fallback_to_legacy:
            fallback_result = fallback(payload)
            fallback_result.summary.engine = "legacy-birrp"
            return fallback_result

    fallback_result = fallback(payload)
    fallback_result.summary.engine = "legacy-birrp"
    return fallback_result


def _run_external_aurora(
    payload: schemas.EMAP1ProcessRequest,
) -> schemas.EMAP1ProcessResponse:
    settings = get_settings()
    command = _resolve_aurora_command(settings.aurora_command)
    if command is None:
        raise FileNotFoundError("Aurora command is not configured or not found")

    args = [command]
    if settings.aurora_args:
        args.extend(shlex.split(settings.aurora_args, posix=os.name != "nt"))

    runtime_root = settings.aurora_runtime_dir
    runtime_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="emap1-", dir=str(runtime_root)) as tmp_dir:
        tmp_path = Path(tmp_dir)
        input_path = tmp_path / "aurora-input.json"
        output_path = tmp_path / "aurora-output.json"
        input_payload = payload.model_dump(mode="json", exclude_none=True)
        input_path.write_text(
            json.dumps(input_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        env = os.environ.copy()
        env["GEOYUN_AURORA_INPUT"] = str(input_path)
        env["GEOYUN_AURORA_OUTPUT"] = str(output_path)
        env["GEOYUN_AURORA_MODE"] = payload.mode

        completed = subprocess.run(
            [*args, str(input_path), str(output_path)],
            cwd=settings.aurora_workdir or None,
            env=env,
            capture_output=True,
            text=True,
            timeout=settings.aurora_timeout_sec,
            check=False,
        )
        if completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(stderr or f"Aurora process exited with code {completed.returncode}")
        if not output_path.exists():
            raise FileNotFoundError(f"Aurora output was not created: {output_path}")

        output_payload = json.loads(output_path.read_text(encoding="utf-8"))
        summary = output_payload.setdefault("summary", {})
        summary.setdefault("engine", "aurora-external")
        response = schemas.EMAP1ProcessResponse.model_validate(output_payload)
        response.summary.engine = summary["engine"]
        return response


def _resolve_aurora_command(raw_command: str) -> str | None:
    command = (raw_command or "").strip()
    if not command:
        return None
    path = Path(command)
    if path.exists():
        return str(path)
    return shutil.which(command)
