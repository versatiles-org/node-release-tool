/**
 * Performance benchmarking utilities for CLI operations.
 *
 * Provides timing measurement and optional logging for tracking
 * execution duration of key operations.
 */

/**
 * Result of a benchmarked operation
 */
export interface BenchmarkResult<T> {
	/** The result returned by the benchmarked function */
	result: T;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Human-readable duration string */
	durationFormatted: string;
}

/**
 * Options for benchmark execution
 */
export interface BenchmarkOptions {
	/** Label for the operation being benchmarked */
	label?: string;
	/** Whether to log timing to console */
	log?: boolean;
	/** Custom logger function (defaults to console.log) */
	logger?: (message: string) => void;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "1.23s", "456ms")
 */
export function formatDuration(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(2)}s`;
	}
	return `${Math.round(ms)}ms`;
}

/**
 * Measures the execution time of a synchronous function.
 *
 * @param fn - The function to benchmark
 * @param options - Optional benchmark configuration
 * @returns The function result along with timing information
 *
 * @example
 * ```ts
 * const { result, durationMs } = benchmarkSync(() => {
 *   return heavyComputation();
 * }, { label: 'Heavy computation', log: true });
 * ```
 */
export function benchmarkSync<T>(fn: () => T, options: BenchmarkOptions = {}): BenchmarkResult<T> {
	const { label, log = false, logger = console.log } = options;

	const start = performance.now();
	const result = fn();
	const end = performance.now();

	const durationMs = end - start;
	const durationFormatted = formatDuration(durationMs);

	if (log && label) {
		logger(`[benchmark] ${label}: ${durationFormatted}`);
	}

	return { result, durationMs, durationFormatted };
}

/**
 * Measures the execution time of an asynchronous function.
 *
 * @param fn - The async function to benchmark
 * @param options - Optional benchmark configuration
 * @returns Promise resolving to the function result along with timing information
 *
 * @example
 * ```ts
 * const { result, durationMs } = await benchmark(async () => {
 *   return await fetchData();
 * }, { label: 'API fetch', log: true });
 * ```
 */
export async function benchmark<T>(fn: () => Promise<T>, options: BenchmarkOptions = {}): Promise<BenchmarkResult<T>> {
	const { label, log = false, logger = console.log } = options;

	const start = performance.now();
	const result = await fn();
	const end = performance.now();

	const durationMs = end - start;
	const durationFormatted = formatDuration(durationMs);

	if (log && label) {
		logger(`[benchmark] ${label}: ${durationFormatted}`);
	}

	return { result, durationMs, durationFormatted };
}

/**
 * Creates a timer for manual timing control.
 *
 * @returns Timer object with start, stop, and elapsed methods
 *
 * @example
 * ```ts
 * const timer = createTimer();
 * timer.start();
 * // ... do work ...
 * const elapsed = timer.stop();
 * console.log(`Operation took ${elapsed.durationFormatted}`);
 * ```
 */
export function createTimer(): {
	start: () => void;
	stop: () => { durationMs: number; durationFormatted: string };
	elapsed: () => number;
	isRunning: () => boolean;
} {
	let startTime: number | null = null;
	let endTime: number | null = null;

	return {
		start(): void {
			startTime = performance.now();
			endTime = null;
		},

		stop(): { durationMs: number; durationFormatted: string } {
			if (startTime === null) {
				throw new Error('Timer was not started');
			}
			endTime = performance.now();
			const durationMs = endTime - startTime;
			return { durationMs, durationFormatted: formatDuration(durationMs) };
		},

		elapsed(): number {
			if (startTime === null) {
				return 0;
			}
			const end = endTime ?? performance.now();
			return end - startTime;
		},

		isRunning(): boolean {
			return startTime !== null && endTime === null;
		},
	};
}

/**
 * Aggregates multiple benchmark results for statistical analysis.
 */
export interface BenchmarkStats {
	/** Number of samples */
	count: number;
	/** Total duration in milliseconds */
	totalMs: number;
	/** Average duration in milliseconds */
	avgMs: number;
	/** Minimum duration in milliseconds */
	minMs: number;
	/** Maximum duration in milliseconds */
	maxMs: number;
	/** Formatted average duration */
	avgFormatted: string;
}

/**
 * Calculates statistics from an array of benchmark durations.
 *
 * @param durations - Array of duration values in milliseconds
 * @returns Statistical summary of the benchmarks
 *
 * @example
 * ```ts
 * const durations = [100, 150, 120, 130, 110];
 * const stats = calculateStats(durations);
 * console.log(`Average: ${stats.avgFormatted}`);
 * ```
 */
export function calculateStats(durations: number[]): BenchmarkStats {
	if (durations.length === 0) {
		return {
			count: 0,
			totalMs: 0,
			avgMs: 0,
			minMs: 0,
			maxMs: 0,
			avgFormatted: '0ms',
		};
	}

	const totalMs = durations.reduce((sum, d) => sum + d, 0);
	const avgMs = totalMs / durations.length;

	return {
		count: durations.length,
		totalMs,
		avgMs,
		minMs: Math.min(...durations),
		maxMs: Math.max(...durations),
		avgFormatted: formatDuration(avgMs),
	};
}
