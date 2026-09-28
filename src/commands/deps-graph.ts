import type { ICruiseResult, IModule } from 'dependency-cruiser';
import type ExtractTSConfigFunction from 'dependency-cruiser/config-utl/extract-ts-config';
import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { delimiter, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
import { CONFIG_FILENAME, readConfigSection } from '../lib/config.js';
import { debug, isVerbose, panic, warn } from '../lib/log.js';
import { writeSvgImage } from '../lib/svg-image.js';
import { type GraphEdge, type GraphModel, renderSvgGraph } from './deps-graph-svg.js';
import { mapBuildOutputToSource, readWorkspacePackages } from './deps-graph-workspace.js';

/**
 * Options for {@link generateDependencyGraph}.
 */
export interface DepsGraphOptions {
	/**
	 * Globs of the directories (or files) to analyze, relative to the project
	 * directory, e.g. a glob like `packages/<any>/src` covering all packages at the root of
	 * an npm workspace. Only files inside matching directories become part of
	 * the graph. Defaults to `src`.
	 */
	include?: string[];
	/**
	 * Globs of files to exclude from the graph entirely (in addition to the
	 * built-in exclusions for tests, specs, mocks, declarations and `node_modules`).
	 * Edges touching excluded files are dropped.
	 */
	exclude?: string[];
	/**
	 * Globs whose matching files are merged into a single node per glob,
	 * labelled with the glob and the count of collapsed files. Edges into
	 * and out of collapsed files become edges to/from the merged node,
	 * with self-loops removed and duplicates deduplicated.
	 */
	collapseDir?: string[];
	/**
	 * Flow direction overrides for directory subgraphs, each in the form
	 * `glob=direction` (e.g. `src/lib=LR`). The glob is matched against the
	 * directory path of each subgraph; direction is one of `TB`, `TD`, `BT`,
	 * `LR` or `RL`. If several globs match, the last one wins.
	 */
	subgraphDirection?: string[];
	/**
	 * Globs matched against the directory path of each subgraph. For matching
	 * directories, outgoing edges from files (or subdirectories) inside the
	 * directory that point to the same target outside of it are merged into a
	 * single edge from the directory. Nested matching directories are merged
	 * innermost first.
	 */
	mergeOutgoing?: string[];
	/**
	 * Path of an SVG file. If set, the graph is laid out with ELK and written to
	 * this file, and a Markdown image link to it is printed instead of Mermaid
	 * markup. The link is relative, except while `release-npm` publishes a
	 * package: then it points to the file at the release's git tag.
	 */
	svg?: string;
}

/**
 * Maps the list keys of the `deps-graph` section in `vrt.config.json`, which
 * mirror the CLI flags, to the corresponding {@link DepsGraphOptions} properties.
 */
const LIST_CONFIG_KEYS = {
	'collapse-dir': 'collapseDir',
	exclude: 'exclude',
	include: 'include',
	'merge-outgoing': 'mergeOutgoing',
	'subgraph-direction': 'subgraphDirection',
} as const satisfies Record<string, Exclude<keyof DepsGraphOptions, 'svg'>>;

const DIRECTIONS = ['TB', 'TD', 'BT', 'LR', 'RL'] as const;
type Direction = (typeof DIRECTIONS)[number];

interface GlobRule {
	glob: string;
	isMatch: (s: string) => boolean;
}

interface DirectionRule extends GlobRule {
	direction: Direction;
}

interface MermaidSubgraph {
	id: string;
	/** Directory path, reconstructed from the labels of the enclosing subgraphs. */
	path: string;
	/** Index of the `subgraph` line. */
	line: number;
}

interface MermaidStructure {
	/** Subgraphs in the order they are closed, i.e. inner before outer. */
	subgraphs: MermaidSubgraph[];
	/** Maps each node and subgraph id to the id of its enclosing subgraph. */
	parents: Map<string, string>;
}

type ExtractTSConfig = typeof ExtractTSConfigFunction;

/** Files that are never part of the graph: tests, mocks, type declarations and dependencies. */
const INTERNAL_EXCLUDES = [
	'\\.(test|spec|mock)\\.[cm]?[jt]sx?$',
	'\\.d\\.[cm]?ts$',
	'(^|/)__(tests|mocks)__/',
	'node_modules',
];

/** Scope of the graph if no `include` globs are given. */
const DEFAULT_INCLUDE = 'src';

/**
 * Imports that are not expected to be part of the graph, although they do not
 * resolve to a file in it: modules provided by SvelteKit and Vite.
 */
const IGNORED_IMPORTS = /^(\$app\/|\$env\/|\$service-worker$|virtual:)|(^|\/)\$types(\.js)?$/;

/** Bare module names, like `svelte` or `@scope/pkg/sub`, as opposed to relative paths or aliases like `$lib`. */
const BARE_MODULE = /^(@[\w.-]+\/)?[\w][\w.-]*(\/|$)/;

/** Source files, as opposed to assets like images or stylesheets. */
const SOURCE_FILE = /\.([cm]?[jt]sx?|svelte|vue)$/;

/** Maximum number of files that dependency-cruiser fails to analyze, before giving up. */
const MAX_UNPARSABLE_FILES = 10;

/** Key of the global holding the Svelte compiler options, see {@link SVELTE_COMPILER_WRAPPER}. */
const SVELTE_OPTIONS_KEY = 'vrt.deps-graph.svelteCompilerOptions';

/** Maximum number of dropped import targets listed without verbose mode. */
const MAX_DROPPED_WARNINGS = 10;

/**
 * An import of a file in the graph, whose target is not in the graph.
 */
interface DroppedImport {
	from: string;
	module: string;
	resolved: string;
	couldNotResolve: boolean;
}

/**
 * Resolver options for dependency-cruiser. Resolving through the `exports`
 * field of package.json lets imports between the packages of an npm workspace
 * (e.g. `"exports": { "./*": "./src/*.ts" }`) point to their source files
 * instead of staying unresolved.
 */
const ENHANCED_RESOLVE_OPTIONS = {
	exportsFields: ['exports'],
	conditionNames: ['import', 'default'],
};

/**
 * Reads the `tsconfig.json` in `directory`, so that dependency-cruiser resolves
 * the aliases in its `paths`. Returns `undefined` if there is no such file or
 * it can not be read.
 *
 * `paths` inherited via `extends` from a config in another directory are not
 * resolved by dependency-cruiser, which is why SvelteKit aliases are handled
 * by {@link readSvelteKitAliases} instead.
 */
function readTsConfig(
	directory: string,
	extractTSConfig: ExtractTSConfig,
): { fileName: string; parsed: ReturnType<ExtractTSConfig> } | undefined {
	const fileName = resolve(directory, 'tsconfig.json');
	if (!existsSync(fileName)) return undefined;
	try {
		return { fileName, parsed: extractTSConfig(fileName) };
	} catch (error) {
		warn(`could not read ${fileName}, path aliases are not resolved: ${String(error)}`);
		return undefined;
	}
}

/**
 * Returns the import aliases of a SvelteKit project, like `$lib`, mapped to
 * absolute paths. dependency-cruiser can not resolve them on its own, so
 * imports using them would be dropped from the graph.
 *
 * The aliases are read from the `paths` of `.svelte-kit/tsconfig.json`, which
 * SvelteKit generates and which includes custom aliases from `svelte.config.js`.
 * If that file is missing in a project depending on `@sveltejs/kit`, only
 * `$lib` is mapped to `src/lib`. Returns an empty object for other projects.
 */
export function readSvelteKitAliases(directory: string): Record<string, string> {
	const tsconfigDirectory = resolve(directory, '.svelte-kit');
	const tsconfig = resolve(tsconfigDirectory, 'tsconfig.json');
	if (existsSync(tsconfig)) {
		try {
			const { compilerOptions } = JSON.parse(readFileSync(tsconfig, 'utf8')) as {
				compilerOptions?: { paths?: Record<string, string[]> };
			};
			const alias: Record<string, string> = {};
			for (const [key, targets] of Object.entries(compilerOptions?.paths ?? {})) {
				// `$lib` and `$lib/*` both become the prefix alias `$lib`
				const name = key.replace(/\/\*$/, '');
				const target = targets[0]?.replace(/\/\*$/, '');
				if (name.includes('*') || !target || target.includes('*')) continue;
				alias[name] = resolve(tsconfigDirectory, target);
			}
			return alias;
		} catch (error) {
			warn(`could not read aliases from ${tsconfig}: ${String(error)}`);
		}
	}

	return dependsOnSvelteKit(directory) ? { $lib: resolve(directory, 'src/lib') } : {};
}

/**
 * Whether the `package.json` in `directory` lists `@sveltejs/kit` as dependency.
 */
function dependsOnSvelteKit(directory: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
		return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) =>
			Object.hasOwn((pkg[field] as object | undefined) ?? {}, '@sveltejs/kit'),
		);
	} catch {
		return false;
	}
}

/**
 * Generates a dependency graph for the project's source files.
 *
 * Uses dependency-cruiser to analyze imports and outputs a Mermaid flowchart
 * diagram to stdout. The output is wrapped in markdown code blocks for
 * easy inclusion in documentation. With the `svg` option, the graph is written
 * as SVG file instead and a Markdown image link to it is printed.
 *
 * Graph-shaping options are read from the `deps-graph` section of the
 * project's `vrt.config.json` (see {@link readDepsGraphConfig}) and extended
 * by the given options.
 *
 * @param directory - The project directory to analyze
 * @param cliOptions - Optional graph-shaping flags (include, collapse, exclude, subgraph direction, merge outgoing, svg)
 * @throws {VrtError} If dependency analysis fails
 */
export async function generateDependencyGraph(directory: string, cliOptions: DepsGraphOptions = {}): Promise<void> {
	const options = mergeOptions(readDepsGraphConfig(directory), cliOptions);
	const directionRules = (options.subgraphDirection ?? []).map(parseDirectionRule);
	const mergeRules = (options.mergeOutgoing ?? []).map(parseGlobRule);
	const userExcludes = (options.exclude ?? []).map(globToCruiseRegex);
	const includeGlobs = (options.include?.length ? options.include : [DEFAULT_INCLUDE]).map(normalizeInclude);
	const includes = includeGlobs.map(includeToCruiseRegex);

	const { cruise, format, extractTSConfig } = await loadDependencyCruiser(directory);
	const tsConfig = readTsConfig(directory, extractTSConfig);

	setSvelteCompilerOptions(await readSvelteCompilerOptions(directory));

	let cruiseResult = await cruiseWithRetries(async (unparsable) => {
		const result = await cruise(
			startPaths(directory, includeGlobs),
			{
				baseDir: directory,
				// Files outside of `include` become leaves, so imports of them can be reported
				doNotFollow: {
					path: [
						`^(?!${includes.map((include) => include.slice(1)).join('|')})`,
						...unparsable.map((file) => `^${escapeRegex(file)}$`),
					].join('|'),
				},
				outputType: 'json',
				exclude: [...INTERNAL_EXCLUDES, ...userExcludes],
				enhancedResolveOptions: ENHANCED_RESOLVE_OPTIONS,
				...(tsConfig && { tsConfig: { fileName: tsConfig.fileName } }),
			},
			// Passed as resolver options, because `enhancedResolveOptions` does not accept aliases
			{ alias: readSvelteKitAliases(directory) },
			tsConfig && { tsConfig: tsConfig.parsed },
		);
		return typeof result.output === 'string'
			? (JSON.parse(result.output) as ICruiseResult)
			: (result.output as ICruiseResult);
	});

	cruiseResult = mergeDuplicateModules(cruiseResult);
	cruiseResult = mapBuildOutputToSource(cruiseResult, readWorkspacePackages(directory, extractTSConfig), directory);
	const split = splitIncluded(cruiseResult, includes);
	cruiseResult = split.result;
	warnDroppedImports(split.dropped);

	const collapsers = (options.collapseDir ?? []).map((glob) => ({ glob, isMatch: picomatch(glob) }));
	if (collapsers.length > 0) {
		cruiseResult = collapseModules(cruiseResult, collapsers);
	}

	if (options.svg !== undefined) {
		if (directionRules.length > 0) warn('subgraph direction is not supported for SVG output and is ignored');
		const svg = await renderSvgGraph(buildGraphModel(cruiseResult, mergeRules));
		process.stdout.write((await writeSvgImage(directory, options.svg, svg, 'Dependency graph')) + '\n');
		return;
	}

	const formatted = await format(cruiseResult, { outputType: 'mermaid' });
	let output = formatted.output;
	if (typeof output !== 'string') {
		panic('no output');
		return;
	}

	output = output.replace('flowchart LR', '---\nconfig:\n  layout: elk\n---\nflowchart TB');
	if (directionRules.length > 0) {
		output = applySubgraphDirections(output, directionRules);
	}
	if (mergeRules.length > 0) {
		output = mergeOutgoingEdges(output, mergeRules);
	}

	const matches = Array.from(output.matchAll(/subgraph ([0-9a-z]+)/gi));
	const subgraphIds = matches.map(([_match, id]) => id);
	output += `\nclass ${subgraphIds.join(',')} subgraphs;`;
	output += `\nclassDef subgraphs fill-opacity:0.1, fill:#888, color:#888, stroke:#888;`;

	process.stdout.write(Buffer.from('```mermaid\n' + output + '\n```\n'));
}

/**
 * Module that replaces `svelte/compiler` for dependency-cruiser, which calls
 * `compile` without the project's compiler options. `REAL_URL` is replaced
 * with the quoted URL of the real module. The options are read at call time from a
 * global, see {@link setSvelteCompilerOptions}.
 */
const SVELTE_COMPILER_WRAPPER = `
import * as svelte from REAL_URL;
export * from REAL_URL;
export function compile(source, options) {
	return svelte.compile(source, { ...globalThis[Symbol.for('${SVELTE_OPTIONS_KEY}')], ...options });
}`;

/**
 * ESM resolve hook for {@link loadDependencyCruiser}: if a bare specifier can
 * not be resolved from the importing module, it is resolved from the project
 * directory instead. When dependency-cruiser imports `svelte/compiler`, it
 * gets {@link SVELTE_COMPILER_WRAPPER} instead.
 */
const FALLBACK_RESOLVE_HOOK = `
let parentURL;
const wrapper = ${JSON.stringify(SVELTE_COMPILER_WRAPPER)};
export function initialize(data) { parentURL = data.parentURL; }
export async function resolve(specifier, context, next) {
	// Node may change the context in the calls of next(), so it is read first
	const wrapCompiler = specifier === 'svelte/compiler' && context.parentURL?.includes('/dependency-cruiser/');
	let result;
	try {
		result = await next(specifier, context);
	} catch (error) {
		if (error?.code !== 'ERR_MODULE_NOT_FOUND' || /^[./]|^[a-z]+:/i.test(specifier)) throw error;
		result = await next(specifier, { ...context, parentURL });
	}
	if (wrapCompiler) {
		const code = wrapper.replaceAll('REAL_URL', JSON.stringify(result.url));
		return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
	}
	return result;
}`;

/**
 * Reads the `compilerOptions` from `svelte.config.js` (or `.mjs`) in
 * `directory`, e.g. `{ experimental: { async: true } }`, without which some
 * components can not be compiled. Returns an empty object if there is no such
 * file or it can not be loaded.
 */
export async function readSvelteCompilerOptions(directory: string): Promise<Record<string, unknown>> {
	const file = ['svelte.config.js', 'svelte.config.mjs']
		.map((name) => resolve(directory, name))
		.find((path) => existsSync(path));
	if (!file) return {};
	try {
		const module = (await import(pathToFileURL(file).href)) as { default?: { compilerOptions?: unknown } };
		const options = module.default?.compilerOptions;
		return typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {};
	} catch (error) {
		warn(`could not load ${file}, Svelte compiler options are not used: ${String(error)}`);
		return {};
	}
}

/**
 * Sets the options that {@link SVELTE_COMPILER_WRAPPER} passes to the Svelte compiler.
 */
function setSvelteCompilerOptions(options: Record<string, unknown>): void {
	(globalThis as Record<symbol, unknown>)[Symbol.for(SVELTE_OPTIONS_KEY)] = options;
}

/**
 * Calls `runCruise` until dependency-cruiser analyzes all files. If it fails
 * to analyze a file, e.g. because the file can not be compiled, it warns and
 * calls `runCruise` again with all files that failed so far, which are to be
 * added as leaves. Files that failed and are not imported by others are added
 * to the result as modules without dependencies.
 *
 * @throws {VrtError} If the same file fails again, after {@link MAX_UNPARSABLE_FILES} files, or on other errors
 */
async function cruiseWithRetries(runCruise: (unparsable: string[]) => Promise<ICruiseResult>): Promise<ICruiseResult> {
	const unparsable: string[] = [];
	for (;;) {
		let result: ICruiseResult;
		try {
			result = await runCruise(unparsable);
		} catch (error) {
			const failed = parseCruiseError(error);
			if (!failed || unparsable.includes(failed.file) || unparsable.length >= MAX_UNPARSABLE_FILES) {
				panic(String(error));
			}
			warn(`could not analyze ${failed.file}, its imports are missing in the graph: ${failed.reason}`);
			unparsable.push(failed.file);
			continue;
		}
		for (const source of unparsable) {
			if (result.modules.some((module) => module.source === source)) continue;
			result.modules.push({ source, dependencies: [], dependents: [], valid: true });
		}
		return result;
	}
}

/**
 * Merges modules that dependency-cruiser lists twice. It caches which file
 * extensions it follows on the first resolved import, so if that is an import
 * like `./x.js` that resolves to `./x.ts`, only `.ts`, `.tsx` and `.d.ts` are
 * followed. Imports of other files, e.g. `.svelte`, are added as leaves, and if
 * such a file is analyzed later, because it is one of the start paths, it is
 * listed again. The analyzed module is kept, with the dependents of both.
 */
export function mergeDuplicateModules(result: ICruiseResult): ICruiseResult {
	const bySource = new Map<string, IModule>();
	for (const module of result.modules) {
		const existing = bySource.get(module.source);
		if (!existing) {
			bySource.set(module.source, module);
			continue;
		}
		// leaves have `followable: false`, analyzed modules have no `followable`
		const kept = existing.followable === false ? module : existing;
		const dependents = [...new Set([...(existing.dependents ?? []), ...(module.dependents ?? [])])];
		bySource.set(module.source, { ...kept, dependents });
	}
	return { ...result, modules: Array.from(bySource.values()) };
}

/**
 * Extracts the file and the reason from an error that dependency-cruiser
 * throws when it fails to analyze a file, like
 * `Extracting dependencies ran afoul of...\n\n  reason\n... in file`.
 */
function parseCruiseError(error: unknown): { file: string; reason: string } | undefined {
	const match = /ran afoul of\.\.\.\s+(.*)[\s\S]*\n\.\.\. in (.+)/.exec(String(error));
	return match ? { reason: match[1].trim(), file: match[2].trim() } : undefined;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Imports dependency-cruiser so that it can use the compilers installed in the
 * analyzed project.
 *
 * On import, dependency-cruiser checks which compilers (`svelte/compiler`,
 * `typescript`, `vue-template-compiler`, …) are available with `require` and
 * loads some of them with `import`, both relative to its own location. If vrt
 * is not installed next to them, e.g. when run via `npx`, files like `.svelte`
 * are silently skipped or parsed incorrectly. Therefore the project's
 * `node_modules` are added as fallback for both: to the global module paths
 * (`NODE_PATH`) for `require` and via a resolve hook for `import`.
 */
async function loadDependencyCruiser(
	directory: string,
): Promise<typeof import('dependency-cruiser') & { extractTSConfig: ExtractTSConfig }> {
	const nodeModules = resolve(directory, 'node_modules');
	const paths = (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean);
	if (!paths.includes(nodeModules)) {
		process.env.NODE_PATH = [...paths, nodeModules].join(delimiter);
		(Module as unknown as { _initPaths: () => void })._initPaths();
		// `module.register` is available since Node 20.6
		Module.register?.('data:text/javascript,' + encodeURIComponent(FALLBACK_RESOLVE_HOOK), {
			data: { parentURL: pathToFileURL(resolve(directory, 'package.json')).href },
		});
	}
	const { default: extractTSConfig } = await import('dependency-cruiser/config-utl/extract-ts-config');
	return { ...(await import('dependency-cruiser')), extractTSConfig };
}

/**
 * Reads graph-shaping options from the `deps-graph` section of the
 * `vrt.config.json` in `directory`. Keys are the CLI flag names, values are
 * arrays of strings, except for `svg`, which is a string, e.g.:
 *
 * ```json
 * { "deps-graph": { "merge-outgoing": ["src/*"], "svg": "docs/dependency-graph.svg" } }
 * ```
 *
 * Returns empty options if there is no `vrt.config.json` or no such section.
 *
 * @throws {VrtError} If `vrt.config.json` can not be parsed or the section is invalid
 */
export function readDepsGraphConfig(directory: string): DepsGraphOptions {
	const section = readConfigSection(directory, 'deps-graph');
	if (!section) return {};

	const options: DepsGraphOptions = {};
	for (const [key, value] of Object.entries(section)) {
		if (key === 'svg') {
			if (typeof value !== 'string' || !value) panic(`${CONFIG_FILENAME}: "deps-graph.svg" must be a file path`);
			options.svg = value;
			continue;
		}
		if (!Object.hasOwn(LIST_CONFIG_KEYS, key)) {
			const keys = [...Object.keys(LIST_CONFIG_KEYS), 'svg'].join(', ');
			panic(`${CONFIG_FILENAME}: unknown key "deps-graph.${key}", expected one of: ${keys}`);
		}
		if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
			panic(`${CONFIG_FILENAME}: "deps-graph.${key}" must be an array of strings`);
		}
		options[LIST_CONFIG_KEYS[key as keyof typeof LIST_CONFIG_KEYS]] = value;
	}
	return options;
}

/**
 * Concatenates the option lists of `config` and `overrides`. Values from
 * `overrides` come last, so they win where the last match counts. A `svg`
 * path in `overrides` replaces the one from `config`.
 */
function mergeOptions(config: DepsGraphOptions, overrides: DepsGraphOptions): DepsGraphOptions {
	const merged: DepsGraphOptions = { svg: overrides.svg ?? config.svg };
	for (const key of Object.values(LIST_CONFIG_KEYS)) {
		merged[key] = [...(config[key] ?? []), ...(overrides[key] ?? [])];
	}
	return merged;
}

/**
 * Converts a user-facing glob into a regex string that dependency-cruiser's
 * `exclude` option understands. The path separators in cruise paths are
 * forward slashes regardless of platform.
 */
function globToCruiseRegex(glob: string): string {
	const re = picomatch.makeRe(glob, { dot: true });
	return re.source;
}

/**
 * Removes a leading `./` and trailing slashes from an `include` glob.
 */
function normalizeInclude(value: string): string {
	const glob = value.replace(/^\.\/+/, '').replace(/\/+$/, '');
	if (!glob) panic(`invalid include glob "${value}"`);
	return glob;
}

/**
 * Returns the `include` globs as start paths for dependency-cruiser, which
 * expands globs itself. Paths without glob characters that do not exist in
 * `directory` are skipped with a warning.
 */
function startPaths(directory: string, globs: string[]): string[] {
	return globs.filter((glob) => {
		if (picomatch.scan(glob).isGlob || existsSync(resolve(directory, glob))) return true;
		warn(`include path "${glob}" does not exist`);
		return false;
	});
}

/**
 * Converts a normalized `include` glob into a regex string that matches the
 * paths themselves and everything inside of them, so both directory and file
 * globs work. Supports `*`, `**` and `?`. The regex is kept simple, because
 * dependency-cruiser refuses patterns that might run slowly, like the ones
 * generated by picomatch.
 */
function includeToCruiseRegex(glob: string): string {
	const pattern = glob
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.map((part) => {
			switch (part) {
				case '**/':
					return '(?:.*/)?';
				case '**':
					return '.*';
				case '*':
					return '[^/]*';
				case '?':
					return '[^/]';
				default:
					return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			}
		})
		.join('');
	return `^${pattern}(?:/|$)`;
}

/**
 * Removes all modules outside of `include` from the cruise result, and all
 * imports of them. Returns the removed imports of the remaining modules.
 */
function splitIncluded(result: ICruiseResult, includes: string[]): { result: ICruiseResult; dropped: DroppedImport[] } {
	const patterns = includes.map((include) => new RegExp(include));
	const isIncluded = (path: string): boolean => patterns.some((pattern) => pattern.test(path));

	const dropped: DroppedImport[] = [];
	const modules = result.modules
		.filter((module) => isIncluded(module.source))
		.map((module) => ({
			...module,
			dependencies: module.dependencies.filter((dependency) => {
				if (isIncluded(dependency.resolved)) return true;
				if (!dependency.coreModule) {
					const { module: name, resolved, couldNotResolve } = dependency;
					dropped.push({ from: module.source, module: name, resolved, couldNotResolve });
				}
				return false;
			}),
		}));
	return { result: { ...result, modules }, dropped };
}

/**
 * Warns about imports that are missing in the graph: imports of local files
 * that could not be resolved, and imports that resolve to files outside of
 * `include`, e.g. to the build output of another workspace package. Unresolved
 * npm packages, assets outside of `include` and modules provided by frameworks
 * ({@link IGNORED_IMPORTS}) are ignored. The importing files are listed in verbose mode.
 */
function warnDroppedImports(dropped: DroppedImport[]): void {
	const byTarget = new Map<string, DroppedImport[]>();
	for (const entry of dropped) {
		if (IGNORED_IMPORTS.test(entry.module)) continue;
		if (entry.couldNotResolve ? BARE_MODULE.test(entry.module) : !SOURCE_FILE.test(entry.resolved)) continue;
		const key = entry.couldNotResolve ? entry.module : entry.resolved;
		byTarget.set(key, [...(byTarget.get(key) ?? []), entry]);
	}
	if (byTarget.size === 0) return;

	const groups = [...byTarget.values()].sort((a, b) => b.length - a.length);
	const shown = isVerbose() ? groups : groups.slice(0, MAX_DROPPED_WARNINGS);
	const count = (n: number): string => (n === 1 ? '1 import' : `${n} imports`);
	for (const group of shown) {
		const [{ module, resolved, couldNotResolve }] = group;
		const reason = couldNotResolve ? 'could not be resolved' : `resolves to ${resolved}, outside of "include"`;
		warn(`missing in graph: ${count(group.length)} of "${module}", which ${reason}`);
		for (const { from } of group) debug(`imported by ${from}`);
	}
	if (shown.length < groups.length) {
		warn(`missing in graph: imports of ${groups.length - shown.length} more targets, run with -v to see all`);
	}
}

/**
 * Creates a {@link GlobRule} for matching directory paths. Trailing slashes
 * are removed, so `src/lib/` and `src/lib` are equivalent.
 */
function parseGlobRule(value: string): GlobRule {
	const glob = value.replace(/\/+$/, '');
	if (!glob) panic(`invalid directory glob "${value}"`);
	return { glob, isMatch: picomatch(glob) };
}

/**
 * Parses a `glob=direction` string into a {@link DirectionRule}.
 * Splits at the last `=`, so globs may contain `=` themselves.
 */
function parseDirectionRule(value: string): DirectionRule {
	const index = value.lastIndexOf('=');
	const glob = value.slice(0, index).replace(/\/+$/, '');
	const direction = value.slice(index + 1).toUpperCase();
	if (index <= 0 || !glob || !(DIRECTIONS as readonly string[]).includes(direction)) {
		panic(`invalid subgraph direction "${value}", expected "glob=${DIRECTIONS.join('|')}"`);
	}
	return { ...parseGlobRule(glob), direction: direction as Direction };
}

/**
 * Reconstructs the directory structure of the mermaid output from the nesting
 * of `subgraph ID["label"]`, `ID["label"]` and `end` lines.
 */
function parseMermaidStructure(lines: string[]): MermaidStructure {
	const stack: MermaidSubgraph[] = [];
	const subgraphs: MermaidSubgraph[] = [];
	const parents = new Map<string, string>();

	lines.forEach((line, index) => {
		const subgraph = /^\s*subgraph\s+(\S+?)\["(.*)"\]\s*$/.exec(line);
		const node = /^\s*(\S+?)\[".*"\]\s*$/.exec(line);
		const parent = stack.at(-1);
		if (subgraph) {
			const [, id, label] = subgraph;
			if (parent) parents.set(id, parent.id);
			stack.push({ id, path: parent ? `${parent.path}/${label}` : label, line: index });
		} else if (/^\s*end\s*$/.test(line)) {
			const closed = stack.pop();
			if (closed) subgraphs.push(closed);
		} else if (node && parent) {
			parents.set(node[1], parent.id);
		}
	});

	return { subgraphs, parents };
}

/**
 * Warns about rules that did not match any subgraph.
 */
function warnUnusedRules(rules: GlobRule[], used: Set<GlobRule>, name: string): void {
	for (const rule of rules) {
		if (!used.has(rule)) warn(`${name} glob "${rule.glob}" did not match any directory`);
	}
}

/**
 * Inserts a `direction` statement into every subgraph of the mermaid output
 * whose directory path matches one of the rules. If several rules match, the
 * last one wins.
 */
function applySubgraphDirections(output: string, rules: DirectionRule[]): string {
	const lines = output.split('\n');
	const directions = new Map<number, Direction>();
	const used = new Set<GlobRule>();

	for (const subgraph of parseMermaidStructure(lines).subgraphs) {
		const rule = rules.findLast((r) => r.isMatch(subgraph.path));
		if (!rule) continue;
		used.add(rule);
		directions.set(subgraph.line, rule.direction);
	}

	warnUnusedRules(rules, used, 'subgraph direction');

	return lines
		.flatMap((line, index) => {
			const direction = directions.get(index);
			return direction ? [line, `direction ${direction}`] : [line];
		})
		.join('\n');
}

/**
 * For every subgraph whose directory path matches one of the rules, merges
 * edges that start inside the directory and point to the same target outside
 * of it into a single edge starting at the subgraph. Targets reached by only
 * one edge are left untouched. Subgraphs are processed inner before outer, so
 * edges already merged into a subdirectory can be merged again by a matching
 * parent directory.
 */
function mergeOutgoingEdges(output: string, rules: GlobRule[]): string {
	const lines = output.split('\n');
	const { subgraphs, parents } = parseMermaidStructure(lines);

	const isInside = (id: string, ancestor: string): boolean => {
		for (let parent = parents.get(id); parent; parent = parents.get(parent)) {
			if (parent === ancestor) return true;
		}
		return false;
	};

	const edgeLines = new Set<number>();
	let edges: GraphEdge[] = [];
	lines.forEach((line, index) => {
		const edge = /^\s*(\w+)-->(\w+)\s*$/.exec(line);
		if (!edge) return;
		edgeLines.add(index);
		edges.push({ from: edge[1], to: edge[2] });
	});
	if (edges.length === 0) return output;

	const used = new Set<GlobRule>();
	for (const subgraph of subgraphs) {
		const matching = rules.filter((r) => r.isMatch(subgraph.path));
		if (matching.length === 0) continue;
		matching.forEach((r) => used.add(r));
		edges = mergeEdgesFrom(edges, subgraph.id, isInside);
	}

	warnUnusedRules(rules, used, 'merge outgoing');

	// Replace the original edge lines with the merged edges, placed where the first edge was.
	const firstEdgeLine = Math.min(...edgeLines);
	return lines
		.flatMap((line, index) => {
			if (index === firstEdgeLine) return edges.map((e) => `${e.from}-->${e.to}`);
			return edgeLines.has(index) ? [] : [line];
		})
		.join('\n');
}

/**
 * Merges edges that start inside `container` and point to the same target
 * outside of it into a single edge starting at `container`. Targets reached by
 * only one edge are left untouched. A merged edge lists the sources it replaces
 * in `via`, including the sources of edges that were merged before.
 *
 * @param isInside - Whether a node or container id lies (indirectly) inside another container
 */
function mergeEdgesFrom(
	edges: GraphEdge[],
	container: string,
	isInside: (id: string, ancestor: string) => boolean,
): GraphEdge[] {
	const isOutgoing = (edge: GraphEdge): boolean => isInside(edge.from, container) && !isInside(edge.to, container);

	const counts = new Map<string, number>();
	for (const edge of edges) {
		if (isOutgoing(edge)) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
	}

	const merged = new Map<string, GraphEdge & { via: string[] }>();
	return edges.flatMap((edge) => {
		if (!isOutgoing(edge) || (counts.get(edge.to) ?? 0) < 2) return [edge];
		const sources = [...(edge.via ?? []), edge.from];
		const existing = merged.get(edge.to);
		if (existing) {
			existing.via.push(...sources.filter((source) => !existing.via.includes(source)));
			return [];
		}
		const mergedEdge = { from: container, to: edge.to, via: sources };
		merged.set(edge.to, mergedEdge);
		return [mergedEdge];
	});
}

/**
 * Converts the cruise result into files and edges for SVG rendering, merging
 * outgoing edges of directories that match `mergeRules` (inner before outer
 * directories, like {@link mergeOutgoingEdges}).
 */
function buildGraphModel(result: ICruiseResult, mergeRules: GlobRule[]): GraphModel {
	const files = result.modules.map((m) => m.source);
	let edges: GraphEdge[] = result.modules.flatMap((m) =>
		m.dependencies.map((d) => ({ from: m.source, to: d.resolved })),
	);

	const directories = new Set<string>();
	for (const file of files) {
		const segments = file.split('/');
		for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'));
	}
	const depth = (path: string): number => path.split('/').length;
	const innerFirst = [...directories].sort((a, b) => depth(b) - depth(a));
	const isInside = (path: string, ancestor: string): boolean => path.startsWith(ancestor + '/');

	const used = new Set<GlobRule>();
	for (const directory of innerFirst) {
		const matching = mergeRules.filter((r) => r.isMatch(directory));
		if (matching.length === 0) continue;
		matching.forEach((r) => used.add(r));
		edges = mergeEdgesFrom(edges, directory, isInside);
	}
	warnUnusedRules(mergeRules, used, 'merge outgoing');

	return { files, edges };
}

/**
 * Returns a new {@link ICruiseResult} where modules whose `source` matches one
 * of the provided collapsers is replaced by a single synthetic module per
 * glob. Dependencies into/out of collapsed files are rewritten and deduped;
 * self-loops are removed.
 */
function collapseModules(
	result: ICruiseResult,
	collapsers: { glob: string; isMatch: (s: string) => boolean }[],
): ICruiseResult {
	const sourceToGlob = new Map<string, string>();
	const counts = new Map<string, number>();

	for (const module of result.modules) {
		const hit = collapsers.find((c) => c.isMatch(module.source));
		if (!hit) continue;
		sourceToGlob.set(module.source, hit.glob);
		counts.set(hit.glob, (counts.get(hit.glob) ?? 0) + 1);
	}

	// Final display source for a collapsed glob: append "(N files)" to the last
	// path segment so the mermaid reporter renders it as the node label while
	// keeping parent segments as subgraphs.
	const collapsedSource = (glob: string): string => {
		const segments = glob.split('/');
		segments[segments.length - 1] = `${segments[segments.length - 1]} (${counts.get(glob)} files)`;
		return segments.join('/');
	};

	const rewrite = (originalSource: string): string => {
		const glob = sourceToGlob.get(originalSource);
		return glob ? collapsedSource(glob) : originalSource;
	};

	const merged = new Map<string, IModule>();
	for (const module of result.modules) {
		const newSource = rewrite(module.source);
		const existing = merged.get(newSource);
		const target = existing ?? { ...module, source: newSource, dependencies: [] };
		if (!existing) merged.set(newSource, target);

		const seen = new Set(target.dependencies.map((d) => d.resolved));
		for (const dep of module.dependencies) {
			const resolved = rewrite(dep.resolved);
			if (resolved === newSource) continue; // drop self-loops
			if (seen.has(resolved)) continue; // dedupe (within and across collapsed sources)
			seen.add(resolved);
			target.dependencies.push({ ...dep, resolved });
		}
	}

	return { ...result, modules: Array.from(merged.values()) };
}
