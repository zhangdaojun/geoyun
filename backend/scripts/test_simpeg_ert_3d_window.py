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


def select_datums(observations, *, x_min: float, x_max: float, max_data: int):
    filtered = [
        item
        for item in observations
        if item.resistance > 0
        and item.apparent_resistivity > 0
        and item.a is not None
        and item.ax is not None
        and item.bx is not None
        and item.nx is not None
        and x_min <= min(item.ax, item.bx, item.mx, item.nx) <= x_max
        and x_min <= max(item.ax, item.bx, item.mx, item.nx) <= x_max
    ]
    if len(filtered) <= max_data:
        return filtered
    indices = np.linspace(0, len(filtered) - 1, max_data).round().astype(int)
    return [filtered[index] for index in indices]


def build_3d_survey(datums):
    from simpeg.electromagnetics.static import resistivity as dc

    source_list = []
    dobs = []
    std = []
    for datum in datums:
        receiver = dc.receivers.Dipole(
            locations_m=np.r_[datum.mx, datum.my, datum.mz][None, :],
            locations_n=np.r_[datum.nx, datum.ny, datum.nz][None, :],
            data_type="apparent_resistivity",
        )
        source = dc.sources.Dipole(
            receiver_list=[receiver],
            location_a=np.r_[datum.ax, datum.ay, datum.az],
            location_b=np.r_[datum.bx, datum.by, datum.bz],
        )
        source_list.append(source)
        dobs.append(datum.apparent_resistivity)
        std.append(max(abs(datum.apparent_resistivity) * 0.05, 1.0))

    survey = dc.Survey(source_list, survey_geometry="surface")
    survey.set_geometric_factor(space_type="halfspace")
    return survey, np.asarray(dobs, dtype=float), np.asarray(std, dtype=float)


def build_mesh(datums, *, cell_size: float, y_half_width: float, depth: float):
    import discretize

    x_values = np.asarray(
        [
            value
            for datum in datums
            for value in (datum.ax, datum.bx, datum.mx, datum.nx)
            if value is not None
        ],
        dtype=float,
    )
    min_x = float(x_values.min())
    max_x = float(x_values.max())
    n_core_x = int(np.ceil((max_x - min_x) / cell_size)) + 1
    n_core_y = max(2, int(np.ceil((2.0 * y_half_width) / cell_size)))
    n_core_z = max(4, int(np.ceil(depth / cell_size)))

    hx = [(cell_size, 8, -1.3), (cell_size, n_core_x), (cell_size, 8, 1.3)]
    hy = [(cell_size, 6, -1.3), (cell_size, n_core_y), (cell_size, 6, 1.3)]
    hz = [(cell_size, 8, -1.3), (cell_size, n_core_z)]

    hy_widths = discretize.utils.unpack_widths(hy)
    hz_widths = discretize.utils.unpack_widths(hz)
    origin = [
        min_x - sum(discretize.utils.unpack_widths(hx[:1])),
        -float(np.sum(hy_widths)) / 2.0,
        -float(np.sum(hz_widths)),
    ]
    return discretize.TensorMesh([hx, hy, hz], origin=origin)


def run_inversion(
    input_dat: Path,
    output_dir: Path,
    *,
    x_min: float,
    x_max: float,
    max_data: int,
    max_iter: int,
    cell_size: float,
    y_half_width: float,
    depth: float,
    solver_name: str,
):
    from simpeg import data, data_misfit, directives, inverse_problem, inversion, maps, optimization
    from simpeg.electromagnetics.static import resistivity as dc
    from simpeg.regularization import WeightedLeastSquares

    parsed = parse_res2dinv_dat(input_dat)
    datums = select_datums(parsed.observations, x_min=x_min, x_max=x_max, max_data=max_data)
    if not datums:
        raise ValueError("No positive observations matched the requested 3D window")

    survey, dobs, standard_deviation = build_3d_survey(datums)
    mesh = build_mesh(datums, cell_size=cell_size, y_half_width=y_half_width, depth=depth)
    solver, resolved_solver_name = get_solver(solver_name)

    model_map = maps.ExpMap(mesh)
    simulation = dc.Simulation3DNodal(
        mesh,
        survey=survey,
        sigmaMap=model_map,
        solver=solver,
        storeJ=True,
    )
    dc_data = data.Data(survey=survey, dobs=dobs, standard_deviation=standard_deviation)
    misfit = data_misfit.L2DataMisfit(data=dc_data, simulation=simulation)
    regularization = WeightedLeastSquares(mesh, alpha_s=1e-4, alpha_x=1.0, alpha_y=1.0, alpha_z=1.0)
    opt = optimization.InexactGaussNewton(maxIter=max_iter, maxIterLS=10, maxIterCG=20)
    inv_problem = inverse_problem.BaseInvProblem(misfit, regularization, opt)
    inv = inversion.BaseInversion(
        inv_problem,
        directiveList=[
            directives.BetaEstimate_ByEig(beta0_ratio=1e1),
            directives.BetaSchedule(coolingFactor=2, coolingRate=1),
            directives.TargetMisfit(chifact=1.0),
        ],
    )

    background_rho = float(np.median([item.apparent_resistivity for item in datums]))
    starting_model = np.log(np.ones(mesh.nC) / background_rho)
    recovered_log_sigma = inv.run(starting_model)
    recovered_resistivity = 1.0 / np.exp(recovered_log_sigma)
    predicted = simulation.dpred(recovered_log_sigma)
    normalized_residual = (dobs - predicted) / standard_deviation

    output_dir.mkdir(parents=True, exist_ok=True)
    npz_path = output_dir / "simpeg_ert_3d_window_inversion.npz"
    np.savez(
        npz_path,
        mesh_hx=np.asarray(mesh.h[0], dtype=float),
        mesh_hy=np.asarray(mesh.h[1], dtype=float),
        mesh_hz=np.asarray(mesh.h[2], dtype=float),
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
        "output_npz": str(npz_path),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a small SimPEG 3D ERT inversion window test.")
    parser.add_argument("input_dat", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--x-min", type=float, default=0.0)
    parser.add_argument("--x-max", type=float, default=420.0)
    parser.add_argument("--max-data", type=int, default=40)
    parser.add_argument("--max-iter", type=int, default=4)
    parser.add_argument("--cell-size", type=float, default=10.0)
    parser.add_argument("--y-half-width", type=float, default=20.0)
    parser.add_argument("--depth", type=float, default=140.0)
    parser.add_argument("--solver", choices=("auto", "mumps", "pardiso", "lu"), default="auto")
    args = parser.parse_args()
    summary = run_inversion(
        args.input_dat,
        args.output_dir,
        x_min=args.x_min,
        x_max=args.x_max,
        max_data=args.max_data,
        max_iter=args.max_iter,
        cell_size=args.cell_size,
        y_half_width=args.y_half_width,
        depth=args.depth,
        solver_name=args.solver,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
