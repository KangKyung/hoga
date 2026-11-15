/**
 * 외부 의존성 없이 Prometheus 텍스트 형식으로 내보내는 최소 지표 모음.
 * (prom-client로 바꿔도 이름은 유지한다)
 */
type Labels = Record<string, string>;

const key = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')}}`
    : name;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, () => number>();
  private readonly help = new Map<string, { type: 'counter' | 'gauge'; text: string }>();

  describe(name: string, type: 'counter' | 'gauge', text: string): void {
    this.help.set(name, { type, text });
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  gauge(name: string, read: () => number, labels?: Labels): void {
    this.gauges.set(key(name, labels), read);
  }

  get(name: string, labels?: Labels): number {
    const k = key(name, labels);
    return this.counters.get(k) ?? this.gauges.get(k)?.() ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    const all: [string, number][] = [
      ...this.counters.entries(),
      ...[...this.gauges.entries()].map(([k, read]) => [k, read()] as [string, number]),
    ];
    all.sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of all) {
      const base = k.split('{')[0]!;
      const help = this.help.get(base);
      if (help && !seen.has(base)) {
        lines.push(`# HELP ${base} ${help.text}`, `# TYPE ${base} ${help.type}`);
        seen.add(base);
      }
      lines.push(`${k} ${v}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
