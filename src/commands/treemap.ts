import { panic } from '../lib/log.js';
import { writeSvgImage } from '../lib/svg-image.js';
import { escapeXml, FONT_FAMILY, num, textWidth } from '../lib/svg-text.js';

/**
 * A node of a treemap: either a leaf with a `size`, or a group with `children`.
 */
export interface TreemapNode {
	name: string;
	size?: number;
	children?: TreemapNode[];
}

/**
 * The JSON input of `vrt treemap`, e.g.:
 *
 * ```json
 * {
 *   "title": "Bundle composition",
 *   "caption": "234 KB raw, 71 KB gzipped",
 *   "unit": "bytes",
 *   "children": [{ "name": "lib", "children": [{ "name": "a.ts", "size": 5325 }] }]
 * }
 * ```
 */
export interface TreemapData {
	/** Alternative text of the image and title of the SVG. Default: "Treemap". */
	title?: string;
	/** Markdown printed below the image. */
	caption?: string;
	/** With "bytes", sizes are shown as B, KB or MB. Otherwise they are shown as numbers. */
	unit?: 'bytes';
	children: TreemapNode[];
}

/**
 * Options for {@link generateTreemap}.
 */
export interface TreemapOptions {
	/** Path of the SVG file to write, relative to the project directory. */
	svg: string;
	/** Width of the SVG in pixels. Default: 880. */
	width?: number;
	/** Height of the SVG in pixels. Default: 480. */
	height?: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const FONT_SIZE = 11;
const GROUP_FONT_SIZE = 12;
const GROUP_HEADER = 20;
const GROUP_PADDING = 3;
const GAP = 1;

/** Hues of the top-level groups, repeated if there are more groups. */
const HUES = [210, 28, 140, 275, 350, 180, 48, 320, 95, 245];

/**
 * Renders a treemap from JSON and writes it as SVG file, then prints a
 * Markdown image link to it, followed by the caption.
 *
 * The link behaves like the one of `vrt deps-graph --svg`: it is relative, and
 * it points to the file at the release tag while `release-npm` publishes.
 *
 * @param directory - The project directory
 * @param input - The treemap as JSON, see {@link TreemapData}
 * @param options - Output file and size
 * @throws {VrtError} If the JSON is invalid
 */
export async function generateTreemap(directory: string, input: string, options: TreemapOptions): Promise<void> {
	const data = parseTreemapData(input);
	const svg = renderTreemapSvg(data, options.width ?? 880, options.height ?? 480);
	const image = await writeSvgImage(directory, options.svg, svg, data.title ?? 'Treemap');
	process.stdout.write(image + '\n' + (data.caption ? `\n${data.caption}\n` : ''));
}

/**
 * Parses and validates the JSON input of a treemap.
 *
 * @throws {VrtError} If the JSON can not be parsed or does not describe a treemap
 */
export function parseTreemapData(input: string): TreemapData {
	let data: unknown;
	try {
		data = JSON.parse(input);
	} catch (error) {
		panic(`treemap: invalid JSON: ${String(error)}`);
	}
	if (!isObject(data)) panic('treemap: input must be a JSON object');
	for (const key of ['title', 'caption'] as const) {
		if (data[key] !== undefined && typeof data[key] !== 'string') panic(`treemap: "${key}" must be a string`);
	}
	if (data.unit !== undefined && data.unit !== 'bytes') panic('treemap: "unit" must be "bytes" or omitted');
	validateChildren(data.children, 'children');
	return data as unknown as TreemapData;
}

/**
 * Lays out the treemap with the squarified algorithm and renders it as SVG.
 * Groups get a header with name and size, and every top-level group its own
 * color. Labels are shortened to fit, and every box has a tooltip with its full
 * path, size and share. Colors follow the viewer's color scheme.
 */
export function renderTreemapSvg(data: TreemapData, width: number, height: number): string {
	const total = sum(data.children);
	const format = (size: number): string => formatSize(size, data.unit);
	const shapes: string[] = [];

	const drawNodes = (nodes: TreemapNode[], rect: Rect, path: string[], parentColor: number | undefined): void => {
		const items = nodes.map((node) => ({ node, value: sum([node]) }));
		squarify(items, rect).forEach(({ item: { node, value }, rect: box }, index) => {
			// top-level groups get their own color, nested boxes inherit it
			const color = parentColor ?? index % HUES.length;
			const names = [...path, node.name];
			const tooltip = `${names.join('/')}: ${format(value)} (${formatShare(value, total)})`;
			const inner = inset(box, GAP);
			if (inner.width <= 0 || inner.height <= 0) return;

			if (node.children) {
				const header = inner.height >= GROUP_HEADER + 12 && inner.width >= 30 ? GROUP_HEADER : GROUP_PADDING;
				shapes.push(
					`<g class="group c${color}"><title>${escapeXml(tooltip)}</title>`,
					box2rect('group-box', inner),
				);
				if (header === GROUP_HEADER) {
					const label = fitLabel(
						[`${node.name} ${format(value)}`, node.name],
						inner.width - 8,
						GROUP_FONT_SIZE,
						true,
					);
					if (label) shapes.push(text('group-label', inner.x + 4, inner.y + 14, label, GROUP_FONT_SIZE, true));
				}
				shapes.push('</g>');
				const content = {
					x: inner.x + GROUP_PADDING,
					y: inner.y + header,
					width: inner.width - 2 * GROUP_PADDING,
					height: inner.height - header - GROUP_PADDING,
				};
				if (content.width > 0 && content.height > 0) drawNodes(node.children, content, names, color);
			} else {
				shapes.push(`<g class="leaf c${color}"><title>${escapeXml(tooltip)}</title>`, box2rect('leaf-box', inner));
				const name = inner.height >= 18 ? fitLabel([node.name], inner.width - 8, FONT_SIZE) : undefined;
				if (name) {
					const twoLines = inner.height >= 34;
					const y = inner.y + (twoLines ? inner.height / 2 - 2 : inner.height / 2 + 4);
					shapes.push(text('leaf-label', inner.x + inner.width / 2, y, name, FONT_SIZE));
					// sizes are shown completely or not at all
					const size = format(value);
					const showSize = twoLines && textWidth(size, FONT_SIZE) <= inner.width - 8;
					if (showSize) shapes.push(text('leaf-size', inner.x + inner.width / 2, y + 14, size, FONT_SIZE));
				}
				shapes.push('</g>');
			}
		});
	};
	drawNodes(data.children, { x: 0, y: 0, width, height }, [], undefined);

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<title>${escapeXml(data.title ?? 'Treemap')}</title>`,
		`<style>${style()}</style>`,
		`<rect class="background" width="${width}" height="${height}"/>`,
		...shapes,
		'</svg>',
		'',
	].join('\n');
}

/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk): places the items,
 * sorted by value, in rows along the shorter side of the remaining rectangle,
 * and starts a new row when adding an item would make the aspect ratios worse.
 */
export function squarify<T extends { value: number }>(items: T[], rect: Rect): { item: T; rect: Rect }[] {
	const sorted = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
	const scale = (rect.width * rect.height) / sorted.reduce((total, item) => total + item.value, 0);
	const result: { item: T; rect: Rect }[] = [];
	let { x, y, width, height } = rect;

	let start = 0;
	while (start < sorted.length) {
		const side = Math.min(width, height);
		let end = start + 1;
		while (
			end < sorted.length &&
			worst(sorted, start, end + 1, side, scale) <= worst(sorted, start, end, side, scale)
		) {
			end++;
		}

		const row = sorted.slice(start, end);
		const rowArea = row.reduce((total, item) => total + item.value, 0) * scale;
		if (width >= height) {
			// a column at the left
			const columnWidth = rowArea / height;
			let offset = y;
			for (const item of row) {
				const itemHeight = (item.value * scale) / columnWidth;
				result.push({ item, rect: { x, y: offset, width: columnWidth, height: itemHeight } });
				offset += itemHeight;
			}
			x += columnWidth;
			width -= columnWidth;
		} else {
			// a row at the top
			const rowHeight = rowArea / width;
			let offset = x;
			for (const item of row) {
				const itemWidth = (item.value * scale) / rowHeight;
				result.push({ item, rect: { x: offset, y, width: itemWidth, height: rowHeight } });
				offset += itemWidth;
			}
			y += rowHeight;
			height -= rowHeight;
		}
		start = end;
	}
	return result;
}

/** The worst aspect ratio of the items `start` to `end` laid out along a side. */
function worst(items: { value: number }[], start: number, end: number, side: number, scale: number): number {
	let total = 0;
	let min = Infinity;
	let max = 0;
	for (let i = start; i < end; i++) {
		const area = items[i].value * scale;
		total += area;
		min = Math.min(min, area);
		max = Math.max(max, area);
	}
	return Math.max((side * side * max) / (total * total), (total * total) / (side * side * min));
}

function style(): string {
	const colors = HUES.map((hue, index) =>
		[
			`\t.c${index} .group-box { fill: hsl(${hue} 38% 84%); stroke: hsl(${hue} 30% 62%); }`,
			`\t.c${index} .leaf-box { fill: hsl(${hue} 50% 95%); stroke: hsl(${hue} 30% 72%); }`,
		].join('\n'),
	).join('\n');
	const darkColors = HUES.map((hue, index) =>
		[
			`\t\t.c${index} .group-box { fill: hsl(${hue} 22% 22%); stroke: hsl(${hue} 20% 38%); }`,
			`\t\t.c${index} .leaf-box { fill: hsl(${hue} 25% 14%); stroke: hsl(${hue} 20% 32%); }`,
		].join('\n'),
	).join('\n');
	return `
	.background { fill: #ffffff; }
	text { font-family: ${FONT_FAMILY}; }
	.group-label { fill: #1b2220; font-weight: 600; font-size: ${GROUP_FONT_SIZE}px; }
	.leaf-label { fill: #1b2220; font-size: ${FONT_SIZE}px; text-anchor: middle; }
	.leaf-size { fill: #66736d; font-size: ${FONT_SIZE}px; text-anchor: middle; }
	.group-box, .leaf-box { stroke-width: 1; }
	.leaf:hover .leaf-box { stroke-width: 2; }
${colors}
	@media (prefers-color-scheme: dark) {
		.background { fill: #0d1117; }
		.group-label, .leaf-label { fill: #e6edf3; }
		.leaf-size { fill: #8b949e; }
${darkColors}
	}
`;
}

/** Returns the first candidate that fits `maxWidth`, or the last one shortened with an ellipsis. */
function fitLabel(candidates: string[], maxWidth: number, fontSize: number, bold = false): string | undefined {
	for (const candidate of candidates) {
		if (textWidth(candidate, fontSize, bold) <= maxWidth) return candidate;
	}
	const chars = [...candidates[candidates.length - 1]];
	for (let length = chars.length - 1; length >= 3; length--) {
		const shortened = chars.slice(0, length).join('') + '…';
		if (textWidth(shortened, fontSize, bold) <= maxWidth) return shortened;
	}
	return undefined;
}

function text(className: string, x: number, y: number, content: string, fontSize: number, bold = false): string {
	return `<text class="${className}" x="${num(x)}" y="${num(y)}" textLength="${num(textWidth(content, fontSize, bold))}" lengthAdjust="spacingAndGlyphs">${escapeXml(content)}</text>`;
}

function box2rect(className: string, rect: Rect): string {
	return `<rect class="${className}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" rx="2"/>`;
}

function inset(rect: Rect, amount: number): Rect {
	return { x: rect.x + amount, y: rect.y + amount, width: rect.width - 2 * amount, height: rect.height - 2 * amount };
}

function sum(nodes: TreemapNode[]): number {
	return nodes.reduce((total, node) => total + (node.children ? sum(node.children) : (node.size ?? 0)), 0);
}

function formatSize(size: number, unit: TreemapData['unit']): string {
	const round = (value: number): string => String(Math.round(value * 10) / 10);
	if (unit !== 'bytes') return round(size);
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${round(size / 1024)} KB`;
	return `${round(size / 1024 / 1024)} MB`;
}

function formatShare(value: number, total: number): string {
	return `${total > 0 ? Math.round((value / total) * 1000) / 10 : 0}%`;
}

function validateChildren(children: unknown, path: string): void {
	if (!Array.isArray(children) || children.length === 0) panic(`treemap: "${path}" must be a non-empty array`);
	children.forEach((child, index) => {
		const childPath = `${path}[${index}]`;
		if (!isObject(child)) panic(`treemap: "${childPath}" must be an object`);
		if (typeof child.name !== 'string' || !child.name)
			panic(`treemap: "${childPath}.name" must be a non-empty string`);
		if (child.children !== undefined) {
			validateChildren(child.children, `${childPath}.children`);
		} else if (typeof child.size !== 'number' || !Number.isFinite(child.size) || child.size < 0) {
			panic(`treemap: "${childPath}" needs "children" or a "size" of at least 0`);
		}
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
