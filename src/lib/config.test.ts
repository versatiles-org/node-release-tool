import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./log.js', () => ({
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));

const { readConfigSection } = await import('./config.js');

describe('readConfigSection', () => {
	let directory: string;

	function writeConfig(content: unknown): void {
		writeFileSync(
			join(directory, 'vrt.config.json'),
			typeof content === 'string' ? content : JSON.stringify(content),
		);
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-config-'));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it('returns the section of the command', () => {
		writeConfig({ 'deps-graph': { exclude: ['a'] }, other: { b: 1 } });
		expect(readConfigSection(directory, 'deps-graph')).toEqual({ exclude: ['a'] });
	});

	it('returns undefined without config file or section', () => {
		expect(readConfigSection(directory, 'deps-graph')).toBeUndefined();
		writeConfig({ other: {} });
		expect(readConfigSection(directory, 'deps-graph')).toBeUndefined();
	});

	it.each([
		['{ invalid', 'could not parse vrt.config.json'],
		[['deps-graph'], 'vrt.config.json must contain an object'],
		[{ 'deps-graph': ['src'] }, 'vrt.config.json: "deps-graph" must be an object'],
	])('panics on invalid config %j', (content, message) => {
		writeConfig(content);
		expect(() => readConfigSection(directory, 'deps-graph')).toThrow(message);
	});
});
