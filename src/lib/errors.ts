/**
 * Error codes for categorizing different types of errors in the release tool.
 */
export type VrtErrorCode =
	'VALIDATION_ERROR' | 'MARKDOWN_ERROR' | 'GIT_ERROR' | 'RELEASE_ERROR' | 'NOT_IMPLEMENTED' | 'SHELL_ERROR';

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

/** Details about a failed shell command. */
export interface ShellErrorDetails {
	/** The command that was executed. */
	command: string;
	/** Exit code of the process, or null if terminated by signal. */
	exitCode: number | null;
	/** Signal that terminated the process, or null if exited normally. */
	signal: string | null;
	/** Captured standard output, if any. */
	stdout?: string;
	/** Captured standard error, if any. */
	stderr?: string;
	/** The underlying error, e.g. when the process could not be spawned at all. */
	cause?: unknown;
}

/** Maximum number of output lines included in a shell error message. */
const MAX_OUTPUT_LINES = 20;

/**
 * Error thrown when a shell command fails.
 * Carries the command, exit code, signal and captured output so that failures
 * can be reported with a helpful message instead of an opaque object.
 */
export class ShellError extends VrtError {
	/** The command that was executed. */
	public readonly command: string;
	/** Exit code of the process, or null if terminated by signal. */
	public readonly exitCode: number | null;
	/** Signal that terminated the process, or null if exited normally. */
	public readonly signal: string | null;
	/** Captured standard output. */
	public readonly stdout: string;
	/** Captured standard error. */
	public readonly stderr: string;

	constructor(details: ShellErrorDetails) {
		super(buildShellErrorMessage(details), 'SHELL_ERROR');
		this.name = 'ShellError';
		this.command = details.command;
		this.exitCode = details.exitCode;
		this.signal = details.signal;
		this.stdout = details.stdout ?? '';
		this.stderr = details.stderr ?? '';
		if (details.cause !== undefined) this.cause = details.cause;
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ShellError);
		}
	}
}

/**
 * Builds a human readable message for a failed shell command,
 * including the exit reason and the tail of the captured output.
 */
function buildShellErrorMessage(details: ShellErrorDetails): string {
	const { command, exitCode, signal, cause } = details;

	let reason: string;
	if (cause !== undefined) {
		reason = 'could not be executed';
	} else if (signal !== null) {
		reason = `was terminated by signal ${signal}`;
	} else {
		reason = `failed with exit code ${exitCode ?? 'unknown'}`;
	}

	const lines = [`Command ${reason}: ${command}`];
	if (cause !== undefined) lines.push(formatError(cause));
	const output = tail(details.stderr) || tail(details.stdout);
	if (output) lines.push(output);
	return lines.join('\n');
}

/**
 * Returns the last {@link MAX_OUTPUT_LINES} non-empty lines of the given output, trimmed.
 */
function tail(output?: string): string {
	const lines = (output ?? '').split('\n').filter((line) => line.trim() !== '');
	if (lines.length === 0) return '';
	const truncated = lines.length > MAX_OUTPUT_LINES;
	return (truncated ? ['…', ...lines.slice(-MAX_OUTPUT_LINES)] : lines).join('\n');
}

/**
 * Converts any thrown value into a readable message.
 * Prevents unhelpful output like `[object Object]` when a non-Error value is thrown.
 *
 * @param error - The thrown value.
 * @returns A human readable description of the error.
 */
export function formatError(error: unknown): string {
	if (error instanceof VrtError) return `[${error.code}] ${error.message}`;
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === 'string') return error;
	if (error === null || error === undefined) return String(error);

	if (typeof error === 'object') {
		// Some libraries reject with plain objects, e.g. { code, stdout, stderr }.
		const { message } = error as { message?: unknown };
		if (typeof message === 'string' && message !== '') return message;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}

	return String(error);
}
