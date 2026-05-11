from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import database
from .config import get_settings
from .routers.admin_emap1 import router as admin_emap1_router
from .routers.admin_ert import router as admin_ert_router
from .routers.admin_files import router as admin_files_router
from .routers.admin_folders import router as admin_folders_router
from .routers.admin_projects import router as admin_projects_router
from .routers.admin_users import router as admin_users_router
from .routers.admin_oss import router as admin_oss_router
from .routers.auth import router as auth_router
from .seed import seed_default_projects, seed_default_users

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.Base.metadata.create_all(bind=database.engine)
    database.ensure_runtime_schema()
    with database.db_session() as db:
        seed_default_users(db)
        seed_default_projects(db)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_users_router)
app.include_router(admin_projects_router)
app.include_router(admin_folders_router)
app.include_router(admin_files_router)
app.include_router(admin_oss_router)
app.include_router(admin_emap1_router)
app.include_router(admin_ert_router)
app.include_router(auth_router)


@app.get("/admin/health")
def health_check():
    return {"ok": True, "service": settings.app_name}
