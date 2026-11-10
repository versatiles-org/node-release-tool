import { describe, expect, it } from 'vitest';
import {
	formatError,
	gitError,
	markdownError,
	notImplementedError,
	releaseError,
	ShellError,
	validationError,
	VrtError,
} from './errors.js';

describe('VrtError', () => {
	it('should create an error with default code', () => {
		const error = new VrtError('test message');

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(VrtError);
		expect(error.message).toBe('test message');
		expect(error.code).toBe('VALIDATION_ERROR');
		expect(error.name).toBe('VrtError');
	});

	it('should create an error with custom code', () => {
		const error = new VrtError('test message', 'GIT_ERROR');

		expect(error.message).toBe('test message');
		expect(error.code).toBe('GIT_ERROR');
	});

	it('should have a proper stack trace', () => {
		const error = new VrtError('test message');

		expect(error.stack).toBeDefined();
		expect(error.stack).toContain('VrtError');
	});
});

describe('error helper functions', () => {
	it('validationError should create VALIDATION_ERROR', () => {
		const error = validationError('invalid input');

		expect(error.code).toBe('VALIDATION_ERROR');
		expect(error.message).toBe('invalid input');
	});

	it('markdownError should create MARKDOWN_ERROR', () => {
		const error = markdownError('parse error');

		expect(error.code).toBe('MARKDOWN_ERROR');
		expect(error.message).toBe('parse error');
	});

	it('gitError should create GIT_ERROR', () => {
		const error = gitError('commit failed');

		expect(error.code).toBe('GIT_ERROR');
		expect(error.message).toBe('commit failed');
	});

	it('releaseError should create RELEASE_ERROR', () => {
		const error = releaseError('publish failed');

		expect(error.code).toBe('RELEASE_ERROR');
		expect(error.message).toBe('publish failed');
	});

	it('notImplementedError should create NOT_IMPLEMENTED with formatted message', () => {
		const error = notImplementedError('featureX');

		expect(error.code).toBe('NOT_IMPLEMENTED');
		expect(error.message).toBe('Not implemented yet: "featureX"');
	});
});

describe('ShellError', () => {
	it('should describe the exit code and include stderr', () => {
		const error = new ShellError({
			command: 'npm i',
			exitCode: 1,
			signal: null,
			stdout: 'some progress\n',
			stderr: 'npm ERR! code E404\n',
		});

		expect(error).toBeInstanceOf(VrtError);
		expect(error.name).toBe('ShellError');
		expect(error.code).toBe('SHELL_ERROR');
		expect(error.exitCode).toBe(1);
		expect(error.message).toBe('Command failed with exit code 1: npm i\nnpm ERR! code E404');
	});

	it('should fall back to stdout when stderr is empty', () => {
		const error = new ShellError({ command: 'npm i', exitCode: 2, signal: null, stdout: 'failure details\n' });

		expect(error.message).toBe('Command failed with exit code 2: npm i\nfailure details');
	});

	it('should truncate long output to the last 20 lines', () => {
		const stderr = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
		const error = new ShellError({ command: 'npm i', exitCode: 1, signal: null, stderr });

		const lines = error.message.split('\n');
		expect(lines[0]).toBe('Command failed with exit code 1: npm i');
		expect(lines[1]).toBe('…');
		expect(lines).toHaveLength(22);
		expect(lines.at(-1)).toBe('line 30');
		expect(lines[2]).toBe('line 11');
	});

	it('should describe termination by signal', () => {
		const error = new ShellError({ command: 'sleep 100', exitCode: null, signal: 'SIGTERM' });

		expect(error.message).toBe('Command was terminated by signal SIGTERM: sleep 100');
	});

	it('should describe a failed spawn', () => {
		const cause = new Error('spawn ENOENT');
		const error = new ShellError({ command: 'nope', exitCode: null, signal: null, cause });

		expect(error.message).toBe('Command could not be executed: nope\nspawn ENOENT');
		expect(error.cause).toBe(cause);
	});
});

describe('formatError', () => {
	it('should prefix the code of a VrtError', () => {
		expect(formatError(gitError('commit failed'))).toBe('[GIT_ERROR] commit failed');
	});

	it('should use the message of an Error', () => {
		expect(formatError(new Error('boom'))).toBe('boom');
	});

	it('should fall back to the name of an Error without message', () => {
		expect(formatError(new RangeError())).toBe('RangeError');
	});

	it('should pass through strings', () => {
		expect(formatError('just a string')).toBe('just a string');
	});

	it('should serialize plain objects instead of printing "[object Object]"', () => {
		expect(formatError({ code: 1, stderr: 'oops' })).toBe('{"code":1,"stderr":"oops"}');
	});

	it('should use a message property of a plain object', () => {
		expect(formatError({ message: 'something went wrong' })).toBe('something went wrong');
	});

	it('should handle objects that cannot be serialized', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(formatError(circular)).toBe('[object Object]');
	});

	it('should handle null, undefined and other primitives', () => {
		expect(formatError(null)).toBe('null');
		expect(formatError(undefined)).toBe('undefined');
		expect(formatError(42)).toBe('42');
	});
});
