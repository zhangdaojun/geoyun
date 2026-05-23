from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import MagicMock
import pytest

import backend.app.tasks.ert_tasks


def test_ert_invert_pipeline(client, admin_headers, monkeypatch, tmp_path):
    # Mock subprocess.Popen in ert_tasks to bypass real pyGIMLi/SimPEG call
    class MockStdout:
        def __init__(self):
            self.lines = [
                "Preparing inversion\n",
                "Iteration 1: chi2=1.5\n",
                "Iteration 2: chi2=1.1\n",
                "Iteration 3: chi2=0.9\n",
                "Iteration 4: chi2=0.8\n",
                "Writing results\n"
            ]
            self.index = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.index < len(self.lines):
                val = self.lines[self.index]
                self.index += 1
                return val
            raise StopIteration

    mock_process = MagicMock()
    mock_process.stdout = MockStdout()
    mock_process.poll.return_value = 0
    mock_process.wait.return_value = 0

    # Write a dummy result file when subprocess is executed
    def mock_popen(*args, **kwargs):
        cmd_args = args[0]
        result_path_str = cmd_args[-1]
        
        # Create a dummy result json representing pyGIMLi success output
        Path(result_path_str).write_text(json.dumps({
            "status": "success",
            "chi2": 0.8,
            "rrms": 5.0,
            "output_dir": str(tmp_path),
            "files": [str(tmp_path / "result.dat")]
        }), encoding="utf-8")
        
        # Create the fake output files that archiving expects
        (tmp_path / "result.dat").write_text("dummy pyGIMLi results data", encoding="utf-8")
        
        return mock_process

    monkeypatch.setattr(backend.app.tasks.ert_tasks.subprocess, "Popen", mock_popen)

    # Post an invert request to trigger task creation
    data_file = ("input.dat", io.BytesIO(b"dummy data"), "application/octet-stream")
    response = client.post(
        "/admin/ert/invert",
        headers=admin_headers,
        data={
            "inversion_backend": "pygimli",
            "max_iter": 4,
            "output_dir": str(tmp_path),
        },
        files={
            "data_file": data_file
        }
    )
    assert response.status_code == 200
    res = response.json()
    task_id = res["task_id"]
    assert task_id
    assert res["status"] == "queued"

    # Query task status and verify progress & log updates
    status_response = client.get(f"/admin/ert/tasks/{task_id}", headers=admin_headers)
    assert status_response.status_code == 200
    status_res = status_response.json()
    assert status_res["status"] == "success"
    assert status_res["progress"]["percent"] == 100
    assert any("Iteration 4" in line for line in status_res["progress"]["logs"])

    # Query task result
    result_response = client.get(f"/admin/ert/tasks/{task_id}/result", headers=admin_headers)
    assert result_response.status_code == 200
    result_res = result_response.json()
    assert result_res["chi2"] == 0.8

    # Archive the task results
    archive_payload = {
        "project_id": "test_proj_123",
        "source_file_name": "input.dat"
    }
    archive_response = client.post(
        f"/admin/ert/tasks/{task_id}/archive",
        headers=admin_headers,
        json=archive_payload
    )
    assert archive_response.status_code == 200
    archive_res = archive_response.json()
    assert archive_res["status"] == "success"
    assert archive_res["project_id"] == "test_proj_123"
    assert len(archive_res["files"]) > 0
    assert archive_res["files"][0]["name"] == "result.dat"


def test_load_live_pygimli_iteration_results(tmp_path):
    from backend.app.routers.admin_ert import _load_live_pygimli_iteration_results

    iterations_dir = tmp_path / "ERTManager" / "iterations"
    iterations_dir.mkdir(parents=True, exist_ok=True)

    # 1. Create a dummy VTK file
    vtk_content = """# vtk DataFile Version 3.0
Mock VTK
ASCII
DATASET UNSTRUCTURED_GRID
POINTS 3 float
0.0 0.0 0.0
10.0 0.0 0.0
5.0 -5.0 0.0
CELLS 1 4
3 0 1 2
CELL_TYPES 1
5
CELL_DATA 1
SCALARS Resistivity float
LOOKUP_TABLE default
100.0
"""
    vtk_path = iterations_dir / "iteration_001.vtk"
    vtk_path.write_text(vtk_content, encoding="utf-8")

    # 2. Create a dummy surfer grid file
    grid_content = """DSAA
2 2
0.0 10.0
-5.0 0.0
10.0 100.0
10.0 50.0 100.0 80.0
"""
    grid_path = iterations_dir / "iteration_001_surfer.grd"
    grid_path.write_text(grid_content, encoding="utf-8")

    # 3. Create a dummy surfer boundary file
    boundary_content = """4,0,"ERT inversion boundary"
0.0,0.0
10.0,0.0
5.0,-5.0
0.0,0.0
"""
    boundary_path = iterations_dir / "iteration_001_boundary.bln"
    boundary_path.write_text(boundary_content, encoding="utf-8")

    # Create dummy vector file
    vector_path = iterations_dir / "iteration_001.vector"
    vector_path.write_text("100.0\n", encoding="utf-8")

    task = {
        "output_dir": str(tmp_path),
        "inversion_backend": "pygimli",
    }

    results = _load_live_pygimli_iteration_results(task)
    assert len(results) == 1
    res = results[0]
    assert res["iteration"] == 1
    assert res["vtk"] == str(vtk_path)
    assert res["vector"] == str(vector_path)
    assert res["vtk_mesh"] is not None
    assert len(res["preview_points"]) == 1  # 1 cell center
    assert len(res["surfer_preview_points"]) == 4  # 2x2 grid
    assert len(res["surfer_boundary_points"]) == 4  # 4 boundary points


def test_parse_npz_data_file(client, admin_headers):
    import io
    import numpy as np
    
    a_locs = np.array([[0.0, 0.0, 10.0], [1.0, 0.0, 10.0]], dtype=float)
    b_locs = np.array([[3.0, 0.0, 10.0], [4.0, 0.0, 10.0]], dtype=float)
    m_locs = np.array([[1.0, 0.0, 10.0], [2.0, 0.0, 10.0]], dtype=float)
    n_locs = np.array([[2.0, 0.0, 10.0], [3.0, 0.0, 10.0]], dtype=float)
    
    apparent_res = np.array([100.0, 120.0], dtype=float)
    std_dev = np.array([0.03, 0.03], dtype=float)
    
    npz_io = io.BytesIO()
    np.savez(
        npz_io,
        a_locations=a_locs,
        b_locations=b_locs,
        m_locations=m_locs,
        n_locations=n_locs,
        apparent_resistivity=apparent_res,
        standard_deviation=std_dev
    )
    npz_io.seek(0)
    
    response = client.post(
        "/admin/ert/parse-data-file",
        headers=admin_headers,
        files={"data_file": ("test_input.npz", npz_io, "application/octet-stream")}
    )
    assert response.status_code == 200
    res = response.json()
    assert "points" in res
    assert "spacing" in res
    assert "electrode_count" in res
    assert "profile_length" in res
    assert res["electrode_count"] == 5
    assert len(res["points"]) == 2


def test_ert_invert_with_npz_input(client, admin_headers, monkeypatch, tmp_path):
    import io
    import numpy as np
    
    class MockStdout:
        def __iter__(self):
            return self
        def __next__(self):
            raise StopIteration
            
    mock_process = MagicMock()
    mock_process.stdout = MockStdout()
    mock_process.poll.return_value = 0
    mock_process.wait.return_value = 0
    
    monkeypatch.setattr(backend.app.tasks.ert_tasks.subprocess, "Popen", lambda *args, **kwargs: mock_process)
    
    a_locs = np.array([[0.0, 0.0, 10.0]], dtype=float)
    b_locs = np.array([[3.0, 0.0, 10.0]], dtype=float)
    m_locs = np.array([[1.0, 0.0, 10.0]], dtype=float)
    n_locs = np.array([[2.0, 0.0, 10.0]], dtype=float)
    apparent_res = np.array([100.0], dtype=float)
    
    npz_io = io.BytesIO()
    np.savez(
        npz_io,
        a_locations=a_locs,
        b_locations=b_locs,
        m_locations=m_locs,
        n_locations=n_locs,
        apparent_resistivity=apparent_res
    )
    npz_io.seek(0)
    
    response = client.post(
        "/admin/ert/invert",
        headers=admin_headers,
        data={
            "inversion_backend": "pygimli",
            "max_iter": 4,
            "output_dir": str(tmp_path),
        },
        files={
            "data_file": ("test_input.npz", npz_io, "application/octet-stream")
        }
    )
    assert response.status_code == 200
    res = response.json()
    assert res["task_id"]
    assert res["status"] == "queued"
    
    dat_file = tmp_path / "input_data.dat"
    assert dat_file.exists()
    dat_content = dat_file.read_text(encoding="utf-8")
    assert "NPZ Imported Data" in dat_content
    assert "11" in dat_content


