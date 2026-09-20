# infrastructure/

Deployment and operational assets. Per decisions
[AD-14](../docs/plans/000-decisions.md) and the discovery doc §19, the
foundation phase deliberately ships **no infrastructure**: deployment is
`node apps/nexus/dist/server-entry.js` on any Linux box, with SQLite +
local artifact storage (later phases).

Planned contents (only when the corresponding phase arrives):

| Asset                        | Phase | Purpose                                               |
| ---------------------------- | ----- | ----------------------------------------------------- |
| `systemd/`                   | 3     | Service units for app + worker on a persistent VM     |
| `Dockerfile` (optional)      | 3     | Container packaging as an option, never a requirement |
| `litestream/`                | 3     | Continuous SQLite backup to S3-compatible storage     |
| `actions/` (render dispatch) | 4+    | Workflow templates for chunked cloud rendering        |

Do not add Kubernetes manifests, IaC, or PaaS configuration — they are
explicitly rejected by the architecture (discovery §22).
