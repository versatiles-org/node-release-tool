/**
 * Text helpers for generated SVG files, which are shown as images, so text can
 * not be measured at render time.
 */

/** Font stack of Helvetica and its metric-compatible replacements. */
export const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

/**
 * Advance widths of Helvetica in 1/1000 em, shared by the metric-compatible
 * Arial and Liberation Sans. Used to size boxes without measuring text.
 */
const CHAR_WIDTHS = charWidths({
	222: 'ijl',
	278: ' ./:;!,ftI[]',
	333: '-()r{}',
	389: '*',
	500: 'ckszvxyJ',
	556: '0123456789abdeghnopqu_$#?L',
	584: '+=<>~',
	611: 'FTZ',
	667: '&ABEKPSVXY',
	722: 'wCDHNRU',
	778: 'GOQ',
	833: 'mM',
	944: 'W',
});
/** Bold widths where they differ from {@link CHAR_WIDTHS}. */
const BOLD_CHAR_WIDTHS = charWidths({
	278: 'ijl',
	333: 'ft-',
	389: 'r',
	556: 'ckszvxyae',
	611: 'bdghnopqu',
	778: 'w',
	889: 'm',
});
const DEFAULT_CHAR_WIDTH = 556;

/**
 * Estimates the rendered width of `content` in pixels.
 *
 * @param content - The text
 * @param fontSize - Font size in pixels
 * @param bold - Whether the text is bold
 */
export function textWidth(content: string, fontSize: number, bold = false): number {
	let width = 0;
	for (const char of content) {
		width += (bold ? BOLD_CHAR_WIDTHS.get(char) : undefined) ?? CHAR_WIDTHS.get(char) ?? DEFAULT_CHAR_WIDTH;
	}
	return (width * fontSize) / 1000;
}

/** Formats a coordinate with at most two decimals to keep the SVG small. */
export function num(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** Escapes text for use in SVG content and attribute values. */
export function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Turns a map of width to characters into a map of character to width. */
function charWidths(groups: Record<number, string>): Map<string, number> {
	const widths = new Map<string, number>();
	for (const [width, chars] of Object.entries(groups)) {
		for (const char of chars) widths.set(char, Number(width));
	}
	return widths;
}
