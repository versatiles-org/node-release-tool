import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

describe('withRetry', () => {
	it('should return result on first successful attempt', async () => {
		const fn = vi.fn().mockResolvedValue('success');

		const result = await withRetry(fn);

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('should retry on failure and succeed eventually', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail 1'))
			.mockRejectedValueOnce(new Error('fail 2'))
			.mockResolvedValue('success');

		const result = await withRetry(fn, { initialDelayMs: 1 });

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('should throw after max retries exhausted', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

		await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1 })).rejects.toThrow('persistent failure');

		expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
	});

	it('should call onRetry callback before each retry', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail 1'))
			.mockRejectedValueOnce(new Error('fail 2'))
			.mockResolvedValue('success');

		const onRetry = vi.fn();

		await withRetry(fn, { initialDelayMs: 1, onRetry });

		expect(onRetry).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 1);
		expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 2);
	});

	it('should use exponential backoff', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail'))
			.mockRejectedValueOnce(new Error('fail'))
			.mockRejectedValueOnce(new Error('fail'))
			.mockResolvedValue('success');

		const onRetry = vi.fn();

		await withRetry(fn, {
			initialDelayMs: 100,
			backoffMultiplier: 2,
			onRetry,
		});

		expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
		expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 200);
		expect(onRetry).toHaveBeenNthCalledWith(3, 3, expect.any(Error), 400);
	});

	it('should respect maxDelayMs', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail'))
			.mockRejectedValueOnce(new Error('fail'))
			.mockResolvedValue('success');

		const onRetry = vi.fn();

		await withRetry(fn, {
			initialDelayMs: 100,
			backoffMultiplier: 10,
			maxDelayMs: 150,
			onRetry,
		});

		expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
		expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 150); // Capped at maxDelayMs
	});

	it('should handle non-Error throws', async () => {
		const fn = vi.fn().mockRejectedValueOnce('string error').mockResolvedValue('success');

		const onRetry = vi.fn();

		const result = await withRetry(fn, { initialDelayMs: 1, onRetry });

		expect(result).toBe('success');
		expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 1);
	});

	it('should work with zero retries', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('fail');

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('should preserve error message from last failure', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('first error'))
			.mockRejectedValueOnce(new Error('second error'))
			.mockRejectedValue(new Error('last error'));

		await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1 })).rejects.toThrow('last error');
	});

	it('should handle undefined rejection', async () => {
		const fn = vi.fn().mockRejectedValueOnce(undefined).mockResolvedValue('success');

		const result = await withRetry(fn, { initialDelayMs: 1 });

		expect(result).toBe('success');
	});

	it('should handle null rejection', async () => {
		const fn = vi.fn().mockRejectedValueOnce(null).mockResolvedValue('success');

		const result = await withRetry(fn, { initialDelayMs: 1 });

		expect(result).toBe('success');
	});

	it('should work with async functions that return different types', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail'))
			.mockResolvedValue({ data: [1, 2, 3] });

		const result = await withRetry(fn, { initialDelayMs: 1 });

		expect(result).toEqual({ data: [1, 2, 3] });
	});
});
