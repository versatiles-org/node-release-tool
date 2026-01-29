import { spawn } from 'child_process';
import { debug, isVerbose } from './log.js';

/**
 * Result of a shell command execution.
 */
export interface ShellResult {
	/** Exit code of the process, or null if terminated by signal. */
	code: number | null;
	/** Signal that terminated the process, or null if exited normally. */
	signal: string | null;
	/** Captured standard output. */
	stdout: string;
	/** Captured standard error. */
	stderr: string;
}

/**
 * Result of an interactive shell command execution.
 */
export interface ShellInteractiveResult {
	/** Exit code of the process, or null if terminated by signal. */
	code: number | null;
	/** Signal that terminated the process, or null if exited normally. */
	signal: string | null;
}

/**
 * A utility class for executing shell commands in a specified working directory.
 * Provides methods for running commands with captured output, interactive commands,
 * and convenience methods for common patterns.
 *
 * @example
 * ```ts
 * const shell = new Shell('/path/to/project');
 * const output = await shell.stdout('git status');
 * const success = await shell.ok('npm test');
 * ```
 */
export class Shell {
	/** The working directory for all commands. */
	private cwd: string;

	/**
	 * Creates a new Shell instance.
	 *
	 * @param cwd - The working directory for executing commands.
	 */
	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/**
	 * Runs a shell command through bash and captures its output.
	 *
	 * **Security note:** This method passes the command string to `bash -c`.
	 * Only use with trusted, hardcoded command strings. Never pass unsanitized user input.
	 *
	 * @param command - The shell command to execute.
	 * @param errorOnCodeNonZero - If true (default), rejects the promise on non-zero exit code.
	 * @returns A promise resolving to the command result with exit code, signal, stdout, and stderr.
	 * @throws Rejects with the result object if errorOnCodeNonZero is true and exit code is non-zero.
	 */
	async run(command: string, errorOnCodeNonZero: boolean = true): Promise<ShellResult> {
		debug(`$ ${command}`);
		return this.exec('bash', ['-c', command], errorOnCodeNonZero, true);
	}

	/**
	 * Executes a command with arguments directly, avoiding shell escaping issues.
	 * Preferred over `run()` when dealing with arguments that may contain special characters.
	 *
	 * @param command - The command executable to run.
	 * @param args - Array of arguments to pass to the command.
	 * @param errorOnCodeNonZero - If true (default), rejects the promise on non-zero exit code.
	 * @param skipLog - If true, suppresses debug logging of the command.
	 * @returns A promise resolving to the command result with exit code, signal, stdout, and stderr.
	 * @throws Rejects with the result object if errorOnCodeNonZero is true and exit code is non-zero.
	 */
	async exec(
		command: string,
		args: string[],
		errorOnCodeNonZero: boolean = true,
		skipLog: boolean = false,
	): Promise<ShellResult> {
		if (!skipLog) {
			debug(`$ ${command} ${args.join(' ')}`);
		}
		return await new Promise((resolve, reject) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const cp = spawn(command, args, { cwd: this.cwd })
				.on('error', (error) => reject(error))
				.on('close', (code, signal) => {
					const result = {
						code,
						signal,
						stdout: Buffer.concat(stdout).toString(),
						stderr: Buffer.concat(stderr).toString(),
					};
					if (isVerbose()) {
						if (result.stdout) result.stdout.split('\n').forEach((line) => debug(`  stdout: ${line}`));
						if (result.stderr) result.stderr.split('\n').forEach((line) => debug(`  stderr: ${line}`));
						debug(`  exit code: ${code}`);
					}
					if (errorOnCodeNonZero && code !== 0) {
						reject(result);
					} else {
						resolve(result);
					}
				});

			cp.stdout.on('data', (chunk) => stdout.push(chunk));
			cp.stderr.on('data', (chunk) => stderr.push(chunk));
		});
	}

	/**
	 * Runs a command interactively with full TTY passthrough.
	 * The user can interact with the command's stdin/stdout/stderr directly.
	 * Useful for commands that require user input (e.g., npm publish with OTP).
	 *
	 * @param command - The shell command to execute.
	 * @param errorOnCodeNonZero - If true (default), rejects the promise on non-zero exit code.
	 * @returns A promise resolving to the exit code and signal (no captured output).
	 * @throws Rejects with the result object if errorOnCodeNonZero is true and exit code is non-zero.
	 */
	async runInteractive(command: string, errorOnCodeNonZero: boolean = true): Promise<ShellInteractiveResult> {
		return await new Promise((resolve, reject) => {
			const cp = spawn('bash', ['-c', command], {
				cwd: this.cwd,
				stdio: 'inherit', // give full TTY passthrough
			});

			cp.on('error', reject);

			cp.on('close', (code, signal) => {
				const result = { code, signal };
				if (errorOnCodeNonZero && code !== 0) {
					reject(result);
				} else {
					resolve(result);
				}
			});
		});
	}

	/**
	 * Runs a command and returns only the trimmed stderr output.
	 *
	 * @param command - The shell command to execute.
	 * @param errorOnCodeZero - If true (default), rejects on non-zero exit code.
	 * @returns A promise resolving to the trimmed stderr string.
	 */
	async stderr(command: string, errorOnCodeZero?: boolean): Promise<string> {
		const result = await this.run(command, errorOnCodeZero);
		return result.stderr.trim();
	}

	/**
	 * Runs a command and returns only the trimmed stdout output.
	 *
	 * @param command - The shell command to execute.
	 * @param errorOnCodeZero - If true (default), rejects on non-zero exit code.
	 * @returns A promise resolving to the trimmed stdout string.
	 */
	async stdout(command: string, errorOnCodeZero?: boolean): Promise<string> {
		const result = await this.run(command, errorOnCodeZero);
		return result.stdout.trim();
	}

	/**
	 * Runs a command and returns whether it succeeded (exit code 0).
	 * Never throws on non-zero exit codes.
	 *
	 * @param command - The shell command to execute.
	 * @returns A promise resolving to true if exit code is 0, false otherwise.
	 */
	async ok(command: string): Promise<boolean> {
		const result = await this.run(command, false);
		return result.code === 0;
	}
}
