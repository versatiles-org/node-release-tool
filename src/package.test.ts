import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url).pathname;
const distDirectory = join(root, 'dist');

const pack = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const dependencies = Object.keys(pack.dependencies ?? {});
const devDependencies = Object.keys(pack.devDependencies ?? {});

const builtins = new Set(builtinModules);

/** Returns all JavaScript files below the given directory. */
function jsFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true })
		.map(String)
		.filter((name) => name.endsWith('.js'))
		.map((name) => join(directory, name));
}

/** Reduces an import specifier to the package it belongs to, e.g. "remark/lib" to "remark". */
function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Import forms that reference a module by name. The leading lookbehind keeps method calls such as
 * `Buffer.from('...')` from being mistaken for an `import ... from '...'`.
 */
const IMPORT_PATTERNS = [
	/(?<![\w$.])from\s*['"]([^'"]+)['"]/g, // import ... from '...' and export ... from '...'
	/(?<![\w$.])import\s*\(\s*['"]([^'"]+)['"]/g, // import('...')
	/(?<![\w$.])import\s+['"]([^'"]+)['"]/g, // import '...'
	/(?<![\w$.])require\s*\(\s*['"]([^'"]+)['"]/g, // require('...')
];

/** Returns the packages imported by the given JavaScript source, ignoring relative paths. */
function importedPackages(code: string): string[] {
	return IMPORT_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]))
		.filter((specifier) => !specifier.startsWith('.'))
		.filter((specifier) => !specifier.startsWith('node:') && !builtins.has(specifier))
		.map(packageOf);
}

describe('declared dependencies', () => {
	beforeAll(() => {
		// The built output is the only reliable source: type-only imports are erased there, while
		// they are indistinguishable from real ones in the sources. "@schemastore/package" for
		// example is imported with value syntax but never reaches the runtime.
		if (!existsSync(join(distDirectory, 'index.js'))) {
			execSync('npm run build:node', { cwd: root, stdio: 'ignore' });
		}
	}, 120_000);

	/** All packages the built output imports at runtime. */
	function runtimeImports(): string[] {
		const found = new Set<string>();
		for (const file of jsFiles(distDirectory)) {
			for (const name of importedPackages(readFileSync(file, 'utf8'))) found.add(name);
		}
		return [...found].sort();
	}

	it('lists every package imported by the built output', () => {
		const imported = runtimeImports();

		// guards against the scan silently finding nothing, which would make the test pass for free
		expect(imported.length).toBeGreaterThan(5);
		expect(imported.filter((name) => !dependencies.includes(name))).toStrictEqual([]);
	});

	it('keeps packages that are only needed for development out of the runtime', () => {
		// a devDependency imported by the built output is missing from a published install
		expect(runtimeImports().filter((name) => devDependencies.includes(name))).toStrictEqual([]);
	});

	it('lists the TypeDoc plugins that are loaded by name', () => {
		// These are passed to TypeDoc as strings, so nothing imports them and no tooling reports
		// them as used. Removing them, or moving them to devDependencies, breaks "doc-typescript"
		// in a published install only.
		const source = readFileSync(join(root, 'src/commands/doc-typescript.ts'), 'utf8');
		const plugins = [...new Set([...source.matchAll(/'(typedoc-[^']+)'/g)].map((match) => match[1]))].sort();

		expect(plugins).toStrictEqual(['typedoc-github-theme', 'typedoc-github-wiki-theme', 'typedoc-plugin-markdown']);
		expect(plugins.filter((name) => !dependencies.includes(name))).toStrictEqual([]);
	});
});
