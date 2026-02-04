import { describe, expect, it } from 'vitest';
import { gitError, markdownError, notImplementedError, releaseError, validationError, VrtError } from './errors.js';

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
