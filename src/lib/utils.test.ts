import { getErrorMessage, prettyStyleJSON } from './utils.js';

describe('getErrorMessage', () => {
	// Test for null input
	it('returns "unknown" for null', () => {
		expect(getErrorMessage(null)).toBe('unknown');
	});

	// Test for error objects with a message property
	it('returns the message for error objects with a message property', () => {
		const error = { message: 'Test error message' };
		expect(getErrorMessage(error)).toBe('Test error message');
	});

	// Test for error objects without a message property
	it('returns "unknown" for error objects without a message property', () => {
		const error = { noMessage: 'No message here' };
		expect(getErrorMessage(error)).toBe('unknown');
	});

	// Test for non-object errors
	it('returns "unknown" for non-object errors', () => {
		expect(getErrorMessage(42)).toBe('unknown');
		expect(getErrorMessage('Error string')).toBe('unknown');
		expect(getErrorMessage(undefined)).toBe('unknown');
	});

	// Test for custom error objects with a message property
	it('handles custom error objects with a message property', () => {
		class CustomError {
			public message = 'Custom error message';
		}
		const error = new CustomError();
		expect(getErrorMessage(error)).toBe('Custom error message');
	});

	// Additional test: Error object with non-string message property
	it('returns stringified message for error objects with non-string message property', () => {
		const error = { message: { complex: 'error', code: 404 } };
		expect(getErrorMessage(error)).toBe('{"complex":"error","code":404}');
	});
});

describe('prettyStyleJSON', () => {
	// Test for simple objects
	it('formats simple JSON objects correctly', () => {
		const data = { a: 1, b: 'test' };
		expect(prettyStyleJSON(data)).toBe('{\n\t"a": 1,\n\t"b": "test"\n}');
	});

	// Test for arrays
	it('formats arrays correctly', () => {
		const data = [1, 'test', { a: 2 }];
		const expected = '[\n\t1,\n\t"test",\n\t{\n\t\t"a": 2\n\t}\n]';
		expect(prettyStyleJSON(data)).toBe(expected);
	});

	// Test for nested objects
	it('formats nested objects correctly', () => {
		const data = { outer: { inner: 'value' } };
		const expected = '{\n\t"outer": {\n\t\t"inner": "value"\n\t}\n}';
		expect(prettyStyleJSON(data)).toBe(expected);
	});

	// Special cases handling
	it('handles special cases like .bounds path correctly', () => {
		const data = { bounds: [0, 0, 100, 100] };
		expect(prettyStyleJSON(data)).toBe('{\n\t"bounds": [ 0, 0, 100, 100 ]\n}');
	});
});
