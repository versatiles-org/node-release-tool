import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk.bundled.js';
import { escapeXml, FONT_FAMILY, textWidth as measureText, num } from '../lib/svg-text.js';

/**
 * A dependency edge. `from` is a file path or, for merged edges, a directory path.
 */
export interface GraphEdge {
	from: string;
	to: string;
	/** For merged edges: the files and directories whose edges were merged into this one. */
	via?: string[];
}

/**
 * The files and edges of a dependency graph. Directories are derived from the file paths.
 */
export interface GraphModel {
	files: string[];
	edges: GraphEdge[];
}

const FONT_SIZE = 12;
const NODE_HEIGHT = 24;
const NODE_PADDING = 8;
const DIRECTORY_LABEL_HEIGHT = 22;
const DIRECTORY_PADDING = 10;
/** Opacity of a directory's fill, so nested directories get darker (or lighter in dark mode) with each level. */
const DIRECTORY_OPACITY = 0.05;

/**
 * ELK options that are applied to the root and to every directory, because ELK
 * reads most layered options per nested graph.
 */
const LAYOUT_OPTIONS: Record<string, string> = {
	'elk.algorithm': 'layered',
	'elk.direction': 'DOWN',
	'elk.edgeRouting': 'ORTHOGONAL',
	'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
	'elk.spacing.nodeNode': '16',
	'elk.layered.spacing.nodeNodeBetweenLayers': '28',
	// the same spacing for horizontal and vertical edge segments
	'elk.spacing.edgeEdge': '8',
	'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
};

/**
 * Options for file nodes: every edge gets its own port, incoming on top and
 * outgoing at the bottom, packed around the center. Without explicit ports ELK
 * spreads edges over the whole node width, so the spacing between edges would
 * differ from node to node.
 */
const FILE_PORT_OPTIONS: Record<string, string> = {
	'elk.portConstraints': 'FIXED_SIDE',
	'elk.portAlignment.default': 'CENTER',
};

const STYLE = `
	.background { fill: #ffffff; }
	.directory { stroke: #c5ccc9; stroke-width: 1; fill-opacity: ${DIRECTORY_OPACITY}; }
	.directory, .shade { fill: #000000; }
	.label-background { fill: #ffffff; }
	.file { fill: #ffffff; stroke: #9aa6a1; stroke-width: 1; }
	text { font-family: ${FONT_FAMILY}; font-size: ${FONT_SIZE}px; }
	.label { fill: #1b2220; text-anchor: middle; }
	.directory-label { fill: #66736d; font-weight: 600; }
	.edge { fill: none; stroke: #5f6b66; stroke-width: 1; stroke-opacity: 0.7; }
	.arrowhead { fill: #5f6b66; }
	svg { --outgoing: #d9480f; --incoming: #1971c2; }
	.background, .edge { pointer-events: none; }
	.node { cursor: default; }
	.node:hover .file { stroke-width: 2; }
	.arrowhead-dim { fill: #5f6b66; fill-opacity: 0.15; }
	.arrowhead-outgoing { fill: var(--outgoing); }
	.arrowhead-incoming { fill: var(--incoming); }
	@media (prefers-color-scheme: dark) {
		svg { --outgoing: #ff922b; --incoming: #4dabf7; }
		.arrowhead-dim { fill: #8b949e; }
		.background { fill: #0d1117; }
		.directory { stroke: #39424d; }
		.directory, .shade { fill: #ffffff; }
		.label-background { fill: #0d1117; }
		.file { fill: #0d1117; stroke: #5c6773; }
		.label { fill: #e6edf3; }
		.directory-label { fill: #8b949e; }
		.edge { stroke: #8b949e; }
		.arrowhead { fill: #8b949e; }
	}
`;

/**
 * Lays out a dependency graph with ELK and renders it as a standalone SVG.
 *
 * Files are drawn as boxes nested in boxes for their directories, edges are
 * routed orthogonally from top to bottom with evenly spaced ports. Directory
 * labels are drawn on top of edges, on a background in the directory's color.
 * Directories are filled with a translucent color, so they get darker (or
 * lighter in dark mode) with each nesting level. Colors follow the viewer's color
 * scheme via `prefers-color-scheme`. The output is deterministic, so it only
 * changes when the graph changes.
 *
 * When the SVG is opened directly (not as `<img>`), hovering a file highlights
 * its outgoing and incoming edges and the connected files, and dims all other
 * edges. Hovering a directory box or label does the same for all edges that
 * cross the directory's border, and keeps the edges inside the directory
 * visible. This is pure CSS, see {@link hoverStyle}.
 *
 * @param model - Files and edges; edge sources may be directory paths
 * @returns The SVG document
 */
export async function renderSvgGraph(model: GraphModel): Promise<string> {
	const directories = getDirectories(model.files);
	const roots = directories.filter((d) => !d.includes('/'));
	const topFiles = model.files.filter((f) => !f.includes('/'));

	const ports = new Map<string, ElkPort[]>();
	const addPort = (node: string, side: 'NORTH' | 'SOUTH', id: string): string => {
		const list = ports.get(node) ?? [];
		if (list.length === 0) ports.set(node, list);
		list.push({ id, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } });
		return id;
	};
	const edges = model.edges.map((edge, index): ElkExtendedEdge => ({
		id: `edge${index}`,
		sources: [addPort(edge.from, 'SOUTH', `${edge.from}#out${index}`)],
		targets: [addPort(edge.to, 'NORTH', `${edge.to}#in${index}`)],
	}));
	const context: BuildContext = { directories, files: model.files, ports };
	const ids = new Map([...model.files, ...directories].map((path, index) => [path, `n${index}`]));
	const idOf = (path: string): string => ids.get(path) ?? '';
	const files = new Set(model.files);

	const graph: ElkNode = {
		id: '#root',
		layoutOptions: {
			...LAYOUT_OPTIONS,
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
			'elk.json.edgeCoords': 'ROOT',
			'elk.json.shapeCoords': 'ROOT',
		},
		children: [
			...roots.map((d) => buildDirectoryNode(d, context)),
			...topFiles.map((f) => buildFileNode(f, context)),
		],
		edges,
	};

	// elkjs is CommonJS with an ES-style default export in its typings, so TypeScript
	// only accepts `.default`, which elkjs also provides at runtime.
	const layout = await new ELK.default().layout(graph);

	const shapes: string[] = [];
	const directoryLabels: string[] = [];
	const drawNode = (node: ElkNode, depth: number): void => {
		const { x = 0, y = 0, width = 0, height = 0 } = node;
		if (node.children) {
			shapes.push(
				`<rect class="directory node ${idOf(node.id)}" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="6"/>`,
			);
			// Labels are drawn on top of edges, so their background is opaque, shaded like
			// the stacked translucent fills of this and all enclosing directories.
			const label = basename(node.id);
			const box = `x="${num(x + DIRECTORY_PADDING - 3)}" y="${num(y + 4)}" width="${num(textWidth(label, true) + 6)}" height="16" rx="2"`;
			const shade = Math.round((1 - (1 - DIRECTORY_OPACITY) ** depth) * 1e4) / 1e4;
			directoryLabels.push(
				`<g class="node ${idOf(node.id)}">`,
				`<rect class="label-background" ${box}/>`,
				`<rect class="shade" ${box} fill-opacity="${shade}"/>`,
				text('directory-label', x + DIRECTORY_PADDING, y + 16, label, true),
				'</g>',
			);
			node.children.forEach((child) => drawNode(child, depth + 1));
		} else {
			shapes.push(
				`<g class="node ${idOf(node.id)}">`,
				`<rect class="file" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4"/>`,
				text('label', x + width / 2, y + height / 2 + 4, basename(node.id)),
				'</g>',
			);
		}
	};
	layout.children?.forEach((child) => drawNode(child, 1));

	(layout.edges ?? []).forEach((edge, index) => {
		const modelEdge = model.edges[index];
		const classes = [
			'edge',
			...fileSources(modelEdge, files).map((source) => `from-${idOf(source)}`),
			`to-${idOf(modelEdge.to)}`,
			...directoryRelations(modelEdge, directories).map(
				({ directory, relation }) => `${relation}-${idOf(directory)}`,
			),
		];
		for (const section of edge.sections ?? []) {
			const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
			const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${num(p.x)},${num(p.y)}`).join(' ');
			shapes.push(`<path class="${classes.join(' ')}" d="${path}" marker-end="url(#arrow)"/>`);
		}
	});

	const width = Math.ceil(layout.width ?? 0);
	const height = Math.ceil(layout.height ?? 0);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		'<title>Dependency graph</title>',
		`<style>${STYLE}${hoverStyle(model, directories, idOf)}</style>`,
		'<defs>',
		marker('arrow', 'arrowhead'),
		marker('arrow-dim', 'arrowhead-dim'),
		marker('arrow-outgoing', 'arrowhead-outgoing'),
		marker('arrow-incoming', 'arrowhead-incoming'),
		'</defs>',
		`<rect class="background" width="${width}" height="${height}"/>`,
		...shapes,
		...directoryLabels,
		'</svg>',
		'',
	].join('\n');
}

/**
 * Builds the CSS that highlights the edges of a hovered node. CSS can not
 * relate a hovered node to its edges generically, so there is one selector per
 * node, e.g. `svg:has(.n3:hover) .from-n3`, and one per edge for the connected
 * files. Directories use the edge classes from {@link directoryRelations}.
 * Arrowheads switch to differently colored markers, because WebKit does not
 * support `context-stroke` in markers.
 */
function hoverStyle(model: GraphModel, directories: string[], idOf: (path: string) => string): string {
	const files = new Set(model.files);
	const inner = new Set<string>();
	const outgoing = new Set<string>();
	const incoming = new Set<string>();
	const targets = new Set<string>();
	const sources = new Set<string>();
	for (const edge of model.edges) {
		const target = idOf(edge.to);
		const edgeFiles = fileSources(edge, files);

		incoming.add(`svg:has(.${target}:hover) .to-${target}`);
		for (const path of edgeFiles) {
			const source = idOf(path);
			outgoing.add(`svg:has(.${source}:hover) .from-${source}`);
			targets.add(`svg:has(.${source}:hover) .${target} .file`);
			sources.add(`svg:has(.${target}:hover) .${source} .file`);
		}

		for (const { directory, relation } of directoryRelations(edge, directories)) {
			const folder = idOf(directory);
			const hovered = `svg:has(.${folder}:hover)`;
			if (relation === 'inner') {
				inner.add(`${hovered} .inner-${folder}`);
			} else if (relation === 'out') {
				outgoing.add(`${hovered} .out-${folder}`);
				targets.add(`${hovered} .${target} .file`);
			} else {
				incoming.add(`${hovered} .in-${folder}`);
				for (const path of edgeFiles) {
					if (!isInside(path, directory)) sources.add(`${hovered} .${idOf(path)} .file`);
				}
			}
		}
	}
	if (incoming.size === 0) return '';

	const rule = (selectors: Iterable<string>, declarations: string): string => {
		const list = [...selectors];
		return list.length > 0 ? `\t${list.join(', ')} { ${declarations} }\n` : '';
	};
	const hoveredDirectories = directories.map(idOf).map((id) => `svg:has(.${id}:hover) .directory.${id}`);
	return [
		'\tsvg:has(.node:hover) .edge { stroke-opacity: 0.15; marker-end: url(#arrow-dim); }\n',
		// before the colored rules, so an edge that also crosses the border gets its color
		rule(inner, 'stroke-opacity: 0.7; marker-end: url(#arrow);'),
		rule(outgoing, 'stroke: var(--outgoing); stroke-opacity: 1; marker-end: url(#arrow-outgoing);'),
		rule(incoming, 'stroke: var(--incoming); stroke-opacity: 1; marker-end: url(#arrow-incoming);'),
		rule(targets, 'stroke: var(--outgoing);'),
		rule(sources, 'stroke: var(--incoming);'),
		rule(hoveredDirectories, 'stroke-width: 2;'),
	].join('');
}

/**
 * The files an edge starts at: its source, or for merged edges the files
 * whose edges were merged into it.
 */
function fileSources(edge: GraphEdge, files: Set<string>): string[] {
	return [edge.from, ...(edge.via ?? [])].filter((path) => files.has(path));
}

/**
 * How an edge relates to each directory: `out` if it leaves the directory,
 * `in` if it enters it, `inner` if it runs inside it. A merged edge with
 * sources inside and outside of a directory can be both `in` and `inner`.
 */
function directoryRelations(
	edge: GraphEdge,
	directories: string[],
): { directory: string; relation: 'in' | 'out' | 'inner' }[] {
	const sources = [edge.from, ...(edge.via ?? [])];
	return directories.flatMap((directory) => {
		const targetInside = isInside(edge.to, directory);
		const sourceInside = sources.some((source) => isInside(source, directory));
		const sourceOutside = sources.some((source) => !isInside(source, directory));
		const relations: { directory: string; relation: 'in' | 'out' | 'inner' }[] = [];
		if (targetInside && sourceOutside) relations.push({ directory, relation: 'in' });
		if (!targetInside && sourceInside) relations.push({ directory, relation: 'out' });
		if (targetInside && sourceInside) relations.push({ directory, relation: 'inner' });
		return relations;
	});
}

/** Whether `path` is `directory` itself or lies inside it. */
function isInside(path: string, directory: string): boolean {
	return path === directory || path.startsWith(directory + '/');
}

function marker(id: string, className: string): string {
	return `<marker id="${id}" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path class="${className}" d="M0,0 L8,4 L0,8 z"/></marker>`;
}

/**
 * Returns all directory paths that contain the given files, including
 * intermediate directories, in order of first appearance.
 */
function getDirectories(files: string[]): string[] {
	const directories = new Set<string>();
	for (const file of files) {
		const segments = file.split('/');
		for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'));
	}
	return [...directories];
}

interface BuildContext {
	directories: string[];
	files: string[];
	ports: Map<string, ElkPort[]>;
}

function buildDirectoryNode(directory: string, context: BuildContext): ElkNode {
	const isChild = (path: string): boolean => parentOf(path) === directory;
	return {
		id: directory,
		layoutOptions: {
			...LAYOUT_OPTIONS,
			'elk.padding': `[top=${DIRECTORY_LABEL_HEIGHT + 6},left=${DIRECTORY_PADDING},bottom=${DIRECTORY_PADDING},right=${DIRECTORY_PADDING}]`,
			'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
			// Width and height are swapped on purpose: with direction DOWN and INCLUDE_CHILDREN,
			// ELK applies the minimum size without rotating it, so "(0, w)" yields width w.
			'elk.nodeSize.minimum': `(0, ${textWidth(basename(directory), true) + 2 * DIRECTORY_PADDING})`,
		},
		children: [
			...context.directories.filter(isChild).map((d) => buildDirectoryNode(d, context)),
			...context.files.filter(isChild).map((f) => buildFileNode(f, context)),
		],
		// ports of merged edges that start at this directory
		ports: context.ports.get(directory) ?? [],
	};
}

function buildFileNode(file: string, context: BuildContext): ElkNode {
	return {
		id: file,
		width: textWidth(basename(file)) + 2 * NODE_PADDING,
		height: NODE_HEIGHT,
		layoutOptions: FILE_PORT_OPTIONS,
		ports: context.ports.get(file) ?? [],
	};
}

/**
 * Renders a text element. `textLength` pins the rendered width to the width
 * used for the layout, so a font with other metrics can not overflow its box.
 */
function text(className: string, x: number, y: number, content: string, bold = false): string {
	return `<text class="${className}" x="${num(x)}" y="${num(y)}" textLength="${num(textWidth(content, bold))}" lengthAdjust="spacingAndGlyphs">${escapeXml(content)}</text>`;
}

/** Estimates the rendered width of a label in pixels. */
function textWidth(content: string, bold = false): number {
	return measureText(content, FONT_SIZE, bold);
}

function parentOf(path: string): string {
	return path.split('/').slice(0, -1).join('/');
}

function basename(path: string): string {
	return path.split('/').at(-1) ?? path;
}
