import { cruise, format } from 'dependency-cruiser';
import type { ICruiseResult, IModule } from 'dependency-cruiser';
import picomatch from 'picomatch';
import { panic, warn } from '../lib/log.js';

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
}

const DIRECTIONS = ['TB', 'TD', 'BT', 'LR', 'RL'] as const;
type Direction = (typeof DIRECTIONS)[number];

interface DirectionRule {
	glob: string;
	isMatch: (s: string) => boolean;
	direction: Direction;
}

const INTERNAL_EXCLUDES = ['\\.(test|d|mock)\\.ts$', 'node_modules', '__mocks__/'];

/**
 * Generates a Mermaid dependency graph for the project's source files.
 *
 * Uses dependency-cruiser to analyze imports and outputs a Mermaid flowchart
 * diagram to stdout. The output is wrapped in markdown code blocks for
 * easy inclusion in documentation.
 *
 * @param directory - The project directory to analyze
 * @param options - Optional graph-shaping flags (collapse, exclude, subgraph direction)
 * @throws {VrtError} If dependency analysis fails
 */
export async function generateDependencyGraph(directory: string, options: DepsGraphOptions = {}): Promise<void> {
	const directionRules = (options.subgraphDirection ?? []).map(parseDirectionRule);
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

	const matches = Array.from(output.matchAll(/subgraph ([0-9a-z]+)/gi));
	const subgraphIds = matches.map(([_match, id]) => id);
	output += `\nclass ${subgraphIds.join(',')} subgraphs;`;
	output += `\nclassDef subgraphs fill-opacity:0.1, fill:#888, color:#888, stroke:#888;`;

	process.stdout.write(Buffer.from('```mermaid\n' + output + '\n```\n'));
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
	return { glob, isMatch: picomatch(glob), direction: direction as Direction };
}

/**
 * Inserts a `direction` statement into every subgraph of the mermaid output
 * whose directory path matches one of the rules. Subgraph paths are
 * reconstructed from the nesting of `subgraph …["label"]` / `end` lines.
 * Warns about rules that did not match any subgraph.
 */
function applySubgraphDirections(output: string, rules: DirectionRule[]): string {
	const stack: string[] = [];
	const used = new Set<DirectionRule>();
	const lines: string[] = [];

	for (const line of output.split('\n')) {
		lines.push(line);
		const subgraph = /^\s*subgraph\s+\S+?\["(.*)"\]\s*$/.exec(line);
		if (subgraph) {
			stack.push(subgraph[1]);
			const path = stack.join('/');
			const rule = rules.findLast((r) => r.isMatch(path));
			if (rule) {
				used.add(rule);
				lines.push(`direction ${rule.direction}`);
			}
		} else if (/^\s*end\s*$/.test(line)) {
			stack.pop();
		}
	}

	for (const rule of rules) {
		if (!used.has(rule)) warn(`subgraph direction glob "${rule.glob}" did not match any directory`);
	}

	return lines.join('\n');
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
