import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { gzipSync } from 'zlib';
import { debug, panic } from '../lib/log.js';
import { bytesPerSource, commonDirectoryPrefix, normalizeSource, SourceMap } from '../lib/sourcemap.js';
import { writeSvgImage } from '../lib/svg-image.js';
import { renderTreemapSvg, TreemapData, TreemapNode } from './treemap.js';

/**
 * Options for {@link generateBundleTreemap}.
 */
export interface BundleTreemapOptions {
	/** Path of the SVG file to write. Without it, the treemap is printed as JSON. */
	svg?: string;
	/** Path of the source map. Default: the one the bundle points to, or `<bundle>.map`. */
	map?: string;
	/** Width of the SVG in pixels. Default: 880. */
	width?: number;
	/** Height of the SVG in pixels. Default: 480. */
	height?: number;
	/** How many directory levels become groups. Default: 1. */
	depth?: number;
	/** Files smaller than this are folded into an "other" entry. Default: 0.5 % of the bundle. */
	minSize?: number;
	/** Title of the image. Default: "Bundle composition". */
	title?: string;
}

const DEFAULT_TITLE = 'Bundle composition';
const DEFAULT_DEPTH = 1;
/** Share of the bundle below which a box is folded into "other", if `minSize` is not given. */
const DEFAULT_MIN_SHARE = 0.005;

/** A source file of the bundle and the number of bytes it contributes. */
interface BundleFile {
	path: string;
	size: number;
}

/**
 * Measures the composition of a bundle and renders it as treemap.
 *
 * Every byte of the bundle is attributed to the source file it came from, by
 * walking the source map the build already emits. The files are grouped by
 * directory, small ones are folded into an "other" entry, and the result is
 * rendered like `vrt treemap`: as SVG file, followed by a Markdown image link
 * and a caption with the raw and gzipped size.
 *
 * Without `svg`, the treemap is printed as JSON instead, which can be piped
 * into `vrt treemap`, or edited before rendering.
 *
 * @param directory - The project directory
 * @param file - Path of the bundle, or of its source map, relative to the project directory
 * @param options - Source map, output file, grouping and size
 * @throws {VrtError} If the bundle or its source map can not be read
 */
export async function generateBundleTreemap(
	directory: string,
	file: string,
	options: BundleTreemapOptions,
): Promise<void> {
	const data = measureBundle(directory, file, options);
	if (!options.svg) {
		process.stdout.write(JSON.stringify(data, null, '\t') + '\n');
		return;
	}
	const svg = renderTreemapSvg(data, options.width ?? 880, options.height ?? 480);
	const image = await writeSvgImage(directory, options.svg, svg, data.title ?? DEFAULT_TITLE);
	process.stdout.write(image + '\n' + (data.caption ? `\n${data.caption}\n` : ''));
}

/**
 * Reads a bundle and its source map, and returns its composition as treemap
 * data, i.e. the input of `vrt treemap`.
 *
 * @param directory - The project directory
 * @param file - Path of the bundle, or of its source map, relative to the project directory
 * @param options - Source map, grouping and size
 * @throws {VrtError} If the bundle or its source map can not be read
 */
export function measureBundle(directory: string, file: string, options: BundleTreemapOptions = {}): TreemapData {
	const { codePath, mapPath } = locateBundle(directory, file, options.map);
	debug(`bundle-treemap: ${codePath} with ${mapPath.startsWith('data:') ? 'its inlined source map' : mapPath}`);

	const code = readFileSync(codePath, 'utf8');
	const map = readSourceMap(mapPath);
	const bytes = bytesPerSource(code, map);
	if (bytes.size === 0) panic(`bundle-treemap: ${mapPath} maps no code of ${codePath}`);

	const files = mergeByPath(
		[...bytes].map(([source, size]) => ({ path: normalizeSource(source, map.sourceRoot), size })),
	);
	const prefix = commonDirectoryPrefix(files.map((entry) => entry.path));
	for (const entry of files) entry.path = entry.path.slice(prefix.length);

	const total = Buffer.byteLength(code);
	const minSize = options.minSize ?? Math.round(total * DEFAULT_MIN_SHARE);
	const children = groupFiles(files, options.depth ?? DEFAULT_DEPTH, minSize);

	// whatever no mapping covers: line breaks, and what the bundler added itself
	const unmapped = total - files.reduce((sum, entry) => sum + entry.size, 0);
	if (unmapped > 0) children.push({ name: '(unmapped)', size: unmapped });

	const gzipped = gzipSync(Buffer.from(code), { level: 9 }).length;
	return {
		title: options.title ?? DEFAULT_TITLE,
		caption:
			`Sized by the bundle's own source map: **${kb(total)} KB** raw, **${kb(gzipped)} KB** gzipped, ` +
			`across ${files.length} modules.`,
		unit: 'bytes',
		children,
	};
}

/**
 * Groups the files into a tree of `depth` directory levels, where everything
 * below becomes a leaf named by its remaining path. Children smaller than
 * `minSize` are folded into one "other" entry per group, and a group holding a
 * single file becomes that file.
 */
export function groupFiles(files: BundleFile[], depth: number, minSize: number): TreemapNode[] {
	const build = (entries: BundleFile[], level: number): TreemapNode[] => {
		const nodes: TreemapNode[] = [];
		const groups = new Map<string, BundleFile[]>();

		for (const entry of entries) {
			const slash = entry.path.indexOf('/');
			if (level >= depth || slash < 0) {
				nodes.push({ name: entry.path, size: entry.size });
			} else {
				const name = entry.path.slice(0, slash);
				const rest = { path: entry.path.slice(slash + 1), size: entry.size };
				groups.set(name, (groups.get(name) ?? []).concat(rest));
			}
		}

		for (const [name, entries] of groups) {
			const children = build(entries, level + 1);
			// a group of one file is just that file, without a header box around it
			if (children.length === 1 && children[0].size !== undefined) {
				nodes.push({ name: `${name}/${children[0].name}`, size: children[0].size });
			} else {
				nodes.push({ name, children });
			}
		}

		return foldSmall(nodes, minSize);
	};
	return build(files, 0);
}

/**
 * Replaces the nodes smaller than `minSize` with a single "other" entry, so
 * that no box is too small for a label. Nothing is folded if only one node is
 * small, because an "other" of one file just renames it.
 */
function foldSmall(nodes: TreemapNode[], minSize: number): TreemapNode[] {
	const size = (node: TreemapNode): number =>
		node.children ? node.children.reduce((sum, child) => sum + size(child), 0) : (node.size ?? 0);
	const count = (node: TreemapNode): number =>
		node.children ? node.children.reduce((sum, child) => sum + count(child), 0) : 1;

	const small = nodes.filter((node) => size(node) < minSize);
	const kept = nodes.filter((node) => size(node) >= minSize).sort((a, b) => size(b) - size(a));
	if (small.length < 2) return [...kept, ...small];

	const files = small.reduce((sum, node) => sum + count(node), 0);
	kept.push({ name: `other (${files} files)`, size: small.reduce((sum, node) => sum + size(node), 0) });
	return kept;
}

/** Adds up the sizes of entries that share a path, e.g. after normalizing the source names. */
function mergeByPath(files: BundleFile[]): BundleFile[] {
	const sizes = new Map<string, number>();
	for (const { path, size } of files) sizes.set(path, (sizes.get(path) ?? 0) + size);
	return [...sizes].map(([path, size]) => ({ path, size }));
}

/**
 * Resolves the paths of the bundle and its source map. Either of them can be
 * given: the map is found next to the bundle, or through the
 * `sourceMappingURL` comment at its end; the bundle is the map's path without
 * the `.map` extension. A map inlined as `data:` URI is returned as that URI,
 * which {@link readSourceMap} reads like a path.
 *
 * @throws {VrtError} If one of the two files does not exist
 */
export function locateBundle(
	directory: string,
	file: string,
	mapOption?: string,
): { codePath: string; mapPath: string } {
	const path = resolve(directory, file);
	if (!existsSync(path)) panic(`bundle-treemap: ${path} does not exist`);

	if (path.endsWith('.map')) {
		const codePath = path.slice(0, -'.map'.length);
		if (!existsSync(codePath)) {
			panic(`bundle-treemap: ${codePath} does not exist - give the bundle instead of its source map`);
		}
		return { codePath, mapPath: path };
	}

	if (mapOption !== undefined) {
		const mapPath = resolve(directory, mapOption);
		if (!existsSync(mapPath)) panic(`bundle-treemap: ${mapPath} does not exist`);
		return { codePath: path, mapPath };
	}

	const url = sourceMappingUrl(readFileSync(path, 'utf8'));
	if (url !== undefined) {
		if (url.startsWith('data:')) return { codePath: path, mapPath: url };
		const mapPath = resolve(dirname(path), decodeURIComponent(url));
		if (existsSync(mapPath)) return { codePath: path, mapPath };
	}
	const mapPath = `${path}.map`;
	if (!existsSync(mapPath)) {
		panic(`bundle-treemap: no source map found for ${path} - build with source maps, or pass --map`);
	}
	return { codePath: path, mapPath };
}

/** The URL of the `sourceMappingURL` comment at the end of the code, if there is one. */
function sourceMappingUrl(code: string): string | undefined {
	const match = /[#@]\s*sourceMappingURL=(\S+)\s*$/.exec(code.trimEnd());
	return match?.[1];
}

/**
 * Reads and validates a source map, either from a file or from the `data:` URI
 * of a map that is inlined in its bundle.
 *
 * @throws {VrtError} If it can not be parsed or is not a source map with mappings
 */
export function readSourceMap(path: string): SourceMap {
	const inline = path.startsWith('data:');
	const name = inline ? 'the inlined source map' : path;

	let map: unknown;
	try {
		map = JSON.parse(inline ? decodeDataUrl(path) : readFileSync(path, 'utf8'));
	} catch (error) {
		panic(`bundle-treemap: could not parse ${name}: ${String(error)}`);
	}
	if (typeof map !== 'object' || map === null || Array.isArray(map)) {
		panic(`bundle-treemap: ${name} must contain an object`);
	}
	const { mappings, sources, sourceRoot } = map as Record<string, unknown>;
	if (typeof mappings !== 'string') panic(`bundle-treemap: ${name} has no "mappings"`);
	if (!Array.isArray(sources)) panic(`bundle-treemap: ${name} has no "sources"`);
	if (sourceRoot !== undefined && typeof sourceRoot !== 'string') {
		panic(`bundle-treemap: "sourceRoot" of ${name} must be a string`);
	}
	return { mappings, sources: sources as (string | null)[], sourceRoot };
}

/** The payload of a `data:` URI, e.g. the source map inlined at the end of a bundle. */
function decodeDataUrl(url: string): string {
	const comma = url.indexOf(',');
	if (comma < 0) panic('bundle-treemap: the inlined source map is not a data URI');
	const payload = url.slice(comma + 1);
	return url.slice(0, comma).includes(';base64')
		? Buffer.from(payload, 'base64').toString('utf8')
		: decodeURIComponent(payload);
}

function kb(bytes: number): number {
	return Math.round((bytes / 1024) * 10) / 10;
}
