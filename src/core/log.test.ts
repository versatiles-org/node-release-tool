import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { check, info, panic, warn } from './log.js';

describe('Your Module Tests', () => {
	let processSpy: MockInstance<{
		(buffer: Uint8Array | string, cb?: (err?: Error) => void): boolean;
		(str: Uint8Array | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean;
	}>;
	let abortSpy: MockInstance<(code?: number) => never>;

	beforeEach(() => {
		// Mock process.stderr.write before each test
		processSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		abortSpy = vi.spyOn(process, 'exit').mockImplementation(() => null as never);
	});

	afterEach(() => {
		// Restore the original implementation after each test
		processSpy.mockRestore();
		abortSpy.mockRestore();
	});

	it('panic should write to stderr and call abort', () => {
		panic('test panic');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! ERROR: test panic'));
		expect(abortSpy).toHaveBeenCalled();
	});

	it('warn should write a warning message to stderr', () => {
		warn('test warning');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! warning: test warning'));
	});

	it('info should write an info message to stderr', () => {
		info('test info');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('i test info'));
	});

	it('check should resolve correctly and write success message', async () => {
		const promise = Promise.resolve('success');
		await expect(check('test check', promise)).resolves.toEqual('success');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('\u2714 test check'));
	});

	it('check should catch error, write error message, and call panic', async () => {
		const error = new Error('test error');
		const promise = Promise.reject(error);
		await check('test check', promise);
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('\u2718 test check'));
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! ERROR: test error'));
		expect(abortSpy).toHaveBeenCalled();
	});

	it('check should run the onError callback after reporting the error and before aborting', async () => {
		const order: string[] = [];
		processSpy.mockImplementation((text) => {
			if (String(text).includes('ERROR')) order.push('error message');
			return true;
		});
		abortSpy.mockImplementation(() => {
			order.push('exit');
			return null as never;
		});
		const error = new Error('test error');
		const onError = vi.fn(() => {
			order.push('cleanup');
		});

		await check('test check', Promise.reject(error), onError);

		expect(onError).toHaveBeenCalledWith(error);
		expect(order).toStrictEqual(['error message', 'cleanup', 'exit']);
	});

	it('check should not run the onError callback on success', async () => {
		const onError = vi.fn();
		await expect(check('test check', Promise.resolve('success'), onError)).resolves.toBe('success');
		expect(onError).not.toHaveBeenCalled();
	});

	it('check should keep messages logged while it runs out of its line', async () => {
		await check('test check', async () => {
			await Promise.resolve();
			info('inside');
		});
		info('after');

		expect(processSpy.mock.calls.map((c) => c[0])).toStrictEqual([
			'\x1b[0;90m⮕ test check\x1b[0m',
			'\r\x1b[K\x1b[0mi inside\n\x1b[0;90m⮕ test check\x1b[0m',
			'\r\x1b[K\x1b[0;92m✔ test check\x1b[0m\n',
			'\x1b[0mi after\n',
		]);
	});

	it('check should restore the line of an outer check when a nested one is done', async () => {
		await check('outer', () => check('inner', Promise.resolve()));

		expect(processSpy.mock.calls.map((c) => c[0])).toStrictEqual([
			'\x1b[0;90m⮕ outer\x1b[0m',
			'\r\x1b[K\x1b[0;90m⮕ inner\x1b[0m',
			'\r\x1b[K\x1b[0;92m✔ inner\x1b[0m\n\x1b[0;90m⮕ outer\x1b[0m',
			'\r\x1b[K\x1b[0;92m✔ outer\x1b[0m\n',
		]);
	});

	it('check should not report "[object Object]" for non-Error rejections', async () => {
		// see issue #55
		const promise = Promise.reject({ code: 1, stdout: '', stderr: 'npm install failed' });
		await check('test check', promise);
		expect(processSpy).toHaveBeenCalledWith(
			expect.stringContaining('! ERROR: {"code":1,"stdout":"","stderr":"npm install failed"}'),
		);
		expect(abortSpy).toHaveBeenCalled();
	});
});
