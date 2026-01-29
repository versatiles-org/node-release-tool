import { VrtError } from './errors.js';

/** Internal flag to track verbose mode state. */
let verboseMode = false;

/**
 * Enables or disables verbose logging mode.
 * When enabled, debug messages will be printed to stderr.
 *
 * @param enabled - Whether to enable verbose mode.
 */
export function setVerbose(enabled: boolean): void {
	verboseMode = enabled;
}

/**
 * Checks if verbose mode is currently enabled.
 *
 * @returns `true` if verbose mode is enabled, `false` otherwise.
 */
export function isVerbose(): boolean {
	return verboseMode;
}

/**
 * Logs a fatal error message and terminates the process.
 * The message is displayed in bold red text.
 *
 * @param text - The error message to display.
 * @returns Never returns as the process is terminated.
 */
export function panic(text: string): never {
	process.stderr.write(`\x1b[1;31m! ERROR: ${text}\x1b[0m\n`);
	abort();
}

/**
 * Logs a warning message to stderr.
 * The message is displayed in bold yellow text.
 *
 * @param text - The warning message to display.
 */
export function warn(text: string): void {
	process.stderr.write(`\x1b[1;33m! warning: ${text}\x1b[0m\n`);
}

/**
 * Logs an informational message to stderr.
 *
 * @param text - The informational message to display.
 */
export function info(text: string): void {
	process.stderr.write(`\x1b[0mi ${text}\n`);
}

/**
 * Logs a debug message to stderr if verbose mode is enabled.
 * The message is displayed in gray text.
 *
 * @param text - The debug message to display.
 */
export function debug(text: string): void {
	if (verboseMode) {
		process.stderr.write(`\x1b[0;90m  ${text}\x1b[0m\n`);
	}
}

/**
 * Logs an abort message and terminates the process with exit code 1.
 *
 * @returns Never returns as the process is terminated.
 */
export function abort(): never {
	info('abort');
	process.exit(1);
}

/**
 * Executes an async operation with progress indication.
 * Displays a spinner-like message while the operation is in progress,
 * then shows a success checkmark or failure X based on the result.
 *
 * @typeParam T - The return type of the promise.
 * @param message - The message to display while the operation is running.
 * @param promise - The promise to await, or a function that returns a promise.
 * @returns The resolved value of the promise.
 * @throws Calls `panic()` if the promise rejects, terminating the process.
 *
 * @example
 * ```ts
 * const result = await check('Fetching data', fetchData());
 * const result = await check('Processing', async () => processData());
 * ```
 */
export async function check<T>(message: string, promise: Promise<T> | (() => Promise<T>)): Promise<T> {
	process.stderr.write(`\x1b[0;90m\u2B95 ${message}\x1b[0m`);
	try {
		const result: T = await (typeof promise === 'function' ? promise() : promise);
		process.stderr.write(`\r\x1b[0;92m\u2714 ${message}\x1b[0m\n`);
		return result;
	} catch (error) {
		process.stderr.write(`\r\x1b[0;91m\u2718 ${message}\x1b[0m\n`);
		if (error instanceof VrtError) {
			panic(`[${error.code}] ${error.message}`);
		}
		panic((error as Error).message ?? String(error));
	}
}
