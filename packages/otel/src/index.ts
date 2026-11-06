import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  BasicTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { parse } from "yaml";

const EMITTED = [
  "http.server.requests",
  "http.server.request.duration",
  "keel.card.created",
  "keel.card.moved",
  "keel.comment.created",
  "keel.card.starred",
  "keel.card.duplicated",
  "keel.card.duplicate.rejected",
  "keel.card.duplicate.failed",
] as const;

export type BusinessMetric =
  | "keel.card.created"
  | "keel.card.moved"
  | "keel.comment.created"
  | "keel.card.starred"
  | "keel.card.duplicated"
  | "keel.card.duplicate.rejected"
  | "keel.card.duplicate.failed";

export type RequestSignal = {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  runId?: string;
  actor?: string;
  journey?: string;
  step?: string;
  pace?: string;
  business?: BusinessMetric;
};

export type Telemetry = {
  record(signal: RequestSignal): Promise<void>;
  record(name: BusinessMetric, status: number): Promise<void>;
  flush(): Promise<void>;
};

export type MemoryExporters = {
  telemetry: Telemetry;
  spans: InMemorySpanExporter;
  metrics: InMemoryMetricExporter;
  logs: InMemoryLogRecordExporter;
};

const SECRET = new Set(["cookie", "authorization"]);

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
  return dir;
}

function catalogNames(root: string): Set<string> {
  const file = path.join(root, "packages/catalog/metrics.yaml");
  const doc = parse(readFileSync(file, "utf8")) as { metrics?: { name?: string }[] };
  const names = new Set((doc.metrics ?? []).map((metric) => metric.name).filter((name): name is string => Boolean(name)));
  for (const name of EMITTED) {
    if (!names.has(name)) throw new Error(`metric ${name} is not in the catalog`);
  }
  return names;
}

function gitSha(root: string): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function isSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET.has(lower) || lower.includes("cookie") || lower.includes("authorization");
}

function scrub(attributes: object | undefined): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (isSecret(key)) delete (attributes as Record<string, unknown>)[key];
  }
}

function scrubbingSpanExporter(inner: SpanExporter): SpanExporter {
  return {
    export(spans, callback) {
      for (const span of spans) scrub((span as ReadableSpan).attributes);
      inner.export(spans, callback);
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

function scrubbingLogExporter(inner: LogRecordExporter): LogRecordExporter {
  return {
    export(logs, callback) {
      for (const record of logs) {
        scrub(record.attributes);
        if (record.body && typeof record.body === "object") scrub(record.body);
      }
      inner.export(logs, callback);
    },
    shutdown: () => inner.shutdown(),
  };
}

function signalAttributes(signal: RequestSignal): Attributes {
  const attributes: Attributes = {
    "http.route": signal.route,
    "http.request.method": signal.method,
    "http.response.status_code": signal.status,
  };
  if (signal.runId) attributes["keel.run_id"] = signal.runId;
  if (signal.actor) attributes["keel.actor"] = signal.actor;
  if (signal.journey) attributes["keel.journey"] = signal.journey;
  if (signal.step) attributes["keel.step"] = signal.step;
  if (signal.pace) attributes["keel.pace"] = signal.pace;
  return attributes;
}

function endpoint(): string {
  return (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://127.0.0.1:4418").replace(/\/$/, "");
}

export function startTelemetry(options?: {
  traces?: SpanExporter;
  metrics?: PushMetricExporter;
  logs?: LogRecordExporter;
}): Telemetry {
  const root = repoRoot();
  const catalog = catalogNames(root);
  const resource = resourceFromAttributes({
    "service.name": "keel-api",
    "service.version": gitSha(root),
    "deployment.environment": process.env.KEEL_ENV || "local",
    "keel.signal": "app",
  });
  const base = endpoint();
  const traces = scrubbingSpanExporter(options?.traces ?? new OTLPTraceExporter({ url: `${base}/v1/traces`, timeoutMillis: 1000 }));
  const metrics = options?.metrics ?? new OTLPMetricExporter({ url: `${base}/v1/metrics`, timeoutMillis: 1000 });
  const logs = scrubbingLogExporter(options?.logs ?? new OTLPLogExporter({ url: `${base}/v1/logs`, timeoutMillis: 1000 }));

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traces, { scheduledDelayMillis: 1000 })],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(logs, { scheduledDelayMillis: 1000 })],
  });
  const reader = new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 1000 });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  const tracer = tracerProvider.getTracer("keel-api");
  const logger = loggerProvider.getLogger("keel-api");
  const meter = meterProvider.getMeter("keel-api");

  function counter(name: (typeof EMITTED)[number]) {
    if (!catalog.has(name)) throw new Error(`metric ${name} is not in the catalog`);
    return meter.createCounter(name);
  }
  const requests = counter("http.server.requests");
  const duration = meter.createHistogram("http.server.request.duration", { unit: "ms" });
  if (!catalog.has("http.server.request.duration")) throw new Error("metric http.server.request.duration is not in the catalog");
  const created = counter("keel.card.created");
  const moved = counter("keel.card.moved");
  const commented = counter("keel.comment.created");
  const starred = counter("keel.card.starred");
  const duplicated = counter("keel.card.duplicated");
  const duplicateRejected = counter("keel.card.duplicate.rejected");
  const duplicateFailed = counter("keel.card.duplicate.failed");
  const business = {
    "keel.card.created": created,
    "keel.card.moved": moved,
    "keel.comment.created": commented,
    "keel.card.starred": starred,
    "keel.card.duplicated": duplicated,
    "keel.card.duplicate.rejected": duplicateRejected,
    "keel.card.duplicate.failed": duplicateFailed,
  };

  async function flush(): Promise<void> {
    const pending = Promise.all([
      tracerProvider.forceFlush(),
      loggerProvider.forceFlush(),
      meterProvider.forceFlush(),
    ]).then(() => undefined).catch(() => undefined);
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 300))]);
  }

  return {
    async record(signal, status?: number) {
      if (typeof signal === "string") {
        business[signal].add(1, {
          "http.route": "/cards/:id/duplicate",
          "http.request.method": "POST",
          "http.response.status_code": status ?? 0,
        });
        return;
      }
      const attributes = signalAttributes(signal);
      const started = Date.now() - signal.durationMs;
      const span = tracer.startSpan(signal.route, { startTime: started, attributes });
      if (signal.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      logger.emit({
        severityNumber: signal.status >= 500 ? SeverityNumber.ERROR : signal.status >= 400 ? SeverityNumber.WARN : SeverityNumber.INFO,
        body: `${signal.method} ${signal.route} ${signal.status}`,
        attributes,
      });
      requests.add(1, attributes);
      duration.record(signal.durationMs, attributes);
      if (signal.business === "keel.card.created" && signal.status === 201) business[signal.business].add(1, attributes);
      if (signal.business === "keel.card.moved" && signal.status === 200) business[signal.business].add(1, attributes);
      if (signal.business === "keel.comment.created" && signal.status === 201) business[signal.business].add(1, attributes);
      if (signal.business === "keel.card.starred" && signal.status === 201) business[signal.business].add(1, attributes);
      if (signal.business === "keel.card.duplicated" && signal.status === 201) business[signal.business].add(1, attributes);
      if (signal.business === "keel.card.duplicate.rejected" && signal.status >= 400 && signal.status < 500) business[signal.business].add(1, attributes);
      if (signal.business === "keel.card.duplicate.failed" && signal.status >= 500) business[signal.business].add(1, attributes);
      await flush();
    },
    flush,
  };
}

export function memoryTelemetry(): MemoryExporters {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logs = new InMemoryLogRecordExporter();
  return { telemetry: startTelemetry({ traces: spans, metrics, logs }), spans, metrics, logs };
}

export type { ReadableLogRecord, ReadableSpan };
