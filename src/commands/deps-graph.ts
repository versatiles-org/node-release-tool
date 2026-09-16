import { cruise, format } from 'dependency-cruiser';
import type { ICruiseResult, IModule } from 'dependency-cruiser';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import picomatch from 'picomatch';
import { CONFIG_FILENAME, readConfigSection } from '../lib/config.js';
import { extractGitHubRepoUrl } from '../lib/git.js';
import { panic, warn } from '../lib/log.js';
import { getReleaseBaseUrl, RELEASE_VERSION_ENV } from '../lib/release-link.js';
import { type GraphEdge, type GraphModel, renderSvgGraph } from './deps-graph-svg.js';

/**
 * Options for {@link generateDependencyGraph}.
 */
export interface DepsGraphOptions {
	/**
	 * Globs of files to exclude from the graph entirely (in addition to the
	 * built-in exclusions for tests, declarations, mocks and `node_modules`).
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

const INTERNAL_EXCLUDES = ['\\.(test|d|mock)\\.ts$', 'node_modules', '__mocks__/'];

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
 * @param cliOptions - Optional graph-shaping flags (collapse, exclude, subgraph direction, merge outgoing, svg)
 * @throws {VrtError} If dependency analysis fails
 */
export async function generateDependencyGraph(directory: string, cliOptions: DepsGraphOptions = {}): Promise<void> {
	const options = mergeOptions(readDepsGraphConfig(directory), cliOptions);
	const directionRules = (options.subgraphDirection ?? []).map(parseDirectionRule);
	const mergeRules = (options.mergeOutgoing ?? []).map(parseGlobRule);
	const userExcludes = (options.exclude ?? []).map(globToCruiseRegex);

	let cruiseResult: ICruiseResult;
	try {
		const result = await cruise([directory], {
			includeOnly: '^src',
			outputType: 'json',
			exclude: [...INTERNAL_EXCLUDES, ...userExcludes],
		});
		cruiseResult =
			typeof result.output === 'string'
				? (JSON.parse(result.output) as ICruiseResult)
				: (result.output as ICruiseResult);
	} catch (pError) {
		panic(String(pError));
		return;
	}

	const collapsers = (options.collapseDir ?? []).map((glob) => ({ glob, isMatch: picomatch(glob) }));
	if (collapsers.length > 0) {
		cruiseResult = collapseModules(cruiseResult, collapsers);
	}

	if (options.svg !== undefined) {
		if (directionRules.length > 0) warn('subgraph direction is not supported for SVG output and is ignored');
		const svg = await renderSvgGraph(buildGraphModel(cruiseResult, mergeRules));
		const svgPath = resolve(directory, options.svg);
		mkdirSync(dirname(svgPath), { recursive: true });
		writeFileSync(svgPath, svg);
		process.stdout.write(`![Dependency graph](${getImageUrl(directory, options.svg)})\n`);
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
 * only one edge are left untouched.
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

	const merged = new Set<string>();
	return edges.flatMap((edge) => {
		if (!isOutgoing(edge) || (counts.get(edge.to) ?? 0) < 2) return [edge];
		if (merged.has(edge.to)) return [];
		merged.add(edge.to);
		return [{ from: container, to: edge.to }];
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
 * Returns the URL for the image link to the SVG file: relative to `directory`,
 * or, while `release-npm` publishes (see {@link RELEASE_VERSION_ENV}), pointing
 * to the file at the git tag of the release, so that the published README
 * always shows the graph of its version.
 */
function getImageUrl(directory: string, svgPath: string): string {
	const relativePath = relative(resolve(directory), resolve(directory, svgPath)).split(sep).join('/');
	const version = process.env[RELEASE_VERSION_ENV];
	if (!version) return relativePath;

	let repository: unknown;
	try {
		repository = (JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { repository?: unknown })
			.repository;
	} catch {
		repository = undefined;
	}
	const repoUrl = extractGitHubRepoUrl(repository);
	if (!repoUrl) {
		warn('no GitHub repository URL in package.json, using a relative link for the dependency graph');
		return relativePath;
	}
	return getReleaseBaseUrl(repoUrl, version, directory) + relativePath;
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
