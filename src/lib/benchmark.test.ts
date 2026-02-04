import { describe, expect, it, vi } from 'vitest';
import { benchmark, benchmarkSync, calculateStats, createTimer, formatDuration } from './benchmark.js';

describe('formatDuration', () => {
	it('formats milliseconds under 1 second', () => {
		expect(formatDuration(0)).toBe('0ms');
		expect(formatDuration(1)).toBe('1ms');
		expect(formatDuration(100)).toBe('100ms');
		expect(formatDuration(999)).toBe('999ms');
	});

	it('formats seconds with two decimal places', () => {
		expect(formatDuration(1000)).toBe('1.00s');
		expect(formatDuration(1500)).toBe('1.50s');
		expect(formatDuration(2345)).toBe('2.35s');
		expect(formatDuration(60000)).toBe('60.00s');
	});

	it('rounds milliseconds to whole numbers', () => {
		expect(formatDuration(1.4)).toBe('1ms');
		expect(formatDuration(1.6)).toBe('2ms');
		expect(formatDuration(99.9)).toBe('100ms');
	});
});

describe('benchmarkSync', () => {
	it('returns the function result', () => {
		const { result } = benchmarkSync(() => 42);
		expect(result).toBe(42);
	});

	it('measures execution duration', () => {
		const { durationMs } = benchmarkSync(() => {
			// Small computation
			let sum = 0;
			for (let i = 0; i < 1000; i++) sum += i;
			return sum;
		});

		expect(durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof durationMs).toBe('number');
	});

	it('provides formatted duration', () => {
		const { durationFormatted } = benchmarkSync(() => 'test');
		expect(durationFormatted).toMatch(/^\d+(ms|\.\d{2}s)$/);
	});

	it('logs when log option is true and label is provided', () => {
		const logger = vi.fn();
		benchmarkSync(() => 'test', { label: 'Test operation', log: true, logger });

		expect(logger).toHaveBeenCalledTimes(1);
		expect(logger).toHaveBeenCalledWith(expect.stringContaining('[benchmark] Test operation:'));
	});

	it('does not log when log option is false', () => {
		const logger = vi.fn();
		benchmarkSync(() => 'test', { label: 'Test', log: false, logger });

		expect(logger).not.toHaveBeenCalled();
	});

	it('does not log when label is not provided', () => {
		const logger = vi.fn();
		benchmarkSync(() => 'test', { log: true, logger });

		expect(logger).not.toHaveBeenCalled();
	});

	it('handles functions that throw errors', () => {
		expect(() =>
			benchmarkSync(() => {
				throw new Error('test error');
			}),
		).toThrow('test error');
	});
});

describe('benchmark (async)', () => {
	it('returns the async function result', async () => {
		const { result } = await benchmark(async () => 42);
		expect(result).toBe(42);
	});

	it('measures async execution duration', async () => {
		const { durationMs } = await benchmark(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return 'done';
		});

		expect(durationMs).toBeGreaterThanOrEqual(29);
	});

	it('provides formatted duration', async () => {
		const { durationFormatted } = await benchmark(async () => 'test');
		expect(durationFormatted).toMatch(/^\d+(ms|\.\d{2}s)$/);
	});

	it('logs when log option is true and label is provided', async () => {
		const logger = vi.fn();
		await benchmark(async () => 'test', { label: 'Async operation', log: true, logger });

		expect(logger).toHaveBeenCalledTimes(1);
		expect(logger).toHaveBeenCalledWith(expect.stringContaining('[benchmark] Async operation:'));
	});

	it('handles async functions that reject', async () => {
		await expect(
			benchmark(async () => {
				throw new Error('async error');
			}),
		).rejects.toThrow('async error');
	});
});

describe('createTimer', () => {
	it('measures elapsed time', () => {
		const timer = createTimer();
		timer.start();
		const result = timer.stop();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.durationFormatted).toMatch(/^\d+(ms|\.\d{2}s)$/);
	});

	it('returns elapsed time while running', async () => {
		const timer = createTimer();
		timer.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const elapsed = timer.elapsed();

		expect(elapsed).toBeGreaterThanOrEqual(29);
	});

	it('returns 0 elapsed time before starting', () => {
		const timer = createTimer();
		expect(timer.elapsed()).toBe(0);
	});

	it('returns final elapsed time after stopping', () => {
		const timer = createTimer();
		timer.start();
		const result = timer.stop();
		const elapsed = timer.elapsed();

		expect(elapsed).toBe(result.durationMs);
	});

	it('throws when stopping without starting', () => {
		const timer = createTimer();
		expect(() => timer.stop()).toThrow('Timer was not started');
	});

	it('reports running state correctly', () => {
		const timer = createTimer();

		expect(timer.isRunning()).toBe(false);

		timer.start();
		expect(timer.isRunning()).toBe(true);

		timer.stop();
		expect(timer.isRunning()).toBe(false);
	});

	it('can be restarted', () => {
		const timer = createTimer();

		timer.start();
		timer.stop();

		timer.start();
		expect(timer.isRunning()).toBe(true);
		const result = timer.stop();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe('calculateStats', () => {
	it('calculates stats for an array of durations', () => {
		const durations = [100, 200, 300, 400, 500];
		const stats = calculateStats(durations);

		expect(stats.count).toBe(5);
		expect(stats.totalMs).toBe(1500);
		expect(stats.avgMs).toBe(300);
		expect(stats.minMs).toBe(100);
		expect(stats.maxMs).toBe(500);
		expect(stats.avgFormatted).toBe('300ms');
	});

	it('handles empty array', () => {
		const stats = calculateStats([]);

		expect(stats.count).toBe(0);
		expect(stats.totalMs).toBe(0);
		expect(stats.avgMs).toBe(0);
		expect(stats.minMs).toBe(0);
		expect(stats.maxMs).toBe(0);
		expect(stats.avgFormatted).toBe('0ms');
	});

	it('handles single value', () => {
		const stats = calculateStats([150]);

		expect(stats.count).toBe(1);
		expect(stats.totalMs).toBe(150);
		expect(stats.avgMs).toBe(150);
		expect(stats.minMs).toBe(150);
		expect(stats.maxMs).toBe(150);
	});

	it('formats average in seconds when appropriate', () => {
		const durations = [1000, 2000, 3000];
		const stats = calculateStats(durations);

		expect(stats.avgFormatted).toBe('2.00s');
	});

	it('handles decimal durations', () => {
		const durations = [10.5, 20.3, 30.2];
		const stats = calculateStats(durations);

		expect(stats.totalMs).toBeCloseTo(61, 0);
		expect(stats.avgMs).toBeCloseTo(20.33, 1);
	});
});
