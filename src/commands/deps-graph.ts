import { cruise } from 'dependency-cruiser';
import { panic } from '../lib/log.js';
import { graph2svg } from '../lib/elk_svg.js';
import { writeFileSync } from 'fs';

export async function generateDependencyGraph(directory: string, format: 'mermaid' | 'svg' = 'mermaid'): Promise<void> {
	let cruiseResult;
	try {
		cruiseResult = await cruise([directory], {
			includeOnly: '^src',
			outputType: format == 'mermaid' ? 'mermaid' : 'json',
			exclude: ["\\.(test|d)\\.ts$", "node_modules", "__mocks__/"],
		});
	} catch (pError) {
		panic(String(pError));
	}

	let { output } = cruiseResult;
	if (typeof output !== 'string') panic('no output');

	switch (format) {
		case 'mermaid':

			output = output.replace('flowchart LR', '---\nconfig:\n  layout: elk\n---\nflowchart TB')

			const matches = Array.from(output.matchAll(/subgraph ([0-9a-z]+)/gi));
			const subgraphIds = matches.map(([_match, id]) => id);
			output += `\nclass ${subgraphIds.join(',')} subgraphs;`;
			output += `\nclassDef subgraphs fill-opacity:0.1, fill:#888, color:#888, stroke:#888;`;
			output += '```mermaid\n' + output + '\n```\n';
			break;
		case 'svg':
			const svg = await graph2svg(JSON.parse(output));
			writeFileSync('graph.svg', svg);
			console.log(svg);
			process.exit(0);
	}

	process.stdout.write(Buffer.from(output));
}
