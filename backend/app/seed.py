from __future__ import annotations

from sqlalchemy.orm import Session

from .config import get_settings
from .models import Project, SurveyLine, SurveyPoint, User
from .security import get_password_hash

DEFAULT_ADMIN_USERS = [
    {
        "account": "admin",
        "name": "超级管理员",
        "company": "吉云科技",
        "phone": "13800000000",
        "email": "admin@geoyun.local",
        "backend_role": "super_admin",
    },
    {
        "account": "ops_admin",
        "name": "运营管理员",
        "company": "吉云科技",
        "phone": "13800000001",
        "email": "ops_admin@geoyun.local",
        "backend_role": "admin",
    },
    {
        "account": "support",
        "name": "客服",
        "company": "吉云科技",
        "phone": "13800000002",
        "email": "support@geoyun.local",
        "backend_role": "support",
    },
]

DEFAULT_PROJECT_FIXTURES = [
    {
        "external_id": "PJ-2023-002",
        "name": "黄河大坝二维隐患探测",
        "location": "河南省郑州市",
        "method": "大地电磁",
        "status": "active",
        "manager": "李四",
        "center_latitude": 34.7400,
        "center_longitude": 113.6200,
        "survey_lines": [
            {
                "line_code": "0",
                "instrument": "EH4",
                "display_name": "测线 0 · EH4",
                "sort_order": 0,
                "survey_points": [
                    {
                        "point_code": "51750",
                        "instrument": "EH4",
                        "longitude": 80.708141,
                        "latitude": 30.913889,
                        "elevation": 4520.0,
                        "point_status": "matched",
                        "matched_data_count": 1,
                        "has_existing_data": True,
                        "sort_order": 0,
                    },
                    {
                        "point_code": "52050",
                        "instrument": "EH4",
                        "longitude": 80.709512,
                        "latitude": 30.911734,
                        "elevation": 4498.0,
                        "point_status": "pending",
                        "matched_data_count": 0,
                        "has_existing_data": False,
                        "sort_order": 1,
                    },
                    {
                        "point_code": "52350",
                        "instrument": "EH4",
                        "longitude": 80.710864,
                        "latitude": 30.909541,
                        "elevation": 4472.0,
                        "point_status": "matched",
                        "matched_data_count": 1,
                        "has_existing_data": True,
                        "sort_order": 2,
                    },
                ],
            },
            {
                "line_code": "0",
                "instrument": "F3",
                "display_name": "测线 0 · F3",
                "sort_order": 1,
                "survey_points": [
                    {
                        "point_code": "51750",
                        "instrument": "F3",
                        "longitude": 80.708141,
                        "latitude": 30.913889,
                        "elevation": 4520.0,
                        "point_status": "matched",
                        "matched_data_count": 3,
                        "has_existing_data": True,
                        "sort_order": 0,
                    },
                    {
                        "point_code": "52050",
                        "instrument": "F3",
                        "longitude": 80.709512,
                        "latitude": 30.911734,
                        "elevation": 4498.0,
                        "point_status": "pending",
                        "matched_data_count": 0,
                        "has_existing_data": False,
                        "sort_order": 1,
                    },
                ],
            },
        ],
    },
    {
        "external_id": "PJ-2023-003",
        "name": "西南铁路沿线滑坡监测",
        "location": "四川省成都市",
        "method": "综合物探",
        "status": "planning",
        "manager": "王五",
        "center_latitude": 30.5700,
        "center_longitude": 104.0600,
        "survey_lines": [
            {
                "line_code": "L-1",
                "instrument": "EMAP-1",
                "display_name": "测线 L-1 · EMAP-1",
                "sort_order": 0,
                "survey_points": [
                    {
                        "point_code": "0-10",
                        "instrument": "EMAP-1",
                        "longitude": 104.060100,
                        "latitude": 30.570120,
                        "elevation": 508.0,
                        "point_status": "matched",
                        "matched_data_count": 1,
                        "has_existing_data": True,
                        "sort_order": 0,
                    },
                    {
                        "point_code": "10-20",
                        "instrument": "EMAP-1",
                        "longitude": 104.060420,
                        "latitude": 30.570440,
                        "elevation": 505.0,
                        "point_status": "pending",
                        "matched_data_count": 0,
                        "has_existing_data": False,
                        "sort_order": 1,
                    },
                ],
            }
        ],
    },
]


def seed_default_users(db: Session) -> None:
    settings = get_settings()
    existing_users = {
        str(user.account or "").strip().lower(): user
        for user in db.query(User).all()
    }
    seeded = []
    for template in DEFAULT_ADMIN_USERS:
        item = dict(template)
        if item["account"] == "admin":
            item["account"] = settings.seed_admin_account
            item["name"] = settings.seed_admin_name
            item["company"] = settings.seed_admin_company
            item["phone"] = settings.seed_admin_phone
        normalized_account = str(item["account"] or "").strip().lower()
        existing_user = existing_users.get(normalized_account)
        if existing_user:
            existing_user.name = item["name"]
            existing_user.company = item["company"]
            existing_user.phone = item["phone"]
            existing_user.email = item["email"]
            existing_user.backend_role = item["backend_role"]
            if not existing_user.password_hash:
                existing_user.password_hash = get_password_hash("123456")
            if existing_user.status != "disabled":
                existing_user.status = "active"
            continue
        item["password_hash"] = get_password_hash("123456")
        seeded.append(User(**item, status="active", token_version=0))

    if seeded:
        db.add_all(seeded)
    db.commit()


def seed_default_projects(db: Session) -> None:
    if db.query(Project).count() > 0:
        return

    projects = []
    for project_item in DEFAULT_PROJECT_FIXTURES:
        project = Project(
            external_id=project_item["external_id"],
            name=project_item["name"],
            location=project_item.get("location"),
            method=project_item.get("method"),
            status=project_item.get("status", "planning"),
            manager=project_item.get("manager"),
            center_latitude=project_item.get("center_latitude"),
            center_longitude=project_item.get("center_longitude"),
        )
        for line_item in project_item.get("survey_lines", []):
            line = SurveyLine(
                line_code=line_item["line_code"],
                instrument=line_item.get("instrument", "EH4"),
                display_name=line_item.get("display_name"),
                sort_order=line_item.get("sort_order", 0),
            )
            for point_item in line_item.get("survey_points", []):
                line.survey_points.append(
                    SurveyPoint(
                        point_code=point_item["point_code"],
                        instrument=point_item.get("instrument", line.instrument),
                        longitude=point_item.get("longitude"),
                        latitude=point_item.get("latitude"),
                        elevation=point_item.get("elevation"),
                        point_status=point_item.get("point_status", "pending"),
                        matched_data_count=point_item.get("matched_data_count", 0),
                        has_existing_data=point_item.get("has_existing_data", False),
                        sort_order=point_item.get("sort_order", 0),
                    )
                )
            project.survey_lines.append(line)
        projects.append(project)

    db.add_all(projects)
    db.commit()
