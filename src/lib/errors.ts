/**
 * Error codes for categorizing different types of errors in the release tool.
 */
export type VrtErrorCode = 'VALIDATION_ERROR' | 'MARKDOWN_ERROR' | 'GIT_ERROR' | 'RELEASE_ERROR' | 'NOT_IMPLEMENTED';

/**
 * Custom error class for the VersaTiles Release Tool.
 * Provides consistent error handling with categorization via error codes.
 */
export class VrtError extends Error {
	public readonly code: VrtErrorCode;

	constructor(message: string, code: VrtErrorCode = 'VALIDATION_ERROR') {
		super(message);
		this.name = 'VrtError';
		this.code = code;
		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, VrtError);
		}
	}
}

/**
 * Helper function to create a validation error.
 */
export function validationError(message: string): VrtError {
	return new VrtError(message, 'VALIDATION_ERROR');
}

/**
 * Helper function to create a markdown processing error.
 */
export function markdownError(message: string): VrtError {
	return new VrtError(message, 'MARKDOWN_ERROR');
}

/**
 * Helper function to create a git operation error.
 */
export function gitError(message: string): VrtError {
	return new VrtError(message, 'GIT_ERROR');
}

/**
 * Helper function to create a release process error.
 */
export function releaseError(message: string): VrtError {
	return new VrtError(message, 'RELEASE_ERROR');
}

/**
 * Helper function to create a not implemented error.
 */
export function notImplementedError(feature: string): VrtError {
	return new VrtError(`Not implemented yet: "${feature}"`, 'NOT_IMPLEMENTED');
}
