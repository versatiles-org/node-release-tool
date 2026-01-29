/**
 * Extracts a human-readable error message from an unknown error value.
 * Safely handles various error formats including Error objects, objects with message properties,
 * and other unknown values.
 *
 * @param error - The error value to extract a message from. Can be any type.
 * @returns The extracted error message string, or 'unknown' if no message could be extracted.
 *
 * @example
 * ```ts
 * getErrorMessage(new Error('Something went wrong')); // 'Something went wrong'
 * getErrorMessage({ message: 'Custom error' }); // 'Custom error'
 * getErrorMessage(null); // 'unknown'
 * ```
 */
export function getErrorMessage(error: unknown): string {
	if (error == null) return 'unknown';
	if (typeof error === 'object') {
		if ('message' in error) {
			if (typeof error.message === 'string') return error.message;
			return JSON.stringify(error.message);
		}
	}
	return 'unknown';
}

/**
 * Formats JSON data with custom styling rules for map-style configurations.
 * Applies special formatting for certain paths (like bounds, layers, filters, paint, layout)
 * to keep them on a single line while expanding other nested structures.
 *
 * @param inputData - The data to format as styled JSON.
 * @returns A formatted JSON string with custom indentation and line breaks.
 *
 * @example
 * ```ts
 * prettyStyleJSON({ name: 'test', bounds: [0, 0, 1, 1] });
 * // Returns formatted JSON with bounds on a single line
 * ```
 */
export function prettyStyleJSON(inputData: unknown): string {
	return recursive(inputData);

	function recursive(data: unknown, prefix = '', path = ''): string {
		if (path.endsWith('.bounds')) return singleLine(data);

		//if (path.includes('.vector_layers[].')) return singleLine(data);
		if (path.startsWith('.layers[].filter')) return singleLine(data);
		if (path.startsWith('.layers[].paint.')) return singleLine(data);
		if (path.startsWith('.layers[].layout.')) return singleLine(data);

		if (typeof data === 'object') {
			if (Array.isArray(data)) {
				return (
					'[\n\t' +
					prefix +
					data.map((value: unknown) => recursive(value, prefix + '\t', path + '[]')).join(',\n\t' + prefix) +
					'\n' +
					prefix +
					']'
				);
			}
			if (data) {
				return (
					'{\n\t' +
					prefix +
					Object.entries(data)
						.map(([key, value]) => '"' + key + '": ' + recursive(value, prefix + '\t', path + '.' + key))
						.join(',\n\t' + prefix) +
					'\n' +
					prefix +
					'}'
				);
			}
		}

		return singleLine(data);
	}

	function singleLine(data: unknown): string {
		return JSON.stringify(data, null, '\t').replace(/[\t\n]+/g, ' ');
	}
}
