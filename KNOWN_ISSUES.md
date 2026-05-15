# KNOWN_ISSUES

- `BUILD_PLAN.md` and parts of `CLAUDE.md` describe an older backend-first FastAPI/Celery architecture; the repo currently implements a Tauri desktop app plus `analysis-sidecar/`.
- `WORK_LOG.md` and `KNOWN_ISSUES.md` were missing before this session; they are now created so future work can track progress and regressions.
- The sidecar contract is the source of truth for pro analysis, stem separation, transform preview, and extended render.
