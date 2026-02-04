/**
 * Options for retry behavior
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Initial delay in milliseconds before first retry (default: 1000) */
	initialDelayMs?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Maximum delay in milliseconds (default: 30000) */
	maxDelayMs?: number;
	/** Optional callback called before each retry */
	onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
	maxRetries: 3,
	initialDelayMs: 1000,
	backoffMultiplier: 2,
	maxDelayMs: 30000,
};

/**
 * Executes an async function with retry logic and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function if successful
 * @throws The last error encountered after all retries are exhausted
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const { maxRetries, initialDelayMs, backoffMultiplier, maxDelayMs } = { ...DEFAULT_OPTIONS, ...options };
	const { onRetry } = options;

	let lastError: Error | undefined;
	let currentDelay = initialDelayMs;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				const nextDelay = Math.min(currentDelay, maxDelayMs);

				if (onRetry) {
					onRetry(attempt + 1, lastError, nextDelay);
				}

				await sleep(nextDelay);
				currentDelay *= backoffMultiplier;
			}
		}
	}

	throw lastError;
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
