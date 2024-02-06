/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/ban-ts-comment */

import type { SpiedFunction } from 'jest-mock';
import { panic, warn, info, check } from './log.js';
import { jest } from '@jest/globals';

describe('Your Module Tests', () => {
	let processSpy: SpiedFunction<{
		(buffer: Uint8Array | string, cb?: ((err?: Error) => void)): boolean; (str: Uint8Array | string, encoding?: BufferEncoding, cb?: ((err?: Error) => void)): boolean;
	}>;
	let abortSpy: SpiedFunction<(code?: number) => never>;

	beforeEach(() => {
		// Mock process.stderr.write before each test
		// @ts-expect-error
		processSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => { });
		// @ts-expect-error
		abortSpy = jest.spyOn(process, 'exit').mockImplementation(() => { });
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

	it('check should catch error, write error message, and rethrow', async () => {
		const error = new Error('test error');
		const promise = Promise.reject(error);
		await expect(check('test check', promise)).rejects.toThrow();
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('\u2718 test check'));
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! ERROR: test error'));
	});
});
