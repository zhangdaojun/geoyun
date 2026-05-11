from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.res2dinv_to_simpeg import parse_res2dinv_dat  # noqa: E402


def get_solver(solver_name: str):
    requested = solver_name.lower()
    if requested == "mumps":
        from pymatsolver import Mumps

        return Mumps, "MUMPS"
    if requested == "pardiso":
        from pymatsolver import Pardiso

        return Pardiso, "Pardiso"
    if requested == "lu":
        from pymatsolver import SolverLU

        return SolverLU, "SolverLU"

    try:
        from pymatsolver import Mumps

        return Mumps, "MUMPS"
    except ImportError:
        try:
            from pymatsolver import Pardiso

            return Pardiso, "Pardiso"
        except ImportError:
            from pymatsolver import SolverLU

            return SolverLU, "SolverLU"


def build_2d_survey_from_datums(datums, *, data_type: str):
    from simpeg.electromagnetics.static import resistivity as dc

    source_list = []
    dobs = []
    std = []
    for datum in datums:
        rx = dc.receivers.Dipole(
            locations_m=np.r_[[datum.mx, datum.mz]],
            locations_n=np.r_[[datum.nx, datum.nz]],
            data_type=data_type,
        )
        src = dc.sources.Dipole(
            receiver_list=[rx],
            location_a=np.r_[datum.ax, datum.az],
            location_b=np.r_[datum.bx, datum.bz],
        )
        source_list.append(src)
        if data_type == "apparent_resistivity":
            dobs.append(datum.apparent_resistivity)
            std.append(max(abs(datum.apparent_resistivity) * 0.05, 1.0))
        else:
            dobs.append(datum.resistance)
            std.append(max(datum.standard_deviation, abs(datum.resistance) * 0.05 + 1e-4))

    survey = dc.Survey(source_list, survey_geometry="surface")
    if data_type == "apparent_resistivity":
        survey.set_geometric_factor(space_type="halfspace")
    return survey, np.asarray(dobs), np.asarray(std)


def select_datums(observations, max_data: int, max_spacing: float):
    filtered = [
        item
        for item in observations
        if item.a is not None and item.a <= max_spacing and item.resistance > 0
    ]
    if len(filtered) <= max_data:
        return filtered
    take = np.linspace(0, len(filtered) - 1, max_data).round().astype(int)
    return [filtered[index] for index in take]


def run_inversion(
    input_dat: Path,
    output_dir: Path,
    max_data: int,
    max_spacing: float,
    max_iter: int,
    data_type: str,
    solver_name: str,
):
    import discretize
    from simpeg import data, data_misfit, directives, inverse_problem, inversion, maps, optimization
    from simpeg.electromagnetics.static.resistivity import simulation_2d
    from simpeg.regularization import WeightedLeastSquares

    parsed = parse_res2dinv_dat(input_dat)
    datums = select_datums(parsed.observations, max_data=max_data, max_spacing=max_spacing)
    if not datums:
        raise ValueError("No positive apparent-resistivity observations matched the filters")

    survey, dobs, standard_deviation = build_2d_survey_from_datums(datums, data_type=data_type)
    x_values = np.asarray(
        [
            value
            for datum in datums
            for value in (datum.ax, datum.bx, datum.mx, datum.nx)
            if value is not None
        ]
    )
    min_x = float(x_values.min())
    max_x = float(x_values.max())
    dx = min(float(parsed.unit_spacing), 10.0)
    depth = max(180.0, (max_x - min_x) * 0.22)
    padding = 12
    n_core_x = int(np.ceil((max_x - min_x) / dx)) + 1
    n_core_z = int(np.ceil(depth / dx))
    hx = [(dx, padding, -1.35), (dx, n_core_x), (dx, padding, 1.35)]
    hz = [(dx, padding, -1.35), (dx, n_core_z)]
    x_origin = min_x - sum(discretize.utils.unpack_widths(hx[:1]))
    z_origin = -sum(discretize.utils.unpack_widths(hz))
    mesh = discretize.TensorMesh([hx, hz], origin=[x_origin, z_origin])

    from discretize.utils import active_from_xyz

    active_cells = np.ones(mesh.nC, dtype=bool)
    n_active = int(active_cells.sum())
    
    model_map = maps.InjectActiveCells(mesh, active_cells, np.log(1e-8)) * maps.ExpMap(nP=n_active)
    solver, resolved_solver_name = get_solver(solver_name)
    simulation = simulation_2d.Simulation2DNodal(
        mesh,
        survey=survey,
        sigmaMap=model_map,
        solver=solver,
        storeJ=True,
    )
    dc_data = data.Data(survey=survey, dobs=dobs, standard_deviation=standard_deviation)
    misfit = data_misfit.L2DataMisfit(data=dc_data, simulation=simulation)
    regularization = WeightedLeastSquares(mesh, active_cells=active_cells, alpha_s=1e-4, alpha_x=1.0, alpha_y=1.0)
    opt = optimization.InexactGaussNewton(maxIter=max_iter, maxIterLS=10, maxIterCG=20)
    inv_problem = inverse_problem.BaseInvProblem(misfit, regularization, opt)
    directives_list = [
        directives.BetaEstimate_ByEig(beta0_ratio=1e1),
        directives.BetaSchedule(coolingFactor=2, coolingRate=1),
        directives.TargetMisfit(chifact=1.0),
    ]
    inv = inversion.BaseInversion(inv_problem, directiveList=directives_list)

    background_rho = float(np.median([item.apparent_resistivity for item in datums]))
    starting_model = np.log(np.ones(n_active) / background_rho)
    recovered_log_sigma = inv.run(starting_model)
    full_log_sigma = model_map * recovered_log_sigma
    recovered_resistivity = 1.0 / np.exp(full_log_sigma)
    recovered_resistivity[~active_cells] = np.nan
    predicted = simulation.dpred(recovered_log_sigma)
    normalized_residual = (dobs - predicted) / standard_deviation

    output_dir.mkdir(parents=True, exist_ok=True)
    np.savez(
        output_dir / "simpeg_ert_inversion_test.npz",
        mesh_hx=np.asarray(mesh.h[0], dtype=float),
        mesh_hz=np.asarray(mesh.h[1], dtype=float),
        mesh_origin=np.asarray(mesh.origin, dtype=float),
        recovered_log_sigma=recovered_log_sigma,
        recovered_resistivity=recovered_resistivity,
        dobs=dobs,
        dpred=predicted,
        standard_deviation=standard_deviation,
    )
    summary = {
        "input_dat": str(input_dat),
        "array_name": parsed.array_name,
        "unit_spacing_m": parsed.unit_spacing,
        "source_data_count": parsed.data_count,
        "used_data_count": int(survey.nD),
        "data_type": data_type,
        "source_count": int(survey.nSrc),
        "unique_electrode_count": int(survey.unique_electrode_locations.shape[0]),
        "mesh_cells": int(mesh.nC),
        "mesh_shape": list(mesh.shape_cells),
        "mesh_origin": [float(value) for value in mesh.origin],
        "solver": resolved_solver_name,
        "background_resistivity_ohm_m": background_rho,
        "phi_d": float(misfit(recovered_log_sigma)),
        "target_phi_d": float(survey.nD),
        "normalized_residual_rms": float(np.sqrt(np.mean(normalized_residual**2))),
        "resistivity_min_ohm_m": float(np.nanmin(recovered_resistivity)),
        "resistivity_median_ohm_m": float(np.nanmedian(recovered_resistivity)),
        "resistivity_max_ohm_m": float(np.nanmax(recovered_resistivity)),
        "output_npz": str(output_dir / "simpeg_ert_inversion_test.npz"),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a small SimPEG 2D ERT inversion smoke test.")
    parser.add_argument("input_dat", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--max-data", type=int, default=160)
    parser.add_argument("--max-spacing", type=float, default=120.0)
    parser.add_argument("--max-iter", type=int, default=4)
    parser.add_argument("--solver", choices=("auto", "mumps", "pardiso", "lu"), default="auto")
    parser.add_argument(
        "--data-type",
        choices=("apparent_resistivity", "volt"),
        default="apparent_resistivity",
    )
    args = parser.parse_args()
    summary = run_inversion(
        args.input_dat,
        args.output_dir,
        max_data=args.max_data,
        max_spacing=args.max_spacing,
        max_iter=args.max_iter,
        data_type=args.data_type,
        solver_name=args.solver,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
