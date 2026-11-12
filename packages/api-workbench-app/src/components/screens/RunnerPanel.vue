<script setup lang="ts">
import {
  describeTagFilter,
  effectiveTags,
  emptyTagFilter,
  matchesTags,
  tagCounts,
  tagFilterActive,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import TagFilterChips from '../ui/TagFilterChips.vue';
import { OPTION_ICONS, withIcons, withTones } from '../../select-options';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import { computed, ref, watchEffect } from 'vue';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { methodIcon, requestProtocol } from '../../stores/protocols';
import { useRunnerStore } from '../../stores/runner';
import { useUiStore } from '../../stores/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import RunnerActivity from './runner/RunnerActivity.vue';
import RunnerDistribution from './runner/RunnerDistribution.vue';
import { vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import VaultUnlockNotice from '../VaultUnlockNotice.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTabs from '../ui/UiTabs.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestsStore } from '../../stores/requests';
import { toast } from '../../utils';
import type { RunnerErrorGroup, RunnerSample } from '@techieutils/api-workbench-common/runner';
import { RUN_DATA_ACCEPT, runDataFormatName } from '@techieutils/api-workbench-common/run-data';

/**
 * Collection runs, benchmarks, and performance tests. The runner store repaints progress as a run
 * streams samples; the config is edited in place, so views of it follow render().
 */
const ui = useUiStore();
const workspace = useWorkspaceStore();
const store = useRunnerStore();
const runner = store.run;
// A deleted collection or a switched workspace resets the choices before they are shown.
watchEffect(() => {
  void workspace.state;
  store.initialize();
});
type Config = typeof runner.config & object;
const view = useRendered(() => {
  void workspace.state;
  const config = { ...runner.config! };
  const requests = workspace.state.requests.filter(
    (request) => requestProtocol(request) === 'http' && isWithin(request.folder, runner.folder),
  );
  return {
    config,
    locked: runner.running || ui.busy,
    running: runner.running,
    folder: runner.folder,
    environment: runner.environment,
    selected: runner.selected === null ? null : [...runner.selected],
    error: runner.error,
    requests,
    tags: { ...runner.tags, include: [...runner.tags.include], exclude: [...runner.tags.exclude] },
    // Each request's tags with its collection's and folders', as the run reads them.
    tagsOf: Object.fromEntries(
      requests.map((request) => [request.id, effectiveTags(workspace.state, request)]),
    ) as Record<string, string[]>,
    tagCounts: tagCounts(
      requests.map((request) => ({ tags: effectiveTags(workspace.state, request) })),
    ),
    /** Requests the tag filter leaves out, shown dimmed. */
    filteredOut: new Set(
      requests
        .filter((request) => !matchesTags(effectiveTags(workspace.state, request), runner.tags))
        .map((request) => request.id),
    ),
    chosen: store.selectedRequests().length,
    filter: runner.filter,
    data: config.mode === 'collection' ? runner.data : undefined,
    dataError: runner.dataError,
  };
});
/** A column as it is written in a request; built here, since braces end a template expression. */
const variable = (name: string) => `{{${name}}}`;
/** The first rows of the data file, for checking it is the right one. */
const DATA_PREVIEW_ROWS = 5;
const dataInput = ref<HTMLInputElement>();
function chooseData(): void {
  dataInput.value?.click();
}
/** The formats a data file can be, for the drop zone. */
const DATA_FORMATS: [string, string][] = [
  ['CSV', 'With a header row of column names; TSV too'],
  ['JSON', 'A list of objects'],
  ['YAML', 'A list of objects'],
  ['XML', 'Repeated elements, such as <row> inside <rows>'],
];
const dataDragging = ref(false);
function onDataLeave(event: DragEvent): void {
  // Leaving for a child of the zone is not leaving the zone.
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    dataDragging.value = false;
}
function onDataDrop(event: DragEvent): void {
  dataDragging.value = false;
  if (view.value.locked) return;
  const file = event.dataTransfer?.files[0];
  if (file) void store.loadData(file);
}
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${number(bytes / 1024)} KB`
      : `${number(bytes / 1048576)} MB`;
/** Each column of the data file, and how many of the selected requests use it as a variable. */
const columnUse = computed(() => {
  const data = view.value.data;
  if (!data) return [];
  void view.value.selected;
  const texts = store
    .selectedRequests()
    .map((request) => JSON.stringify({ ...request, response: undefined }));
  return data.columns.map((name) => {
    const pattern = new RegExp(
      `\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`,
    );
    return { name, requests: texts.filter((text) => pattern.test(text)).length };
  });
});
function onDataFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Cleared, so choosing the same file again (after editing it) reads it again.
  input.value = '';
  if (file) void store.loadData(file);
}
/** Each data row's outcome, shown after a data-driven run; long files show the first rows. */
const ITERATION_ROWS = 200;
const iterations = useRendered(() => {
  void runner.report;
  return store.iterationSummary();
});
/** The columns shown for each row in the iteration table: the first few, to keep it readable. */
const iterationColumns = computed(() => runner.reportData?.columns.slice(0, 3) ?? []);
const folders = computed(() => [
  ...new Set(workspace.state.requests.map((request) => collectionOf(request.folder))),
]);
const isSelected = (id: string) => view.value.selected === null || view.value.selected.includes(id);
const number = (value: number, digits = 1) => store.formatNumber(value, digits);

type NumericField = {
  key: keyof Config;
  label: string;
  min: number;
  max: number;
  step?: number;
};
const fields = computed((): NumericField[] => {
  const { mode, loadModel } = view.value.config;
  const rate = mode === 'performance' && loadModel === 'rate';
  return [
    mode === 'performance'
      ? { key: 'durationSeconds', label: 'Duration (seconds)', min: 1, max: 3600 }
      : mode === 'collection' && view.value.data
        ? { key: 'iterations', label: 'Iterations (one per data row)', min: 1, max: 10000 }
        : { key: 'iterations', label: 'Iterations per request', min: 1, max: 10000 },
    ...(rate
      ? ([
          { key: 'targetRps', label: 'Target rate (req/s)', min: 0.1, max: 10000, step: 0.1 },
        ] as NumericField[])
      : []),
    ...(mode !== 'collection'
      ? ([
          rate
            ? { key: 'concurrency', label: 'Maximum in flight', min: 1, max: 50 }
            : { key: 'concurrency', label: 'Concurrent workers', min: 1, max: 50 },
          { key: 'warmupIterations', label: 'Warm-up iterations (excluded)', min: 0, max: 100 },
        ] as NumericField[])
      : []),
    ...(mode === 'performance'
      ? ([
          {
            key: 'rampUpSeconds',
            label: rate ? 'Ramp-up to target rate (seconds)' : 'Ramp-up (seconds)',
            min: 0,
            max: 3600,
          },
          { key: 'maxRequests', label: 'Maximum measured requests', min: 1, max: 100000 },
        ] as NumericField[])
      : []),
    // A fixed rate sets the spacing between requests, so a per-worker delay does not apply.
    ...(rate
      ? []
      : ([
          { key: 'delayMs', label: 'Delay per worker (ms)', min: 0, max: 60000 },
        ] as NumericField[])),
  ];
});
const thresholdFields: NumericField[] = [
  { key: 'successMin', label: 'Successful status: minimum', min: 100, max: 599 },
  { key: 'successMax', label: 'Successful status: maximum', min: 100, max: 599 },
  { key: 'p95LimitMs', label: 'Maximum p95 (ms, 0 disables)', min: 0, max: 3600000 },
  { key: 'maxErrorRate', label: 'Maximum error rate (%)', min: 0, max: 100, step: 0.1 },
  { key: 'minRps', label: 'Minimum req/s (0 disables)', min: 0, max: 1000000, step: 0.1 },
];
function setField(key: keyof Config, event: Event): void {
  (runner.config as unknown as Record<string, unknown>)[key] = Number(
    (event.target as HTMLInputElement).value,
  );
}
// Run modes are tabs above the form; each sets that mode's defaults.
const MODES: { mode: Config['mode']; name: string }[] = [
  { mode: 'collection', name: 'Collection run' },
  { mode: 'benchmark', name: 'API benchmark' },
  { mode: 'performance', name: 'Performance test' },
];
const modeTabs = MODES.map(({ mode, name }) => ({ name, icon: OPTION_ICONS.runnerMode[mode] }));
const modeName = computed(
  () => MODES.find((item) => item.mode === view.value.config.mode)?.name ?? MODES[0].name,
);
function selectMode(name: string): void {
  const mode = MODES.find((item) => item.name === name)?.mode;
  if (!mode || mode === runner.config?.mode) return;
  setMode(mode);
}
function setMode(mode: Config['mode']): void {
  Object.assign(runner.config!, {
    mode,
    iterations: mode === 'collection' ? (runner.data?.rows.length ?? 1) : 20,
    concurrency: mode === 'performance' ? 5 : 1,
    warmupIterations: mode === 'benchmark' ? 2 : 0,
    maxErrorRate: mode === 'collection' ? 0 : 5,
  });
  render();
}
function setLoadModel(event: Event): void {
  runner.config!.loadModel = (event.target as HTMLSelectElement).value as Config['loadModel'];
  render();
}
function setFolder(event: Event): void {
  runner.folder = (event.target as HTMLSelectElement).value;
  runner.selected = null;
  runner.tags = emptyTagFilter();
  render();
}

// Choosing requests by tag
function setTags(filter: TagFilter): void {
  runner.tags = filter;
  render();
}
function toggleRequest(id: string, checked: boolean): void {
  const selected = new Set(
    runner.selected ||
      workspace.state.requests
        .filter((request) => isWithin(request.folder, runner.folder))
        .map((request) => request.id),
  );
  if (checked) selected.add(id);
  else selected.delete(id);
  runner.selected = [...selected];
  render();
}

/**
 * What the run will do, before it starts: the target, how many requests go out, the criteria it
 * passes by, and, while it runs, how far it has got.
 */
const plan = computed(() => {
  const { config, chosen, data, folder, environment } = view.value;
  const performance = config.mode === 'performance';
  const rate = performance && config.loadModel === 'rate';
  const planned = performance
    ? rate
      ? Math.min(config.maxRequests, Math.ceil(config.targetRps * config.durationSeconds))
      : config.maxRequests
    : chosen * config.iterations;
  const facts: { key: string; label: string; value: string }[] = [
    { key: 'collection', label: 'Collection', value: folder || '—' },
    {
      key: 'environment',
      label: 'Environment',
      value: workspace.state.environments[environment]?.name ?? '—',
    },
    { key: 'requests', label: 'Requests', value: `${chosen} of ${view.value.requests.length}` },
    ...(tagFilterActive(view.value.tags)
      ? [{ key: 'tags', label: 'Tags', value: describeTagFilter(view.value.tags) }]
      : []),
    performance
      ? { key: 'duration', label: 'Duration', value: `${config.durationSeconds} s` }
      : {
          key: 'iterations',
          label: data ? 'Data rows' : 'Iterations',
          value: String(config.iterations),
        },
    ...(config.mode !== 'collection'
      ? [
          {
            key: 'load',
            label: rate ? 'Target rate' : 'Workers',
            value: rate
              ? `${number(config.targetRps)} req/s, ${config.concurrency} in flight`
              : String(config.concurrency),
          },
        ]
      : []),
    ...(config.warmupIterations && config.mode !== 'collection'
      ? [
          {
            key: 'warmup',
            label: 'Warm-up',
            value: `${config.warmupIterations * chosen} requests, not measured`,
          },
        ]
      : []),
  ];
  const criteria = [
    `Status ${config.successMin}–${config.successMax}`,
    `Errors ≤ ${number(config.maxErrorRate)}%`,
    ...(config.p95LimitMs ? [`p95 ≤ ${number(config.p95LimitMs, 0)} ms`] : []),
    ...(config.minRps ? [`≥ ${number(config.minRps)} req/s`] : []),
  ];
  return {
    facts,
    criteria,
    planned,
    plannedLabel: performance
      ? `Up to ${planned.toLocaleString()} measured requests`
      : `${planned.toLocaleString()} request${planned === 1 ? '' : 's'}${chosen > 1 && config.iterations > 1 ? ` (${chosen} × ${config.iterations})` : ''}`,
  };
});
/** How far the run has got: by requests, or by time for a performance test. */
const progress = computed(() => {
  const current = results.value.progress;
  if (!results.value.running || !current) return undefined;
  if (current.phase === 'warmup')
    return {
      percent: current.warmupTotal ? (current.warmupCompleted / current.warmupTotal) * 100 : 0,
      label: `Warm-up ${current.warmupCompleted} of ${current.warmupTotal}`,
    };
  const performance = view.value.config.mode === 'performance';
  const percent = performance
    ? (current.elapsedMs / (view.value.config.durationSeconds * 1000)) * 100
    : plan.value.planned
      ? (current.completed / plan.value.planned) * 100
      : 0;
  return {
    percent: Math.min(100, Math.max(0, percent)),
    label: performance
      ? `${number(current.elapsedMs / 1000, 0)} of ${view.value.config.durationSeconds} s · ${current.completed} done`
      : `${current.completed} of ${plan.value.planned} requests`,
  };
});
/** The style of the progress bar's fill, set from script since markup cannot carry styles. */
const progressBar = ref<HTMLElement>();
watchEffect(() => {
  if (progressBar.value) progressBar.value.style.width = `${progress.value?.percent ?? 0}%`;
});

// Results
const results = useRendered(() => {
  void workspace.state;
  const report = runner.report;
  const progress = runner.progress;
  const samples = report?.samples || runner.samples;
  const elapsed = report?.elapsedMs || progress?.elapsedMs || 0;
  const metrics = report?.metrics || store.summarize(samples, elapsed);
  const resources = report?.resources || runner.resources;
  const statusCounts = new Map<string, number>();
  samples.forEach((sample) => {
    const key = sample.cancelled ? 'Cancelled' : String(sample.status || 'Transport error');
    statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
  });
  return {
    report,
    progress,
    running: runner.running,
    elapsed,
    metrics,
    resources,
    cpu: resources?.samples.at(-1)?.cpuPercent,
    endpoints: store.endpointMetrics(samples, elapsed),
    statusCounts: [...statusCounts],
    visible: samples
      .filter(
        (sample) =>
          runner.filter === 'all' ||
          (runner.filter === 'failed'
            ? !sample.success && !sample.cancelled
            : runner.filter === 'passed'
              ? sample.success
              : sample.cancelled),
      )
      .slice(-100)
      .reverse(),
    buckets: report?.timeline || store.timeline(samples, elapsed),
    bins: store.histogram(samples, 24),
    errors: report?.errors || store.errorSummary(samples),
    dropped: report?.dropped ?? progress?.dropped ?? 0,
    comparison:
      report && runner.baseline && runner.baseline.mode === report.mode
        ? store.compareToBaseline(runner.baseline, report.metrics)
        : undefined,
  };
});
/** A failure caused by a locked vault, which can be unlocked from the results. */
const lockedVaultError = computed(
  () => results.value.errors.find((group) => vaultIssue(group.message))?.message,
);
const rateModel = computed(
  () => results.value.report?.config.loadModel === 'rate' || view.value.config.loadModel === 'rate',
);
const title = computed(() => {
  const { running, report } = results.value;
  if (running) return 'Run in progress';
  return report?.outcome === 'passed'
    ? 'Run passed'
    : report?.outcome === 'cancelled'
      ? 'Run cancelled'
      : report?.outcome === 'empty'
        ? 'No measurements'
        : 'Run failed';
});
const summary = computed(() => {
  const { running, progress, report } = results.value;
  if (running)
    return progress?.phase === 'warmup'
      ? `Warm-up ${progress.warmupCompleted}/${progress.warmupTotal} · excluded from metrics`
      : `${progress?.scheduled || 0} dispatched · ${progress?.inFlight || 0} in flight`;
  return report?.reason === 'request-limit'
    ? 'Configured request limit reached'
    : report?.reason === 'failure'
      ? 'Stopped after a failed request'
      : 'Run finished';
});
/** The verdict's tone and icon, so the outcome reads at a glance (and never by colour alone). */
const verdict = computed(() => {
  const { running, report } = results.value;
  if (running) return { tone: 'running', icon: 'progress-clock' as MdiIconName };
  if (report?.outcome === 'passed')
    return { tone: 'passed', icon: 'check-circle-outline' as MdiIconName };
  if (report?.outcome === 'cancelled' || report?.outcome === 'empty')
    return { tone: 'neutral', icon: 'cancel' as MdiIconName };
  return { tone: 'failed', icon: 'close-circle-outline' as MdiIconName };
});
/** The criteria a finished run missed, in words, for the verdict. */
const missed = computed(() =>
  (results.value.report?.thresholds ?? [])
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${number(check.actual, 2)}, limit ${number(check.limit, 2)}`),
);
const failedThreshold = (name: RegExp) =>
  (results.value.report?.thresholds ?? []).some((check) => !check.passed && name.test(check.name));
/** The figures that decide a run, each with the detail that explains it. */
const cards = computed(() => {
  const { metrics } = results.value;
  const failures = metrics.transportErrors + metrics.httpErrors + metrics.assertionFailures;
  return [
    {
      key: 'completed',
      label: 'Completed',
      icon: 'check-all' as MdiIconName,
      value: metrics.completed.toLocaleString(),
      detail: `${metrics.cancelled ? `${metrics.cancelled} cancelled · ` : ''}${number(results.value.elapsed / 1000, 2)} s`,
      tone: '',
    },
    {
      key: 'throughput',
      label: 'Throughput',
      icon: 'speedometer' as MdiIconName,
      value: `${number(metrics.rps)} req/s`,
      detail: `${number(metrics.bytes / 1024)} KB received`,
      tone: failedThreshold(/req\/s|throughput/i) ? 'is-danger' : '',
    },
    {
      key: 'errors',
      label: 'Error rate',
      icon: 'alert-circle-outline' as MdiIconName,
      value: `${number(metrics.errorRate)}%`,
      detail: failures ? `${failures} failed` : 'No failures',
      tone: failedThreshold(/error/i) ? 'is-danger' : metrics.errorRate > 0 ? 'is-warning' : '',
    },
    {
      key: 'p95',
      label: 'p95 latency',
      icon: 'timer-outline' as MdiIconName,
      value: `${number(metrics.p95)} ms`,
      detail: `avg ${number(metrics.average)} · p99 ${number(metrics.p99)} ms`,
      tone: failedThreshold(/p95/i) ? 'is-danger' : '',
    },
    {
      key: 'assertions',
      label: 'Assertions',
      icon: 'format-list-checks' as MdiIconName,
      value: `${metrics.testsPassed}/${metrics.testsTotal}`,
      detail: metrics.testsTotal
        ? `${number((metrics.testsPassed / metrics.testsTotal) * 100)}% passed`
        : 'No assertions',
      tone: metrics.testsPassed < metrics.testsTotal ? 'is-danger' : '',
    },
  ];
});
/** Latency in detail, as rows of a table rather than a line of numbers. */
const latencyRows = computed(() => {
  const { metrics } = results.value;
  const ms = (value: number | undefined) => (value ? `${number(value)} ms` : '—');
  return [
    ['Minimum', ms(metrics.min)],
    ['Average (± 95% CI)', `${ms(metrics.average)} ± ${number(metrics.ci95, 2)}`],
    ['Median', ms(metrics.p50)],
    ['p90', ms(metrics.p90)],
    ['p95', ms(metrics.p95)],
    ['p99', ms(metrics.p99)],
    ['p99.9', ms(metrics.p999)],
    ['Maximum', ms(metrics.max)],
    ['Standard deviation', ms(metrics.stdDev)],
    [
      'Network avg / p50 / p95 / p99',
      metrics.networkAverage
        ? `${number(metrics.networkAverage)} / ${number(metrics.networkP50)} / ${number(metrics.networkP95)} / ${number(metrics.networkP99)} ms`
        : '—',
    ],
    ['Time to first byte p95', ms(metrics.ttfbP95)],
  ];
});
/** Where failures came from and what else happened, as label and value. */
const reliabilityRows = computed(() => {
  const { metrics, report, progress, dropped } = results.value;
  return [
    ['Transport failures', String(metrics.transportErrors)],
    ['HTTP failures', String(metrics.httpErrors)],
    ['Assertion failures', String(metrics.assertionFailures)],
    ['Cancelled', String(metrics.cancelled)],
    [
      'Warm-up requests',
      `${report?.warmupCompleted || progress?.warmupCompleted || 0}${report?.warmupFailures ? ` (${report.warmupFailures} failed)` : ''}`,
    ],
    ...(rateModel.value ? [['Dropped starts (in-flight limit)', String(dropped)]] : []),
  ];
});
/** Results in tabs, each with a count where it has rows. */
const RESULT_TABS = ['Overview', 'Requests', 'Samples', 'Data rows', 'Errors'] as const;
type ResultTab = (typeof RESULT_TABS)[number];
const resultTab = ref<ResultTab>('Overview');
const resultTabs = computed(() =>
  RESULT_TABS.filter((name) => name !== 'Data rows' || iterations.value.length).map((name) => ({
    name,
    icon: (
      {
        Overview: 'view-dashboard-outline',
        Requests: 'format-list-bulleted',
        Samples: 'table',
        'Data rows': 'file-table-outline',
        Errors: 'alert-circle-outline',
      } as Record<ResultTab, MdiIconName>
    )[name],
    count:
      name === 'Requests'
        ? results.value.endpoints.length
        : name === 'Samples'
          ? results.value.metrics.completed
          : name === 'Data rows'
            ? iterations.value.length
            : name === 'Errors'
              ? results.value.errors.reduce((total, group) => total + group.count, 0)
              : undefined,
  })),
);
const resource = (value: number | null | undefined, unit: string, divisor = 1) =>
  value == null ? '—' : `${number(value / divisor)}${unit}`;
const signed = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value))}%`;
function setFilter(event: Event): void {
  runner.filter = (event.target as HTMLSelectElement).value;
  render();
}
function showAllSamples(): void {
  runner.filter = 'all';
  render();
}

// The request list's context menu: include or exclude a request, include only it or everything
// in the collection, or open it.
const {
  menu: requestMenu,
  target: requestFor,
  open: openRequestMenu,
  onKeydown: onRequestKeydown,
} = useContextMenu<string>();
const requestMenuItems = computed<MenuItem[]>(() => {
  const id = requestFor.value ?? '';
  const locked = view.value.locked;
  return [
    {
      id: 'toggle',
      label: isSelected(id) ? 'Exclude from run' : 'Include in run',
      icon: isSelected(id) ? 'close' : 'check',
      disabled: locked,
    },
    { id: 'only', label: 'Include only this request', icon: 'filter-variant', disabled: locked },
    {
      id: 'all',
      label: 'Include all requests',
      icon: 'check-circle-outline',
      disabled: locked || view.value.selected === null,
    },
    { id: 'open', label: 'Open request', icon: 'file-document-outline', separated: true },
  ];
});
function onRequestMenu(command: string): void {
  const id = requestFor.value;
  if (!id) return;
  if (command === 'toggle') toggleRequest(id, !isSelected(id));
  else if (command === 'only') {
    runner.selected = [id];
    render();
  } else if (command === 'all') {
    runner.selected = null;
    render();
  } else if (command === 'open') requests.openRequest(id);
}

// Result rows' context menus: open the request, narrow the samples, rerun one request, or copy.
type Endpoint = (typeof results.value.endpoints)[number];
type ResultRow =
  | { kind: 'sample'; sample: RunnerSample }
  | { kind: 'endpoint'; endpoint: Endpoint }
  | { kind: 'error'; group: RunnerErrorGroup };
const requests = useRequestsStore();
const {
  menu: resultMenu,
  target: resultFor,
  open: openResultMenu,
  onKeydown: onResultKeydown,
} = useContextMenu<ResultRow>();
const sampleResult = (sample: RunnerSample) =>
  sample.cancelled ? 'cancelled' : sample.success ? 'passed' : 'failed';
const exists = (id: string) => workspace.state.requests.some((request) => request.id === id);
const resultMenuItems = computed<MenuItem[]>(() => {
  const row = resultFor.value;
  if (!row) return [];
  if (row.kind === 'error')
    return [
      { id: 'copy-message', label: 'Copy message', icon: 'content-copy' },
      {
        id: 'filter-failed',
        label: 'Show only failed samples',
        icon: 'filter-variant',
        disabled: runner.filter === 'failed',
      },
    ];
  if (row.kind === 'endpoint')
    return [
      {
        id: 'open',
        label: 'Open request',
        icon: 'file-document-outline',
        disabled: !exists(row.endpoint.id),
      },
      {
        id: 'only',
        label: 'Run only this request next',
        icon: 'play-outline',
        disabled: !exists(row.endpoint.id) || runner.running,
      },
      { id: 'copy', label: 'Copy statistics', icon: 'content-copy', separated: true },
    ];
  const result = sampleResult(row.sample);
  return [
    {
      id: 'open',
      label: 'Open request',
      icon: 'file-document-outline',
      disabled: !exists(row.sample.requestId),
    },
    {
      id: 'filter',
      label: `Show only ${result} samples`,
      icon: 'filter-variant',
      disabled: runner.filter === result,
    },
    { id: 'copy', label: 'Copy row', icon: 'content-copy', separated: true },
    {
      id: 'copy-error',
      label: 'Copy error',
      icon: 'alert-circle-outline',
      disabled: !row.sample.error,
    },
  ];
});
async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
function onResultMenu(command: string): void {
  const row = resultFor.value;
  if (!row) return;
  if (row.kind === 'error') {
    if (command === 'copy-message') void copyText(row.group.message, 'Message copied');
    else if (command === 'filter-failed') {
      runner.filter = 'failed';
      render();
    }
    return;
  }
  const id = row.kind === 'sample' ? row.sample.requestId : row.endpoint.id;
  if (command === 'open') requests.openRequest(id);
  else if (command === 'only') {
    runner.selected = [id];
    render();
    toast(`The next run sends only ${row.kind === 'endpoint' ? row.endpoint.name : ''}`, 'success');
  } else if (command === 'filter' && row.kind === 'sample') {
    runner.filter = sampleResult(row.sample);
    render();
  } else if (command === 'copy-error' && row.kind === 'sample' && row.sample.error)
    void copyText(row.sample.error, 'Error copied');
  else if (command === 'copy' && row.kind === 'sample') {
    const sample = row.sample;
    void copyText(
      [
        sample.sequence,
        sample.iteration,
        sample.method,
        sample.name,
        sample.status ?? '',
        number(sample.durationMs),
        sample.networkMs === undefined ? '' : number(sample.networkMs),
        `${sample.testsPassed}/${sample.testsTotal}`,
        sampleResult(sample),
      ].join('\t'),
      'Row copied',
    );
  } else if (command === 'copy' && row.kind === 'endpoint') {
    const { metrics } = row.endpoint;
    void copyText(
      [
        [
          'Request',
          'Completed',
          'Errors %',
          'Avg ms',
          'Median ms',
          'p95 ms',
          'p99 ms',
          'Max ms',
          'Req/s',
        ],
        [
          `${row.endpoint.method} ${row.endpoint.name}`,
          metrics.completed,
          number(metrics.errorRate),
          number(metrics.average),
          number(metrics.p50),
          number(metrics.p95),
          number(metrics.p99),
          number(metrics.max),
          number(metrics.rps),
        ],
      ]
        .map((cells) => cells.join('\t'))
        .join('\n'),
      'Statistics copied',
    );
  }
}
</script>

<template>
  <section class="panel runner-page">
    <PageHeader
      eyebrow="WORKSPACE / AUTOMATION"
      guide="runner"
      title="API runner"
      description="Run collections, benchmark APIs, and measure performance from this desktop client."
    />
    <!-- Setup on the left; what the run will do, and Run, in a panel that stays in view. -->
    <form id="runner-form" class="overview-card runner-setup" @submit.prevent="store.start()">
      <UiTabs
        group="runner-mode"
        label="Run mode"
        :items="modeTabs"
        :active="modeName"
        attribute="data-runner-mode"
        panel="runner-form"
        class="runner-mode-tabs"
        :disabled="view.locked"
        @select="selectMode"
      />
      <div class="runner-setup-layout">
        <div class="runner-setup-main">
          <h3 class="runner-setup-heading"><MdiIcon name="tune-variant" />Target and load</h3>
          <div class="runner-config-grid">
            <label v-if="view.config.mode === 'performance'" class="form-field"
              ><span>Load model</span
              ><UiSelect
                id="runner-load-model"
                class="field-input"
                :value="view.config.loadModel"
                :disabled="view.locked"
                @change="setLoadModel"
                :options="
                  withIcons(
                    [
                      ['workers', 'Concurrent workers (closed)'],
                      ['rate', 'Target request rate (open)'],
                    ],
                    OPTION_ICONS.loadModel,
                  )
                "
            /></label>
            <label class="form-field"
              ><span>Collection</span
              ><UiSelect
                id="runner-folder"
                class="field-input"
                :value="view.folder"
                :disabled="view.locked"
                @change="setFolder"
                :options="withIcons(folders, 'folder-outline')"
            /></label>
            <label class="form-field"
              ><span>Environment</span
              ><UiSelect
                id="runner-environment"
                class="field-input"
                :disabled="view.locked"
                @change="runner.environment = Number(($event.target as HTMLSelectElement).value)"
                :value="String(view.environment)"
                :options="
                  withIcons(
                    workspace.state.environments.map((environment, index) => ({
                      value: String(index),
                      label: environment.name,
                    })),
                    'layers-outline',
                  )
                "
            /></label>
            <label v-for="field in fields" :key="field.key" class="form-field"
              ><span>{{ field.label }}</span
              ><input
                class="field-input"
                :data-runner-field="field.key"
                :aria-label="field.label"
                type="number"
                :min="field.min"
                :max="field.max"
                :step="field.step ?? 1"
                required
                :value="view.config[field.key]"
                :disabled="view.locked || (field.key === 'iterations' && Boolean(view.data))"
                :title="
                  field.key === 'iterations' && view.data
                    ? 'Each row of the data file is one iteration'
                    : undefined
                "
                @input="setField(field.key, $event)"
            /></label>
          </div>
          <UiExpansionPanel
            v-if="view.config.mode === 'collection'"
            class="runner-data"
            title="Data file"
            description="Run the requests once per row of a CSV, JSON, YAML, or XML file"
            icon="file-table-outline"
            :badge="view.data ? `${view.data.rows.length} rows` : undefined"
            :open="Boolean(view.data || view.dataError)"
          >
            <input
              ref="dataInput"
              type="file"
              class="sr-only"
              tabindex="-1"
              aria-hidden="true"
              data-runner-data-input
              :accept="RUN_DATA_ACCEPT"
              @change="onDataFile"
            />
            <!-- Before a file: a place to drop one, with what it can be. -->
            <div
              v-if="!view.data"
              :class="['runner-data-drop', { 'is-dragging': dataDragging }]"
              data-runner-data-drop
              @dragenter.prevent="dataDragging = !view.locked"
              @dragover.prevent="dataDragging = !view.locked"
              @dragleave="onDataLeave"
              @drop.prevent="onDataDrop"
            >
              <span class="runner-data-drop-icon" aria-hidden="true"
                ><MdiIcon name="file-upload-outline"
              /></span>
              <div class="runner-data-drop-copy">
                <strong>Drop a data file here</strong>
                <span>Each row runs the requests once, its columns as variables.</span>
                <ul class="runner-data-formats" aria-label="Formats">
                  <li v-for="format in DATA_FORMATS" :key="format[0]" :title="format[1]">
                    {{ format[0] }}
                  </li>
                </ul>
              </div>
              <UiButton
                label="Choose file…"
                icon="folder-open-outline"
                data-runner-data-choose
                :disabled="view.locked"
                @click="chooseData"
              />
            </div>
            <!-- A file: what it is, and the columns the requests can use. -->
            <div v-else class="runner-data-file" data-runner-data-file>
              <span class="runner-data-file-icon" aria-hidden="true"
                ><MdiIcon name="file-table-outline"
              /></span>
              <div class="runner-data-file-copy">
                <strong :title="view.data.name">{{ view.data.name }}</strong>
                <span data-runner-data-summary
                  ><span class="sr-only">{{ view.data.name }} · </span
                  >{{ runDataFormatName(view.data.format) }} · {{ view.data.rows.length }}
                  {{ view.data.rows.length === 1 ? 'row' : 'rows' }} ·
                  {{ view.data.columns.length }}
                  {{ view.data.columns.length === 1 ? 'column' : 'columns'
                  }}{{ runner.dataBytes ? ` · ${fileSize(runner.dataBytes)}` : '' }}</span
                >
              </div>
              <div class="runner-data-file-actions">
                <UiButton
                  label="Replace…"
                  icon="folder-open-outline"
                  variant="ghost"
                  data-runner-data-choose
                  :disabled="view.locked"
                  @click="chooseData"
                /><UiButton
                  label="Remove"
                  icon="close"
                  variant="ghost"
                  data-runner-data-remove
                  :disabled="view.locked"
                  @click="store.clearData()"
                />
              </div>
            </div>
            <p v-if="view.dataError" class="form-error" role="alert" data-runner-data-error>
              <MdiIcon name="alert-circle-outline" />{{ view.dataError }}
            </p>
            <template v-if="view.data">
              <div class="runner-data-columns" data-runner-data-columns>
                <span class="runner-data-label">Columns</span>
                <ul aria-label="Columns, and whether the requests use them">
                  <li
                    v-for="column in columnUse"
                    :key="column.name"
                    :class="{ 'is-unused': !column.requests }"
                    :data-runner-data-column="column.name"
                    :title="
                      column.requests
                        ? `Used by ${column.requests} of the selected requests`
                        : 'No selected request uses this column'
                    "
                  >
                    <code v-text="variable(column.name)"></code
                    ><span
                      ><MdiIcon
                        :name="column.requests ? 'check-circle-outline' : 'minus-circle-outline'"
                      />{{ column.requests ? `Used ×${column.requests}` : 'Not used' }}</span
                    >
                  </li>
                </ul>
              </div>
              <div class="table-scroll runner-data-table">
                <table class="runner-table runner-data-preview" aria-label="Data file preview">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th v-for="column in view.data.columns" :key="column">
                        <code v-text="variable(column)"></code>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(row, index) in view.data.rows.slice(0, DATA_PREVIEW_ROWS)"
                      :key="index"
                    >
                      <td>{{ index + 1 }}</td>
                      <td v-for="column in view.data.columns" :key="column" :title="row[column]">
                        {{ row[column] }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p class="runner-data-table-foot">
                  {{
                    view.data.rows.length > DATA_PREVIEW_ROWS
                      ? `Showing the first ${DATA_PREVIEW_ROWS} of ${view.data.rows.length.toLocaleString()} rows`
                      : `All ${view.data.rows.length} ${view.data.rows.length === 1 ? 'row' : 'rows'}`
                  }}
                </p>
              </div>
              <p class="field-help">
                Use a column as <code v-text="variable('column')"></code> in URLs, headers, bodies,
                and tests; it comes before environment variables of the same name.
              </p>
            </template>
            <p v-else class="field-help">
              CSV needs a header row of column names. JSON and YAML take a list of objects. XML
              takes repeated elements, such as <code>&lt;row&gt;</code> inside
              <code>&lt;rows&gt;</code>. Up to 10,000 rows and 5 MB.
            </p>
          </UiExpansionPanel>
          <UiExpansionPanel
            class="runner-advanced"
            title="Success criteria and thresholds"
            description="Successful status range, p95 latency, error rate, and minimum throughput"
            icon="filter-variant"
          >
            <div class="runner-config-grid">
              <label v-for="field in thresholdFields" :key="field.key" class="form-field"
                ><span>{{ field.label }}</span
                ><input
                  class="field-input"
                  :data-runner-field="field.key"
                  :aria-label="field.label"
                  type="number"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step ?? 1"
                  required
                  :value="view.config[field.key]"
                  :disabled="view.locked"
                  @input="setField(field.key, $event)"
              /></label>
            </div>
          </UiExpansionPanel>
          <UiExpansionPanel
            class="runner-request-picker"
            title="Requests"
            description="Choose which requests in the collection to run"
            icon="format-list-checks"
            :badge="`${view.chosen}/${view.requests.length} selected`"
            open
          >
            <TagFilterChips
              v-if="view.tagCounts.length"
              :counts="view.tagCounts"
              :filter="view.tags"
              verb="run"
              :disabled="view.locked"
              data-runner-tags
              @change="setTags"
            />
            <div class="runner-request-list">
              <label
                v-for="request in view.requests"
                :key="request.id"
                :class="{ 'is-filtered': view.filteredOut.has(request.id) }"
                :title="view.filteredOut.has(request.id) ? 'Left out by the tag filter' : undefined"
                @contextmenu="openRequestMenu($event, request.id)"
                @keydown="onRequestKeydown($event, request.id)"
                ><input
                  type="checkbox"
                  :data-runner-request="request.id"
                  :checked="isSelected(request.id)"
                  :disabled="view.locked"
                  @change="toggleRequest(request.id, ($event.target as HTMLInputElement).checked)"
                /><span :class="['method', request.method]"
                  ><MdiIcon :name="methodIcon(request.method)" class="method-icon" />{{
                    request.method
                  }}</span
                ><span>{{ request.name }}</span
                ><span v-if="view.tagsOf[request.id].length" class="runner-request-tags"
                  ><span v-for="tag in view.tagsOf[request.id]" :key="tag">{{ tag }}</span></span
                ></label
              >
            </div>
            <!-- Beside the list it acts on: inside a closed panel, the menu could not show. -->
            <ContextMenu
              ref="requestMenu"
              label="Run request actions"
              :items="requestMenuItems"
              data-runner-request-menu
              @select="onRequestMenu"
            />
          </UiExpansionPanel>
        </div>
        <aside class="runner-plan" aria-labelledby="runner-plan-title" data-runner-plan>
          <header>
            <span class="runner-plan-icon" aria-hidden="true"
              ><MdiIcon :name="OPTION_ICONS.runnerMode[view.config.mode]"
            /></span>
            <div>
              <h3 id="runner-plan-title">Run plan</h3>
              <p>{{ modeName }}</p>
            </div>
          </header>
          <p class="runner-plan-total" data-runner-plan-total>
            <strong>{{ plan.plannedLabel }}</strong>
          </p>
          <dl class="runner-plan-facts">
            <div v-for="fact in plan.facts" :key="fact.key" :data-runner-plan-fact="fact.key">
              <dt>{{ fact.label }}</dt>
              <dd :title="fact.value">{{ fact.value }}</dd>
            </div>
          </dl>
          <div class="runner-plan-criteria">
            <span>Passes when</span>
            <ul aria-label="Pass criteria">
              <li v-for="item in plan.criteria" :key="item"><MdiIcon name="check" />{{ item }}</li>
            </ul>
          </div>
          <label class="toggle-row runner-plan-switch"
            ><label class="toggle"
              ><input
                id="runner-stop-on-failure"
                type="checkbox"
                role="switch"
                :checked="view.config.stopOnFailure"
                :disabled="view.locked"
                @change="
                  runner.config!.stopOnFailure = ($event.target as HTMLInputElement).checked
                " /><span></span></label
            ><span>Stop after the first failure</span></label
          >
          <div v-if="progress" class="runner-progress" data-runner-progress>
            <div
              class="runner-progress-track"
              role="progressbar"
              :aria-valuenow="Math.round(progress.percent)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuetext="progress.label"
            >
              <span ref="progressBar"></span>
            </div>
            <small>{{ progress.label }}</small>
          </div>
          <div class="runner-controls">
            <UiButton
              v-if="view.running"
              label="Stop run"
              icon="close"
              variant="danger"
              data-runner-stop
              @click="store.stop()"
            />
            <UiButton
              v-else
              :label="
                view.config.mode === 'collection'
                  ? 'Run collection'
                  : view.config.mode === 'benchmark'
                    ? 'Start benchmark'
                    : 'Start performance test'
              "
              icon="play-outline"
              type="submit"
              variant="primary"
              :disabled="view.locked || !view.chosen"
            />
          </div>
          <p v-if="!view.chosen" class="runner-plan-warning" role="status">
            <MdiIcon name="alert-outline" />Choose at least one request to run.
          </p>
          <p v-if="view.error" class="form-error" role="alert">{{ view.error }}</p>
          <p class="field-help runner-plan-help">
            {{
              view.config.mode === 'collection'
                ? view.data
                  ? 'Runs requests sequentially with their saved assertions, once per data row.'
                  : 'Runs requests sequentially with their saved assertions.'
                : 'Measured runs use frozen request/environment snapshots and do not add samples to request history.'
            }}
            <template v-if="view.config.mode === 'performance'">{{
              view.config.loadModel === 'rate'
                ? 'Target rate starts requests on a fixed schedule whatever the latency, as real traffic arrives; starts beyond the in-flight limit are counted as dropped.'
                : 'Workers send their next request when the previous one finishes, so a slower API receives less load.'
            }}</template>
            Latency includes client dispatch, response transfer, and assertion evaluation. Warm-ups
            are excluded from metrics.
          </p>
        </aside>
      </div>
    </form>

    <ContextMenu
      ref="resultMenu"
      label="Run result actions"
      :items="resultMenuItems"
      data-runner-menu
      @select="onResultMenu"
    />
    <div id="runner-results" class="runner-results" aria-live="polite">
      <UiEmptyState
        v-if="!results.report && !results.running"
        icon="timer-outline"
        title="Ready to run"
        description="Choose requests and a run mode to measure your API."
      />
      <template v-else>
        <!-- The verdict first: passed, failed and why, cancelled, or still running. -->
        <div :class="['runner-verdict', `is-${verdict.tone}`]" data-runner-verdict>
          <span class="runner-verdict-icon" aria-hidden="true"
            ><MdiIcon :name="verdict.icon"
          /></span>
          <div class="runner-verdict-copy">
            <h2>{{ title }}</h2>
            <p>{{ summary }} · {{ number(results.elapsed / 1000, 2) }} s elapsed</p>
            <ul v-if="missed.length" class="runner-verdict-reasons" aria-label="Criteria missed">
              <li v-for="reason in missed" :key="reason">
                <MdiIcon name="close-circle-outline" />{{ reason }}
              </li>
            </ul>
          </div>
          <div class="runner-result-actions" role="group" aria-label="Export the report">
            <UiButton
              label="JSON"
              icon="download"
              variant="ghost"
              title="Export the report as JSON"
              data-runner-export="json"
              :disabled="!results.report"
              @click="store.exportReport('json')"
            /><UiButton
              label="CSV"
              icon="download"
              variant="ghost"
              title="Export every sample as CSV"
              data-runner-export="csv"
              :disabled="!results.report"
              @click="store.exportReport('csv')"
            /><UiButton
              label="Resources"
              icon="download"
              variant="ghost"
              title="Export app CPU and memory samples as CSV"
              data-runner-export="resources"
              :disabled="!results.report?.resources?.samples.length"
              @click="store.exportReport('resources')"
            />
          </div>
        </div>
        <div class="runner-metrics">
          <div
            v-for="card in cards"
            :key="card.key"
            :class="card.tone"
            :data-runner-metric="card.key"
          >
            <span><MdiIcon :name="card.icon" />{{ card.label }}</span
            ><strong>{{ card.value }}</strong
            ><small>{{ card.detail }}</small>
          </div>
        </div>
        <UiTabs
          group="runner-results"
          label="Run results"
          :items="resultTabs"
          :active="resultTab"
          attribute="data-runner-result-tab"
          panel="runner-results-panel"
          class="runner-result-tabs"
          @select="resultTab = $event as typeof resultTab"
        />
        <div id="runner-results-panel" role="tabpanel" class="runner-results-panel">
          <div v-show="resultTab === 'Overview'" class="runner-overview">
            <section
              v-if="results.report?.thresholds.length"
              class="runner-card runner-thresholds"
              aria-labelledby="runner-criteria-title"
            >
              <h3 id="runner-criteria-title">Pass criteria</h3>
              <div v-for="check in results.report.thresholds" :key="check.name">
                <MdiIcon
                  :name="check.passed ? 'check-circle-outline' : 'close-circle-outline'"
                /><span>{{ check.name }}</span
                ><strong>{{ number(check.actual, 2) }} / {{ number(check.limit, 2) }}</strong
                ><UiBadge
                  :label="check.passed ? 'Pass' : 'Fail'"
                  :tone="check.passed ? 'success' : 'danger'"
                />
              </div>
            </section>
            <div class="runner-overview-grid">
              <section class="runner-card" aria-labelledby="runner-latency-title">
                <h3 id="runner-latency-title">Latency</h3>
                <dl class="runner-stat-list" data-runner-latency>
                  <div v-for="[label, value] in latencyRows" :key="label">
                    <dt>{{ label }}</dt>
                    <dd>{{ value }}</dd>
                  </div>
                </dl>
              </section>
              <section class="runner-card" aria-labelledby="runner-reliability-title">
                <h3 id="runner-reliability-title">Reliability</h3>
                <dl class="runner-stat-list">
                  <div v-for="[label, value] in reliabilityRows" :key="label">
                    <dt>{{ label }}</dt>
                    <dd>{{ value }}</dd>
                  </div>
                </dl>
                <h4>Status codes</h4>
                <div class="runner-statuses">
                  <UiBadge
                    v-for="[status, count] in results.statusCounts"
                    :key="status"
                    :label="`${status}: ${count}`"
                  />
                </div>
              </section>
            </div>
            <RunnerActivity
              v-if="results.buckets.length"
              :buckets="results.buckets"
              :format="number"
            />
            <RunnerDistribution
              v-if="results.bins.length"
              :bins="results.bins"
              :p95="results.metrics.p95"
              :format="number"
            />
            <div v-if="results.report" class="runner-card runner-baseline">
              <div class="runner-samples-heading">
                <h3>Compared with baseline</h3>
                <div class="runner-result-actions">
                  <UiButton
                    :label="runner.baseline ? 'Replace baseline' : 'Save as baseline'"
                    icon="content-save-outline"
                    data-runner-baseline="save"
                    :disabled="results.running || results.report.outcome === 'cancelled'"
                    @click="store.saveBaseline()"
                  /><UiButton
                    v-if="runner.baseline"
                    label="Clear"
                    icon="close"
                    variant="ghost"
                    data-runner-baseline="clear"
                    @click="store.clearBaseline()"
                  />
                </div>
              </div>
              <p v-if="!runner.baseline" class="field-help">
                Save a run as the baseline for this collection and mode, then compare later runs
                with it. Changes over 10% in the worse direction are flagged.
              </p>
              <template v-else-if="results.comparison">
                <p class="field-help">
                  Baseline from {{ new Date(runner.baseline.savedAt).toLocaleString() }} ·
                  {{ runner.baseline.metrics.completed }} requests.
                </p>
                <div class="table-scroll">
                  <table class="runner-table">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Baseline</th>
                        <th>This run</th>
                        <th>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="row in results.comparison"
                        :key="row.key"
                        :data-baseline-metric="row.key"
                      >
                        <td>{{ row.label }}</td>
                        <td>{{ number(row.baseline, 2) }}</td>
                        <td>{{ number(row.current, 2) }}</td>
                        <td>
                          {{ signed(row.changePercent) }}
                          <UiBadge
                            v-if="row.regression"
                            label="Regression"
                            tone="danger"
                            icon="close-circle-outline"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </div>
            <div class="runner-card runner-resource-summary">
              <h3>Application resources</h3>
              <p class="field-help">
                CPU and memory cover API Workbench and its Electron helper processes. Memory is
                summed working set and may include shared pages. CPU uses Electron's reported
                process percentages. API server usage requires server-side monitoring. Samples are
                collected every 500 ms after warm-up.
              </p>
              <div class="runner-detail-summary">
                <span
                  >CPU average / peak: {{ resource(results.resources?.averageCpuPercent, '%') }} /
                  {{ resource(results.resources?.peakCpuPercent, '%') }}</span
                ><span
                  >Memory initial / peak / latest:
                  {{ resource(results.resources?.initialMemoryBytes, ' MiB', 1048576) }} /
                  {{ resource(results.resources?.peakMemoryBytes, ' MiB', 1048576) }} /
                  {{ resource(results.resources?.latestMemoryBytes, ' MiB', 1048576) }}</span
                ><span
                  >Memory change:
                  {{ resource(results.resources?.memoryChangeBytes, ' MiB', 1048576) }}</span
                ><span
                  >{{ results.resources?.samples.length || 0 }} resource samples{{
                    results.resources?.failures
                      ? ` · ${results.resources.failures} unavailable readings`
                      : ''
                  }}</span
                >
              </div>
              <p v-if="!results.resources" class="field-help">
                Resource monitoring is available in the Electron desktop app.
              </p>
              <p v-else-if="!results.resources.samples.length" class="field-help">
                Resource readings are unavailable for this run.
              </p>
            </div>
          </div>
          <div v-show="resultTab === 'Requests'" class="runner-tab-body">
            <div class="table-scroll">
              <table class="runner-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Completed</th>
                    <th>Errors</th>
                    <th>Avg ms</th>
                    <th>Median ms</th>
                    <th>p95 ms</th>
                    <th>p99 ms</th>
                    <th>Max ms</th>
                    <th>Req/s</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="endpoint in results.endpoints"
                    :key="endpoint.id"
                    tabindex="0"
                    :data-runner-endpoint="endpoint.id"
                    @contextmenu="openResultMenu($event, { kind: 'endpoint', endpoint })"
                    @keydown="onResultKeydown($event, { kind: 'endpoint', endpoint })"
                  >
                    <td>
                      <span :class="['method', endpoint.method]"
                        ><MdiIcon :name="methodIcon(endpoint.method)" class="method-icon" />{{
                          endpoint.method
                        }}</span
                      >
                      {{ endpoint.name }}
                    </td>
                    <td>{{ endpoint.metrics.completed }}</td>
                    <td>{{ number(endpoint.metrics.errorRate) }}%</td>
                    <td>{{ number(endpoint.metrics.average) }}</td>
                    <td>{{ number(endpoint.metrics.p50) }}</td>
                    <td>{{ number(endpoint.metrics.p95) }}</td>
                    <td>{{ number(endpoint.metrics.p99) }}</td>
                    <td>{{ number(endpoint.metrics.max) }}</td>
                    <td>{{ number(endpoint.metrics.rps) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-show="resultTab === 'Samples'" class="runner-tab-body">
            <div class="runner-samples-heading">
              <h3>Request samples</h3>
              <UiSelect
                id="runner-result-filter"
                class="field-input"
                aria-label="Filter run results"
                :value="view.filter"
                @change="setFilter"
                :options="
                  withTones(
                    withIcons(
                      ['all', 'passed', 'failed', 'cancelled'].map(
                        (filter) =>
                          [filter, filter[0].toUpperCase() + filter.slice(1)] as [string, string],
                      ),
                      OPTION_ICONS.runResult,
                    ),
                    { passed: 'level-tone-success', failed: 'level-tone-error' },
                  )
                "
              />
            </div>
            <p class="field-help">
              Showing the latest 100 matching samples. Exports include every measured sample;
              warm-ups are excluded.
            </p>
            <div class="table-scroll">
              <table class="runner-table">
                <thead>
                  <tr>
                    <th># / Iteration</th>
                    <th>Request</th>
                    <th>Status</th>
                    <th>Latency ms</th>
                    <th>Network ms</th>
                    <th>Assertions</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="sample in results.visible"
                    :key="sample.sequence"
                    tabindex="0"
                    :data-runner-sample="sample.sequence"
                    @contextmenu="openResultMenu($event, { kind: 'sample', sample })"
                    @keydown="onResultKeydown($event, { kind: 'sample', sample })"
                  >
                    <td>{{ sample.sequence }} / {{ sample.iteration }}</td>
                    <td>{{ sample.name }}</td>
                    <td>{{ sample.status || '—' }}</td>
                    <td>{{ number(sample.durationMs) }}</td>
                    <td>{{ sample.networkMs === undefined ? '—' : number(sample.networkMs) }}</td>
                    <td>{{ sample.testsPassed }}/{{ sample.testsTotal }}</td>
                    <td>
                      <UiBadge
                        :label="
                          sample.cancelled
                            ? 'Cancelled'
                            : sample.success
                              ? 'Passed'
                              : sample.failure || 'Failed'
                        "
                        :tone="sample.cancelled ? 'neutral' : sample.success ? 'success' : 'danger'"
                      />
                    </td>
                  </tr>
                  <tr
                    v-if="!results.visible.length"
                    class="table-empty-row"
                    data-runner-samples-empty
                  >
                    <td colspan="7">
                      <MdiIcon name="filter-variant" /><span>{{
                        view.filter === 'all'
                          ? 'No samples were measured in this run.'
                          : `No ${view.filter} samples in this run.`
                      }}</span
                      ><button
                        v-if="view.filter !== 'all'"
                        type="button"
                        class="text-button"
                        data-runner-show-all
                        @click="showAllSamples"
                      >
                        Show all samples
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-if="iterations.length" v-show="resultTab === 'Data rows'" class="runner-tab-body">
            <template v-if="iterations.length">
              <div class="table-scroll">
                <table class="runner-table runner-iterations" data-runner-iterations>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th v-for="column in iterationColumns" :key="column">{{ column }}</th>
                      <th title="Responses within the successful status range">In range</th>
                      <th>Assertions</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in iterations.slice(0, ITERATION_ROWS)"
                      :key="row.iteration"
                      :data-runner-iteration="row.iteration"
                    >
                      <td>{{ row.iteration }}</td>
                      <td
                        v-for="column in iterationColumns"
                        :key="column"
                        :title="row.values[column]"
                      >
                        {{ row.values[column] }}
                      </td>
                      <td>{{ row.succeeded }}/{{ row.requests }}</td>
                      <td>{{ row.testsPassed }}/{{ row.testsTotal }}</td>
                      <td>
                        <UiBadge
                          :label="!row.ran ? 'Not run' : row.passed ? 'Passed' : 'Failed'"
                          :tone="!row.ran ? 'neutral' : row.passed ? 'success' : 'danger'"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="iterations.length > ITERATION_ROWS" class="field-help">
                Showing the first {{ ITERATION_ROWS }} of {{ iterations.length }} rows; the JSON and
                CSV reports have every request.
              </p>
            </template>
          </div>
          <div v-show="resultTab === 'Errors'" class="runner-tab-body">
            <template v-if="results.errors.length">
              <h3 class="runner-section-title">Top errors</h3>
              <VaultUnlockNotice
                v-if="lockedVaultError"
                :message="lockedVaultError"
                :retry="store.start"
                retry-label="run again"
              />
              <div class="table-scroll">
                <table class="runner-table runner-errors">
                  <thead>
                    <tr>
                      <th>Failure</th>
                      <th>Message</th>
                      <th>Count</th>
                      <th title="Responses within the successful status range">In range</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="group in results.errors"
                      :key="group.failure + group.message"
                      tabindex="0"
                      data-runner-error-row
                      @contextmenu="openResultMenu($event, { kind: 'error', group })"
                      @keydown="onResultKeydown($event, { kind: 'error', group })"
                    >
                      <td><UiBadge :label="group.failure" tone="danger" /></td>
                      <td>
                        <code>{{ group.message }}</code>
                      </td>
                      <td>{{ group.count }}</td>
                      <td>{{ group.requests.join(', ') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
            <UiEmptyState
              v-if="!results.errors.length"
              icon="check-circle-outline"
              title="No errors"
              description="Every measured request succeeded."
            />
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
