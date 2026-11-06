import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../packages/otel/package.json", import.meta.url));
const yaml = require("yaml");
const base = yaml.parse(readFileSync(new URL("./base.yaml", import.meta.url), "utf8"));

function leave(signalName, value) {
  const connector = base.connectors[`routing/${signalName}`];
  const row = connector.table.find((item) => item.statement.includes(`"${value}"`));
  const pipeline = row ? row.pipelines[0] : connector.default_pipelines[0];
  return base.service.pipelines[pipeline].exporters;
}

test("machine metrics are marked infra before they are routed", () => {
  const machines = base.service.pipelines["metrics/machines"];
  const application = base.service.pipelines.metrics;
  assert.ok(machines.processors.includes("resource/infra"));
  assert.equal(application.processors.includes("resource/infra"), false);
  assert.deepEqual(machines.receivers, ["hostmetrics", "postgresql", "prometheus/collector"]);
  assert.deepEqual(base.service.pipelines["metrics/infra"].exporters, leave("metrics", "infra"));
});

for (const signalName of ["logs", "traces", "metrics"]) {
  test(`${signalName} app and infra leave on different exporters`, () => {
    const app = leave(signalName, "app");
    const infra = leave(signalName, "infra");
    const dropped = leave(signalName, "missing");
    assert.notDeepStrictEqual(app, infra);
    assert.notDeepStrictEqual(app, dropped);
    assert.notDeepStrictEqual(infra, dropped);
    assert.ok(app.some((name) => name.includes("app")));
    assert.ok(infra.some((name) => name.includes("infra")));
  });
}
