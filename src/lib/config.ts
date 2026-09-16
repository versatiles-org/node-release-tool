import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { panic } from './log.js';

/**
 * Name of the vrt configuration file in the project directory.
 */
export const CONFIG_FILENAME = 'vrt.config.json';

/**
 * Reads the section of a command from the `vrt.config.json` in `directory`.
 * The file contains one section per command, keyed by the command name, e.g.:
 *
 * ```json
 * { "deps-graph": { "merge-outgoing": ["src/*"] } }
 * ```
 *
 * @param directory - The project directory containing `vrt.config.json`
 * @param command - The command name, used as the section key
 * @returns The section, or `undefined` if the file or the section does not exist
 * @throws {VrtError} If the file can not be parsed, or the file or the section is not an object
 */
export function readConfigSection(directory: string, command: string): Record<string, unknown> | undefined {
	const path = resolve(directory, CONFIG_FILENAME);
	if (!existsSync(path)) return undefined;

	let config: unknown;
	try {
		config = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		panic(`could not parse ${CONFIG_FILENAME}: ${String(error)}`);
	}
	if (!isObject(config)) panic(`${CONFIG_FILENAME} must contain an object`);

	const section = config[command];
	if (section === undefined) return undefined;
	if (!isObject(section)) panic(`${CONFIG_FILENAME}: "${command}" must be an object`);
	return section;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
