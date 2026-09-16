import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';

/**
 * A dependency edge. `from` is a file path or, for merged edges, a directory path.
 */
export interface GraphEdge {
	from: string;
	to: string;
}

/**
 * The files and edges of a dependency graph. Directories are derived from the file paths.
 */
export interface GraphModel {
	files: string[];
	edges: GraphEdge[];
}

const FONT_SIZE = 12;
/** Approximate advance of one character of a monospace font at {@link FONT_SIZE}. */
const CHAR_WIDTH = 7.2;
const NODE_HEIGHT = 24;
const NODE_PADDING = 8;
const DIRECTORY_LABEL_HEIGHT = 22;
const DIRECTORY_PADDING = 10;

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
	'elk.spacing.edgeEdge': '6',
	'elk.layered.spacing.edgeEdgeBetweenLayers': '6',
};

const STYLE = `
	.background { fill: #ffffff; }
	.directory { stroke: #c5ccc9; stroke-width: 1; }
	.depth1 { fill: #f2f4f3; }
	.depth2 { fill: #e8ecea; }
	.depth3 { fill: #dfe4e2; }
	.file { fill: #ffffff; stroke: #9aa6a1; stroke-width: 1; }
	text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${FONT_SIZE}px; }
	.label { fill: #1b2220; text-anchor: middle; }
	.directory-label { fill: #66736d; font-weight: 600; }
	.edge { fill: none; stroke: #5f6b66; stroke-width: 1; stroke-opacity: 0.7; }
	.arrowhead { fill: #5f6b66; }
	@media (prefers-color-scheme: dark) {
		.background { fill: #0d1117; }
		.directory { stroke: #39424d; }
		.depth1 { fill: #161b22; }
		.depth2 { fill: #1c232c; }
		.depth3 { fill: #232b35; }
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
 * routed orthogonally from top to bottom. Colors follow the viewer's color
 * scheme via `prefers-color-scheme`. The output is deterministic, so it only
 * changes when the graph changes.
 *
 * @param model - Files and edges; edge sources may be directory paths
 * @returns The SVG document
 */
export async function renderSvgGraph(model: GraphModel): Promise<string> {
	const directories = getDirectories(model.files);
	const roots = directories.filter((d) => !d.includes('/'));
	const topFiles = model.files.filter((f) => !f.includes('/'));

	const graph: ElkNode = {
		id: '#root',
		layoutOptions: {
			...LAYOUT_OPTIONS,
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
			'elk.json.edgeCoords': 'ROOT',
			'elk.json.shapeCoords': 'ROOT',
		},
		children: [...roots.map((d) => buildDirectoryNode(d, directories, model.files)), ...topFiles.map(buildFileNode)],
		edges: model.edges.map((edge, index): ElkExtendedEdge => ({
			id: `edge${index}`,
			sources: [edge.from],
			targets: [edge.to],
		})),
	};

	// elkjs is CommonJS with an ES-style default export in its typings, so TypeScript
	// only accepts `.default`, which elkjs also provides at runtime.
	const layout = await new ELK.default().layout(graph);

	const shapes: string[] = [];
	const drawNode = (node: ElkNode, depth: number): void => {
		const { x = 0, y = 0, width = 0, height = 0 } = node;
		if (node.children) {
			shapes.push(
				`<rect class="directory depth${Math.min(depth, 3)}" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="6"/>`,
				text('directory-label', x + DIRECTORY_PADDING, y + 16, basename(node.id)),
			);
			node.children.forEach((child) => drawNode(child, depth + 1));
		} else {
			shapes.push(
				`<rect class="file" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4"/>`,
				text('label', x + width / 2, y + height / 2 + 4, basename(node.id)),
			);
		}
	};
	layout.children?.forEach((child) => drawNode(child, 1));

	for (const edge of layout.edges ?? []) {
		for (const section of edge.sections ?? []) {
			const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
			const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${num(p.x)},${num(p.y)}`).join(' ');
			shapes.push(`<path class="edge" d="${path}" marker-end="url(#arrow)"/>`);
		}
	}

	const width = Math.ceil(layout.width ?? 0);
	const height = Math.ceil(layout.height ?? 0);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		'<title>Dependency graph</title>',
		`<style>${STYLE}</style>`,
		'<defs><marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="arrowhead" d="M0,0 L8,4 L0,8 z"/></marker></defs>',
		`<rect class="background" width="${width}" height="${height}"/>`,
		...shapes,
		'</svg>',
		'',
	].join('\n');
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

function buildDirectoryNode(directory: string, directories: string[], files: string[]): ElkNode {
	const isChild = (path: string): boolean => parentOf(path) === directory;
	return {
		id: directory,
		layoutOptions: {
			...LAYOUT_OPTIONS,
			'elk.padding': `[top=${DIRECTORY_LABEL_HEIGHT + 6},left=${DIRECTORY_PADDING},bottom=${DIRECTORY_PADDING},right=${DIRECTORY_PADDING}]`,
			'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
			// Width and height are swapped on purpose: with direction DOWN and INCLUDE_CHILDREN,
			// ELK applies the minimum size without rotating it, so "(0, w)" yields width w.
			'elk.nodeSize.minimum': `(0, ${textWidth(basename(directory)) + 2 * DIRECTORY_PADDING})`,
		},
		children: [
			...directories.filter(isChild).map((d) => buildDirectoryNode(d, directories, files)),
			...files.filter(isChild).map(buildFileNode),
		],
	};
}

function buildFileNode(file: string): ElkNode {
	return { id: file, width: textWidth(basename(file)) + 2 * NODE_PADDING, height: NODE_HEIGHT };
}

/**
 * Renders a text element. `textLength` pins the rendered width to the width
 * used for the layout, so a different monospace font can not overflow its box.
 */
function text(className: string, x: number, y: number, content: string): string {
	return `<text class="${className}" x="${num(x)}" y="${num(y)}" textLength="${num(textWidth(content))}" lengthAdjust="spacingAndGlyphs">${escapeXml(content)}</text>`;
}

function textWidth(content: string): number {
	return content.length * CHAR_WIDTH;
}

function parentOf(path: string): string {
	return path.split('/').slice(0, -1).join('/');
}

function basename(path: string): string {
	return path.split('/').at(-1) ?? path;
}

/** Formats a coordinate with at most two decimals to keep the SVG small. */
function num(value: number): string {
	return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
