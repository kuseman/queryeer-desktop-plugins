# Spec: Live time series and dashboards in core (`core.timeseries`)

Status: proposal, 2026-11-16. Not started. Summarised as F25 in [`API-GAPS.md`](../API-GAPS.md).

Written in this repository because the plugins here are its first users. Once core accepts it, it moves to the Queryeer Desktop repository and this file links there.

## 1. Why

A quick live view of a server's vital signs, next to Grafana, without leaving Queryeer. The view is open for minutes, while you watch a deploy, a load test or an incident. It is not a monitoring system.

First users:
- **MongoDB:** cluster overview. Operations per second, connections, cache, queues, replication lag, slow operations.
- **Elasticsearch** (later plugin): cluster health, indexing and search rates, latencies, JVM heap, thread pool rejections.
- Later, possibly: JDBC (SQL Server waits and sessions), or a chart of a query result's columns.

Why core and not each plugin:
- Two plugins drawing their own charts would duplicate a chart library, rate maths, the polling lifecycle and the theme work, and the charts would look and behave differently.
- `CORE_BOUNDARY.md` already treats charting as an output plugin that core provides.
- Core has no chart today. `core.graph` draws node-and-edge graphs (query plans), not values over time.

## 2. Goals and non-goals

Goals:
- A dashboard tab that a plugin opens with a definition: panels of line charts and number tiles.
- Data pulled at an interval while the tab is open, with history kept in memory for the tab's lifetime.
- Core handles rates: a plugin reports raw counters, as servers expose them, and core turns them into per-second rates and ratios.
- Works in both themes, at small sizes, and with dozens of series without slowing the app down.

Non-goals (v1):
- Storing history across restarts, or across closing the tab.
- Alerting or notifications.
- User-built dashboards (dragging panels, editing queries). The plugin defines the dashboard; the user picks a time window and can hide series.
- Charts in the query result area (an `output.chart`). The data contract below is meant to be reusable for that later.

## 3. Concepts

- **Metric:** one named quantity with a kind and a unit, e.g. `opcounters.query`, a counter, unit `ops`.
- **Sample:** what one poll returns: a timestamp and the current raw value of each metric, optionally per label.
- **Label:** splits one metric into several series, e.g. per replica set member (`host:port`) or per Elasticsearch node.
- **Series:** one metric for one label, as drawn: the values core derived from successive samples.
- **Panel:** a line chart of one or more metrics, or a stat tile showing the latest value of one metric.
- **Dashboard:** a titled grid of panels with a sampler and an interval.

### Metric kinds

| Kind | Plugin reports | Core draws | Example |
|---|---|---|---|
| `gauge` | the current value | the value | connections, cache bytes, queue length, replication lag |
| `counter` | a cumulative total | change per second between two samples | `opcounters.query`, network bytes in |
| `ratio` | two cumulative totals, `numerator` and `denominator` | Δnumerator / Δdenominator | average read latency = Δ`opLatencies.reads.latency` / Δ`opLatencies.reads.ops` |

Counter rules:
- The first sample of a series has no rate. The chart starts at the second.
- A counter that goes down means a restart or a reset. Core draws a gap, not a negative rate, and starts again from the new value.
- A ratio with Δdenominator = 0 has no point (a gap), not 0 or infinity.
- Rates use the timestamps the sampler returns, not the poll schedule, so a late poll doesn't create a spike.

## 4. Frontend API

```ts
// @queryeer/api
timeseries.openDashboard(definition: DashboardDefinition): Disposable

type DashboardDefinition = {
  id: string;                       // stable: opening the same id again focuses the existing tab
  title: string;                    // tab title, e.g. "shop-prod (Overview)"
  intervalMs: number;               // poll interval, at least 1000
  windowMs?: number;                // initial time window, default 15 minutes; the user can change it
  metrics: MetricDefinition[];
  panels: PanelDefinition[];        // in reading order; core lays them out in a responsive grid
  sample: (signal: AbortSignal) => Promise<Sample>;
};

type MetricDefinition = {
  id: string;                       // e.g. "opcounters.query"
  label: string;                    // shown in legends, e.g. "query"
  kind: "gauge" | "counter" | "ratio";
  unit: Unit;
};

type Unit = "count" | "ops" | "bytes" | "ms" | "us" | "s" | "percent";
// Rates are shown per second ("ops/s", "bytes/s" → "MB/s"); values are scaled for display (1.2k, 3.4 GB, 850 µs)

type PanelDefinition =
  | { kind: "line"; title: string; metrics: string[]; stacked?: boolean; min?: number; max?: number }
  | { kind: "stat"; title: string; metric: string; thresholds?: { warning?: number; critical?: number; higherIsWorse?: boolean } };

type Sample = {
  time: number;                     // epoch ms, ideally the server's own clock
  values: Record<string, MetricValue | Record<string, MetricValue>>;  // a value, or values by label
  // A sample can carry a table too, shown in a "table" panel, e.g. the slowest current operations
  tables?: Record<string, { columns: string[]; rows: unknown[][] }>;
};

type MetricValue = number | { numerator: number; denominator: number } | null;  // null: not available now
```

A third panel kind shows the latest table of a sample, replaced on each poll:

```ts
  | { kind: "table"; title: string; table: string; maxRows?: number }
```

How a plugin uses it:
- The `sample` function calls the plugin's own backend: `queryEngines.invoke({ engineId, action: "serverStatusSample", payload })`. That already exists, so v1 needs no backend or protocol change.
- The plugin decides what a sample contains. Core never knows it is MongoDB.

Also exported, for plugins that want a chart inside their own UI: `components.TimeSeriesChart` with the same panel props and a `series` input, without the polling.

## 5. Lifecycle (core's job)

- **Start** when the tab opens. **Stop** when it closes: `Disposable` from `openDashboard` closes it too.
- **One poll at a time:** a poll that is still running when the next one is due is not doubled. The next one is skipped, and the chart shows a gap only if no sample arrived for 2.5 intervals.
- **Hidden tab:** keep polling by default, so the history has no hole when you come back. A dashboard setting can pause when hidden.
- **Errors:** a failed sample shows the error on the dashboard (a strip at the top, with the last success time) and backs off: 2×, 4×… the interval, at most 1 minute, back to normal on the next success. Polling never stops by itself.
- **Pause / resume** button: stops polling, keeps the history. **Clear** button: drops the history.
- **Abort:** the `signal` aborts when the tab closes or the user pauses, and after 3 intervals without an answer.
- **Memory:** history is kept for the longest selectable window (1 hour) and dropped after that. At a 1 second interval and 50 series that is 180,000 points, a few MB.
- **Connection changes:** not core's concern. A plugin that rebinds opens a new dashboard (another `id`).

## 6. Rendering

- **Library:** [uPlot](https://github.com/leeoniya/uPlot), about 50 KB, made for time series. It draws on canvas and handles many points and frequent updates cheaply. SVG chart libraries (Recharts and similar) get slow at this rate. To decide in core.
- **Time windows:** 5 min, 15 min, 1 h. Live mode follows the newest sample. Zooming with a drag stops following until "Live" is clicked.
- **Tooltips:** one tooltip for the time under the cursor, listing every series in the panel with its formatted value.
- **Legend:** click to hide or show a series, double-click to show only that one.
- **Stat tiles:** the latest value, large, with a sparkline of the window. Thresholds colour the tile with core's warning and error colours.
- **Theme:** series colours from a theme palette (`--chart-series-1`…`-8`, new theme variables), axes and grid from existing variables. Redraw on theme change.
- **Layout:** a responsive grid. Stat tiles in a row at the top, then charts two per row, one per row when narrow.
- **Copy:** a panel's menu can copy its visible data as CSV, for pasting into a ticket.

## 7. Later: push instead of pull

Pull through `invoke` covers server metrics that are read on demand (`serverStatus`, `_nodes/stats`). Change streams, or a backend that samples faster than the frontend should poll, would need push:
- a backend `TimeSeriesPublisher` that sends samples on a subscription the frontend opens and closes
- `DashboardDefinition.source: { engineId, subscription, payload }` as an alternative to `sample`

Not needed for v1. The `Sample` shape stays the same, so panels don't change.

## 8. First user: the MongoDB overview

Opened from the explorer: "Overview" on a connection. One `serverStatus` per poll, plus `replSetGetStatus` on a replica set, and `currentOp` for the table. All three are read-only. They need the `clusterMonitor` role. Without it, the dashboard shows the server's error.

| Panel | Metrics (`serverStatus` unless noted) | Kind |
|---|---|---|
| Operations/s (stacked line) | `opcounters.insert`, `query`, `update`, `delete`, `getmore`, `command` | counter |
| Average latency (line) | `opLatencies.reads`, `writes`, `commands`: `latency` / `ops` (µs) | ratio |
| Connections (stat + line) | `connections.current`; `available` | gauge |
| Network (line) | `network.bytesIn`, `network.bytesOut` | counter |
| WiredTiger cache (line) | `bytes currently in the cache`, `tracked dirty bytes in the cache`; `maximum bytes configured` as the line's max | gauge |
| Queues (line) | `globalLock.currentQueue.readers`, `writers` | gauge |
| Documents scanned vs returned (line) | `metrics.queryExecutor.scannedObjects`, `metrics.document.returned` | counter |
| Replication lag by member (line) | `replSetGetStatus`: primary `optimeDate` minus each secondary's, labelled by `host:port` | gauge |
| Slowest current operations (table) | `currentOp` with `active: true`, sorted by `secs_running`, top 10: op, ns, seconds, plan summary, client | table |

`serverStatus` is per server. v1 samples the server the connection reaches; a replica set's other members would need one client per member, labelled by host (later).

## 9. Open questions

1. A dashboard tab as a new editor type, or a `layout.registerEditor` the plugin owns with `components.Dashboard` inside? A core editor type gets restore-on-restart and tab handling for free. Suggested: a core editor type, restored closed (empty history) with a "Start" button.
2. Should dashboards be savable as files (e.g. `.qdash`), so users can keep their own? Not in v1, but it decides whether `DashboardDefinition` must be JSON-serialisable (then `sample` becomes `{ engineId, action, payload }` instead of a function).
3. One chart library for this and a future `output.chart`, or let the result-chart pick its own? Suggested: one.
4. Should the interval be user-adjustable per dashboard (1 s / 5 s / 15 s)? Suggested: yes, with the plugin's value as default.
