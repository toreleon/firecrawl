export class BenchmarkTiming {
  private previousMs: number;
  private maximumGapMs = 0;
  private readonly gaps: {
    from: string;
    to: string;
    elapsedMs: number;
  }[] = [];

  constructor(
    private readonly now = Date.now,
    readonly maximumAllowedGapMs = 10000,
  ) {
    this.previousMs = now();
  }

  // Sample on an independent timer, including while HTTP requests are pending.
  // A long wall-clock gap can indicate host suspension or a stalled event loop.
  sample() {
    const currentMs = this.now();
    const elapsedMs = currentMs - this.previousMs;
    this.maximumGapMs = Math.max(this.maximumGapMs, elapsedMs);
    const invalid = elapsedMs > this.maximumAllowedGapMs || elapsedMs < 0;
    if (invalid) {
      this.gaps.push({
        from: new Date(this.previousMs).toISOString(),
        to: new Date(currentMs).toISOString(),
        elapsedMs,
      });
    }
    this.previousMs = currentMs;
    return invalid;
  }

  snapshot() {
    this.sample();
    return {
      valid: this.gaps.length === 0,
      sampleIntervalMs: 1000,
      maximumAllowedGapMs: this.maximumAllowedGapMs,
      maximumObservedGapMs: this.maximumGapMs,
      gaps: this.gaps.map((gap) => ({ ...gap })),
    };
  }
}
