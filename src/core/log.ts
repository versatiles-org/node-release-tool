import { formatError } from './errors.js';

/** Internal flag to track verbose mode state. */
let verboseMode = false;

/** Message of the running {@link check}, whose line is still open, or undefined if none runs. */
let pendingCheck: string | undefined;

/** Clears the current terminal line and moves the cursor to its start. */
const CLEAR_LINE = '\r\x1b[K';

/**
 * Formats the open line of a running {@link check}, without a line break.
 */
function pendingLine(message: string): string {
	return `\x1b[0;90m\u2B95 ${message}\x1b[0m`;
}

/**
 * Writes a complete line to stderr. While a {@link check} runs, its open line is cleared first and
 * printed again below the text, so that messages logged during a check do not end up in its line.
 */
function writeLine(text: string): void {
	if (pendingCheck === undefined) {
		process.stderr.write(text);
	} else {
		process.stderr.write(CLEAR_LINE + text + pendingLine(pendingCheck));
	}
}

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
	printError(text);
	abort();
}

/**
 * Logs an error message to stderr without terminating the process.
 * The message is displayed in bold red text.
 *
 * @param text - The error message to display.
 */
export function printError(text: string): void {
	writeLine(`\x1b[1;31m! ERROR: ${text}\x1b[0m\n`);
}

/**
 * Logs a warning message to stderr.
 * The message is displayed in bold yellow text.
 *
 * @param text - The warning message to display.
 */
export function warn(text: string): void {
	writeLine(`\x1b[1;33m! warning: ${text}\x1b[0m\n`);
}

/**
 * Logs an informational message to stderr.
 *
 * @param text - The informational message to display.
 */
export function info(text: string): void {
	writeLine(`\x1b[0mi ${text}\n`);
}

/**
 * Logs a finished step to stderr.
 * The message is displayed in green text with a checkmark, like a successful {@link check}.
 *
 * @param text - The message to display.
 */
export function success(text: string): void {
	writeLine(`\x1b[0;92m✔ ${text}\x1b[0m\n`);
}

/**
 * Logs Markdown, such as release notes, to stderr, formatted for the terminal and framed by a box,
 * so that it stands out from the other messages.
 *
 * @param text - The Markdown to display.
 * @param title - Optional title, shown in the top border of the box.
 */
export function markdown(text: string, title?: string): void {
	writeLine(formatBox(formatMarkdown(text), title) + '\n');
}

/** Matches ANSI escape codes for colors and styles. */
// eslint-disable-next-line no-control-regex
const ANSI_CODE = /\x1b\[[0-9;]*m/g;

/** Returns the number of characters that a text takes up in the terminal, without ANSI codes. */
function visibleWidth(text: string): number {
	return [...text.replace(ANSI_CODE, '')].length;
}

/**
 * Frames text with a box of gray lines. If the text is wider than the terminal, the box is left
 * open on the right, because the terminal would break the lines and with them the right border.
 *
 * @param text - The text to frame; it may contain ANSI codes.
 * @param title - Optional title, shown in bold in the top border.
 * @param columns - The width of the terminal, or undefined if unknown.
 * @returns The framed text, without a trailing line break.
 */
export function formatBox(text: string, title?: string, columns: number | undefined = process.stderr.columns): string {
	const gray = (border: string): string => `\x1b[90m${border}\x1b[39m`;
	const lines = text.split('\n');
	const head = title === undefined ? '' : ` \x1b[1m${title}\x1b[22m `;
	const headWidth = visibleWidth(head);
	let width = Math.max(headWidth + 1, ...lines.map(visibleWidth));
	const closed = columns === undefined || width + 4 <= columns;
	if (!closed) width = Math.max(headWidth + 1, columns - 4);

	const top = gray('╭─') + head + gray('─'.repeat(width + 1 - headWidth) + (closed ? '╮' : ''));
	const body = lines.map((line) =>
		closed ? `${gray('│')} ${line}${' '.repeat(width - visibleWidth(line))} ${gray('│')}` : `${gray('│')} ${line}`,
	);
	const bottom = gray('╰' + '─'.repeat(width + 2) + (closed ? '╯' : ''));
	return [top, ...body, bottom].join('\n');
}

/**
 * Formats the Markdown that changelogs use for the terminal: headings in bold, list items with a
 * bullet, `**bold**` and `` `code` `` highlighted, and links shown by their text only.
 *
 * @param text - The Markdown to format.
 * @returns The text with ANSI escape codes.
 */
export function formatMarkdown(text: string): string {
	const inline = (line: string): string =>
		line
			.replace(/ ?\(\[([^\]]+)\]\([^)]+\)\)/g, ' \x1b[90m($1)\x1b[39m')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '\x1b[4m$1\x1b[24m')
			.replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[22m')
			.replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[39m');
	return text
		.split('\n')
		.map((line) => {
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				const content = heading[2].replace(/^\[([^\]]+)\]/, '$1');
				const color = heading[1].length <= 2 ? '\x1b[1;96m' : '\x1b[1;93m';
				return `${color}${content}\x1b[0m`;
			}
			const item = /^(\s*)[-*]\s+(.*)$/.exec(line);
			if (item) return `${item[1]}  • ${inline(item[2])}`;
			return inline(line);
		})
		.join('\n');
}

/**
 * Logs a debug message to stderr if verbose mode is enabled.
 * The message is displayed in gray text.
 *
 * @param text - The debug message to display.
 */
export function debug(text: string): void {
	if (verboseMode) {
		writeLine(`\x1b[0;90m  ${text}\x1b[0m\n`);
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
 * @param onError - Optional cleanup callback, invoked after the error has been reported
 *   and before the process is terminated. Use it to undo partial changes.
 * @returns The resolved value of the promise.
 * @throws Terminates the process if the promise rejects.
 *
 * @example
 * ```ts
 * const result = await check('Fetching data', fetchData());
 * const result = await check('Processing', async () => processData());
 * const result = await check('Installing', install(), async () => restoreBackup());
 * ```
 */
export async function check<T>(
	message: string,
	promise: Promise<T> | (() => Promise<T>),
	onError?: (error: unknown) => Promise<void> | void,
): Promise<T> {
	// a check started within another one replaces the open line until it is done
	const outerCheck = pendingCheck;
	process.stderr.write((outerCheck === undefined ? '' : CLEAR_LINE) + pendingLine(message));
	pendingCheck = message;

	const finish = (line: string): void => {
		pendingCheck = outerCheck;
		process.stderr.write(CLEAR_LINE + line + '\n' + (outerCheck === undefined ? '' : pendingLine(outerCheck)));
	};

	try {
		const result: T = await (typeof promise === 'function' ? promise() : promise);
		finish(`\x1b[0;92m\u2714 ${message}\x1b[0m`);
		return result;
	} catch (error) {
		finish(`\x1b[0;91m\u2718 ${message}\x1b[0m`);
		printError(formatError(error));
		if (onError) await onError(error);
		abort();
	}
}
