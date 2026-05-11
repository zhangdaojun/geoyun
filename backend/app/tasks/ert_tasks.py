from typing import Any, Dict
from celery import shared_task
from ..services.pygimli_ert import run_pygimli_inversion
from ..services.simpeg_ert import run_simpeg_inversion

@shared_task(bind=True)
def run_ert_inversion_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Celery task to run ERT inversion using pyGIMLi asynchronously.
    """
    # Update progress to started
    self.update_state(state="PROGRESS", meta={
        "progress": {"current": 0, "total": 100, "percent": 0, "message": "准备开始反演"}
    })
    
    try:
        import os
        
        file_content = payload.get("file_content")
        output_dir = payload.get("output_dir")
        z_weight = payload.get("z_weight", 0.2)
        max_iter = payload.get("max_iter", 20)
        lambda_param = payload.get("lambda_param", 20)
        error = payload.get("error", 0.03)
        inversion_backend = str(payload.get("inversion_backend") or "pygimli").lower()
        
        os.makedirs(output_dir, exist_ok=True)
        data_file_path = os.path.join(output_dir, "input_data.dat")
        with open(data_file_path, "w", encoding="utf-8") as f:
            f.write(file_content)
        
        self.update_state(state="PROGRESS", meta={
            "progress": {"current": 10, "total": 100, "percent": 10, "message": "正在进行反演计算..."}
        })
        
        run_inversion = run_simpeg_inversion if inversion_backend == "simpeg" else run_pygimli_inversion
        result = run_inversion(
            data_file_path=data_file_path,
            output_dir=output_dir,
            z_weight=z_weight,
            max_iter=max_iter,
            lambda_param=lambda_param,
            error=error,
        )
        
        self.update_state(state="PROGRESS", meta={
            "progress": {"current": 100, "total": 100, "percent": 100, "message": "反演完成"}
        })
        
        return {"result": result}
    except Exception as e:
        self.update_state(state="FAILURE", meta={
            "error": str(e), 
            "progress": {"current": 0, "total": 100, "percent": 100, "message": "反演失败"}
        })
        raise e
