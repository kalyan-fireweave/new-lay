---
paths:
  - "collector/**"
  - "packages/otel/**"
  - "packages/catalog/**"
  - "scripts/render-collector.ts"
  - "scripts/prove.ts"
  - "scripts/doctor"
---

# Telemetry

The API may emit a metric name only when `packages/catalog/metrics.yaml` lists it and `EMITTED` in `packages/otel/src/index.ts` includes it. Business counters fire on success: `keel.card.created` on 201, `keel.card.moved` when the column changes, `keel.comment.created` on 201, `keel.card.starred` on the first star, `keel.card.duplicated` on 201. A refused duplicate counts `keel.card.duplicate.rejected`. A duplicate that throws counts `keel.card.duplicate.failed`.

App telemetry sets `keel.signal=app` and keeps `keel.run_id`. The infra processor sets `keel.signal=infra` and drops `keel.run_id`. Routing sends `keel.signal == "app"` to the application pipeline. Unmatched items go to the dropped pipeline.

`node scripts/render-collector.ts` writes `generated/collector.yaml`. That file references `${env:KEEL_VENDOR_*}` and never contains the key. With vendor `openobserve`, a filled application account and an empty infrastructure account reuse `otlphttp/app` for both pipelines. Two filled accounts use `otlphttp/app` and `otlphttp/infra`, even when the keys match. Debug exporters have no `sending_queue`.

`pnpm prove` exits 0 for a real export when the application account has the run's log and span, the infrastructure account does not have that run id, and `http.server.request.duration` is queryable. A debug vendor prints `not exported` and exits 0. A shared org searches infrastructure rows with `keel_signal = 'infra'`.
