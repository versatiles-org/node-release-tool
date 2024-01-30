// Import the functions from your module
import { SpiedFunction } from 'jest-mock';
import { panic, warn, info, check } from './log.js';
import { jest } from '@jest/globals';

describe('Your Module Tests', () => {
	let processSpy: SpiedFunction<{
		(buffer: string | Uint8Array, cb?: ((err?: Error | undefined) => void) | undefined): boolean; (str: string | Uint8Array, encoding?: BufferEncoding | undefined, cb?: ((err?: Error | undefined) => void) |
			undefined): boolean;
	}>;
	let abortSpy: SpiedFunction<(code?: number | undefined) => never>;

	beforeEach(() => {
		// Mock process.stderr.write before each test
		// @ts-ignore
		processSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => { });
		// @ts-ignore
		abortSpy = jest.spyOn(process, 'exit').mockImplementation(() => { });
	});

	afterEach(() => {
		// Restore the original implementation after each test
		processSpy.mockRestore();
		abortSpy.mockRestore();
	});

	test('panic should write to stderr and call abort', () => {
		panic('test panic');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! ERROR: test panic'));
		expect(abortSpy).toHaveBeenCalled();
	});

	test('warn should write a warning message to stderr', () => {
		warn('test warning');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! warning: test warning'));
	});

	test('info should write an info message to stderr', () => {
		info('test info');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('i test info'));
	});

	test('check should resolve correctly and write success message', async () => {
		const promise = Promise.resolve('success');
		await expect(check('test check', promise)).resolves.toEqual('success');
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('\u2714 test check'));
	});

	test('check should catch error, write error message, and rethrow', async () => {
		const error = new Error('test error');
		const promise = Promise.reject(error);
		await expect(check('test check', promise)).rejects.toThrow();
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('\u2718 test check'));
		expect(processSpy).toHaveBeenCalledWith(expect.stringContaining('! ERROR: test error'));
	});
});
