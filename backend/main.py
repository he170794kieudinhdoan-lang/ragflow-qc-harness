from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import settings, workspace, parsing, chunking, retrieval, analytics

app = FastAPI(title="RAGFlow QC Harness API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "ragflow-qc-harness"}


app.include_router(settings.router)
app.include_router(workspace.router)
app.include_router(parsing.router)
app.include_router(chunking.router)
app.include_router(retrieval.router)
app.include_router(analytics.router)
