from __future__ import annotations

import json
import os
import re
import sys
import time
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from celery import states

from ..celery_app import celery_app


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _summarize_ert_error(message: str) -> str:
    text = str(message or "").strip()
    if "There are data values equals 0.0" in text:
        return "数据中存在 0 值测点，pyGIMLi 无法反演；请剔除视电阻率/电阻为 0 的数据后重试。"
    if "rhoa" in text or "apparent resistivity" in text:
        return "数据文件缺少有效的正值视电阻率 rhoa；请确认 DAT 为 RES2DINV 格式且视电阻率列不为 0。"
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("RuntimeError:") or line.startswith("ValueError:"):
            return line.split(":", 1)[1].strip() or line
    return text[-1000:] or "二维反演失败"


def _terminate_subprocess_tree(process: subprocess.Popen) -> None:
    """Kill the inversion subprocess (and any descendants) with escalation: SIGTERM → SIGKILL."""
    if process.poll() is not None:
        return

    pid = process.pid
    kill_grace = 5
    terminate_grace = 10

    if os.name == "nt":
        # taskkill /F /T walks the job tree on Windows
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                check=False,
                capture_output=True,
                timeout=kill_grace,
            )
        except Exception:
            pass
        try:
            process.terminate()
        except Exception:
            pass
    else:
        try:
            process.terminate()
        except Exception:
            pass

    try:
        process.wait(timeout=terminate_grace)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        process.kill()
    except Exception:
        pass
    try:
        process.wait(timeout=kill_grace)
    except Exception:
        pass


@celery_app.task(bind=True, name="ert.invert")
def run_ert_inversion_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Celery task to run ERT inversion using pyGIMLi or SimPEG in a subprocess asynchronously.
    Streams stdout to parse progress/logs and updates the Celery task state.
    """
    started_at = _utc_now()
    created_at = payload.get("created_at") or started_at
    max_iter = max(int(payload.get("max_iter") or 1), 1)
    output_dir = payload.get("output_dir")
    inversion_backend = str(payload.get("inversion_backend") or "pygimli").lower()

    timeout_seconds = int(os.environ.get("ERT_INVERSION_TIMEOUT_SECONDS", 60 * 30))

    logs = ["任务已启动，正在准备反演数据..."]
    progress = {
        "current": 0,
        "total": max_iter,
        "percent": 10,
        "message": "正在准备反演数据",
        "logs": logs,
    }

    # Set initial PROGRESS state in Celery
    self.update_state(
        state="PROGRESS",
        meta={
            "status": "running",
            "created_at": created_at,
            "started_at": started_at,
            "max_iter": max_iter,
            "output_dir": output_dir,
            "inversion_backend": inversion_backend,
            "logs": logs,
            "progress": progress,
        }
    )

    last_update_time = time.time()

    def update_celery_state(force: bool = False) -> None:
        nonlocal last_update_time
        now_time = time.time()
        # Throttling: update state at most once every 0.5s unless forced
        if force or (now_time - last_update_time >= 0.5):
            self.update_state(
                state="PROGRESS",
                meta={
                    "status": "running",
                    "created_at": created_at,
                    "started_at": started_at,
                    "max_iter": max_iter,
                    "output_dir": output_dir,
                    "inversion_backend": inversion_backend,
                    "logs": list(logs),
                    "progress": progress,
                }
            )
            last_update_time = now_time

    def append_log(line: str) -> None:
        cleaned = re.sub(r"\x1b\[[0-9;]*m", "", str(line or "")).strip()
        if not cleaned:
            return
        logs.append(cleaned)
        del logs[:-80]

        iteration_match = re.search(r"(?:iter(?:ation)?|Iteration)\D*(\d+)", cleaned)
        if not iteration_match:
            iteration_match = re.match(r"\s*(\d+)\s*:", cleaned)
        if not iteration_match:
            iteration_match = re.match(r"\s*(\d+)\s+[-+0-9.eE]+", cleaned)

        force_update = False
        if iteration_match:
            current = min(max(int(iteration_match.group(1)), 1), max_iter)
            percent = min(95, max(30, int(30 + (current / max_iter) * 65)))
            
            # Force update if iteration number increases so user gets immediate visual progress
            if progress.get("current") != current:
                force_update = True

            progress.update({
                "current": current,
                "total": max_iter,
                "percent": percent,
                "message": f"正在进行第 {current}/{max_iter} 次迭代",
                "logs": list(logs),
            })
        else:
            count_match = re.match(r"\s*(\d+)\s*/\s*(\d+)\s*$", cleaned)
            if count_match:
                current = int(count_match.group(1))
                total = max(int(count_match.group(2)), 1)
                percent = min(60, max(15, int(15 + (current / total) * 40)))
                progress.update({
                    "current": current,
                    "total": total,
                    "percent": percent,
                    "message": f"正在计算 Jacobian {current}/{total}",
                    "logs": list(logs),
                })
            else:
                progress.update({
                    "logs": list(logs),
                    "message": cleaned[-120:],
                })
        
        update_celery_state(force=force_update)

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    payload_path = output_path / "local_ert_payload.json"
    result_path = output_path / "local_ert_result.json"
    payload_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    code = r"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from backend.app.services.pygimli_ert import run_pygimli_inversion
from backend.app.services.simpeg_ert import run_simpeg_inversion

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
result_path = Path(sys.argv[2])
output_dir = Path(str(payload["output_dir"]))
output_dir.mkdir(parents=True, exist_ok=True)
data_file_path = Path(str(payload["data_file_path"]))
if not data_file_path.is_file():
    raise FileNotFoundError(f"ERT input file missing: {data_file_path}")
terrain_file_path = None
terrain_value = payload.get("terrain_file_path")
if terrain_value:
    candidate = Path(str(terrain_value))
    if candidate.is_file():
        terrain_file_path = candidate

backend = str(payload.get("inversion_backend") or "pygimli").lower()
if backend == "simpeg":
    result = run_simpeg_inversion(
        data_file_path=str(data_file_path),
        output_dir=str(output_dir),
        z_weight=float(payload.get("z_weight", 0.2)),
        max_iter=int(payload.get("max_iter", 20)),
        lambda_param=int(payload.get("lambda_param", 20)),
        error=float(payload.get("error", 0.03)),
        terrain_file_path=str(terrain_file_path) if terrain_file_path else None,
    )
else:
    result = run_pygimli_inversion(
        data_file_path=str(data_file_path),
        output_dir=str(output_dir),
        z_weight=float(payload.get("z_weight", 0.2)),
        max_iter=int(payload.get("max_iter", 20)),
        lambda_param=int(payload.get("lambda_param", 20)),
        error=float(payload.get("error", 0.03)),
        terrain_file_path=str(terrain_file_path) if terrain_file_path else None,
    )
result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
"""

    process: Optional[subprocess.Popen] = None
    timed_out = {"flag": False}
    watchdog: Optional[threading.Timer] = None

    try:
        popen_kwargs: Dict[str, Any] = dict(
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "MPLBACKEND": "Agg",
                "QT_QPA_PLATFORM": "offscreen",
                "PYTHONIOENCODING": "utf-8",
            },
        )
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True

        root_dir = Path(__file__).resolve().parents[3]
        process = subprocess.Popen(
            [sys.executable, "-c", code, str(payload_path), str(result_path)],
            cwd=str(root_dir),
            **popen_kwargs,
        )
        assert process.stdout is not None

        def _on_timeout() -> None:
            if process and process.poll() is None:
                timed_out["flag"] = True
                append_log(
                    f"⚠️ 任务执行已超过 {timeout_seconds // 60} 分钟，正在终止子进程..."
                )
                _terminate_subprocess_tree(process)

        watchdog = threading.Timer(timeout_seconds, _on_timeout)
        watchdog.daemon = True
        watchdog.start()

        for output_line in process.stdout:
            append_log(output_line)
        return_code = process.wait()

        if timed_out["flag"]:
            raise RuntimeError(
                f"二维反演超时（超过 {timeout_seconds // 60} 分钟），已自动终止子进程。"
                "请减小数据规模或调低最大迭代次数后重试。"
            )
        if return_code != 0:
            error_details = "\n".join(logs)
            raise RuntimeError(_summarize_ert_error(error_details))

        result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {}
        finished_at = _utc_now()
        
        progress.update({
            "current": max_iter,
            "total": max_iter,
            "percent": 100,
            "message": "二维反演完成",
            "logs": list(logs),
        })

        return {
            "status": "success",
            "created_at": created_at,
            "started_at": started_at,
            "finished_at": finished_at,
            "max_iter": max_iter,
            "output_dir": output_dir,
            "inversion_backend": inversion_backend,
            "logs": list(logs),
            "progress": progress,
            "result": result,
        }

    except Exception as exc:
        finished_at = _utc_now()
        error_msg = _summarize_ert_error(str(exc))
        progress.update({
            "percent": 100,
            "message": "二维反演超时已终止" if timed_out["flag"] else "二维反演失败",
            "logs": list(logs),
        })
        meta = {
            "status": "failed",
            "created_at": created_at,
            "started_at": started_at,
            "finished_at": finished_at,
            "max_iter": max_iter,
            "output_dir": output_dir,
            "inversion_backend": inversion_backend,
            "logs": list(logs),
            "progress": progress,
            "error": error_msg,
        }
        self.update_state(state=states.FAILURE, meta=meta)
        raise exc
    finally:
        if watchdog is not None:
            watchdog.cancel()
        if process is not None and process.poll() is None:
            _terminate_subprocess_tree(process)
