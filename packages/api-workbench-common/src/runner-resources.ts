export interface ResourceReading {
  timestampMs: number;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}
export interface ResourceSample {
  elapsedMs: number;
  intervalMs: number;
  cpuPercent: number | null;
  memoryBytes: number;
  processCount: number;
}
export interface ResourceReport {
  scope: 'application';
  samples: ResourceSample[];
  failures: number;
  averageCpuPercent: number | null;
  peakCpuPercent: number | null;
  initialMemoryBytes: number | null;
  latestMemoryBytes: number | null;
  peakMemoryBytes: number | null;
  memoryChangeBytes: number | null;
}
export function summarizeResources(samples: ResourceSample[], failures = 0): ResourceReport {
  const cpu = samples.filter((sample) => sample.cpuPercent !== null && sample.intervalMs > 0);
  const duration = cpu.reduce((sum, sample) => sum + sample.intervalMs, 0);
  const initial = samples[0]?.memoryBytes ?? null;
  const latest = samples.at(-1)?.memoryBytes ?? null;
  return {
    scope: 'application',
    samples,
    failures,
    averageCpuPercent: duration
      ? cpu.reduce((sum, sample) => sum + sample.cpuPercent! * sample.intervalMs, 0) / duration
      : null,
    peakCpuPercent: cpu.length ? Math.max(...cpu.map((sample) => sample.cpuPercent!)) : null,
    initialMemoryBytes: initial,
    latestMemoryBytes: latest,
    peakMemoryBytes: samples.length
      ? Math.max(...samples.map((sample) => sample.memoryBytes))
      : null,
    memoryChangeBytes: initial !== null && latest !== null ? latest - initial : null,
  };
}
export function createResourceMonitor(
  read: () => Promise<ResourceReading>,
  onSample: () => void = () => {},
) {
  const samples: ResourceSample[] = [];
  let failures = 0,
    first: number | undefined,
    previous: number | undefined;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const capture = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const reading = await read();
        if (
          ![
            reading.timestampMs,
            reading.cpuPercent,
            reading.memoryBytes,
            reading.processCount,
          ].every(Number.isFinite) ||
          reading.memoryBytes < 0 ||
          reading.cpuPercent < 0 ||
          reading.processCount < 1 ||
          (previous !== undefined && reading.timestampMs <= previous)
        )
          throw new Error('Invalid resource reading');
        first ??= reading.timestampMs;
        const intervalMs = previous === undefined ? 0 : reading.timestampMs - previous;
        samples.push({
          elapsedMs: reading.timestampMs - first,
          intervalMs,
          cpuPercent: previous === undefined ? null : reading.cpuPercent,
          memoryBytes: reading.memoryBytes,
          processCount: reading.processCount,
        });
        previous = reading.timestampMs;
      } catch {
        failures++;
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    report: () => summarizeResources([...samples], failures),
    async start() {
      await capture();
      timer = setInterval(() => {
        void capture().then(onSample);
      }, 500);
    },
    async stop() {
      clearInterval(timer);
      if (pending) await pending;
      await capture();
    },
    dispose() {
      clearInterval(timer);
    },
  };
}
export function resourcesCsv(report: ResourceReport): string {
  return [
    'elapsed_ms,interval_ms,cpu_percent,memory_bytes,process_count',
    ...report.samples.map((sample) =>
      [
        sample.elapsedMs,
        sample.intervalMs,
        sample.cpuPercent ?? '',
        sample.memoryBytes,
        sample.processCount,
      ].join(','),
    ),
  ].join('\r\n');
}
