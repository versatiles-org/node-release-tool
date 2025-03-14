
import { cruise } from 'dependency-cruiser';
import { panic } from '../lib/log.js';

export async function generateDependencyGraph(directory: string): Promise<void> {
	let cruiseResult;
	try {
		cruiseResult = await cruise([directory], {
			includeOnly: '^src',
			outputType: 'mermaid',
			exclude: ["\\.(test|d)\\.ts$", "node_modules", "__mocks__/"],
		});
	} catch (pError) {
		panic(String(pError));
	}

	let { output } = cruiseResult;
	if (typeof output !== 'string') panic('no output');

	output = output.replace('flowchart LR', '---\nconfig:\n  layout: elk\n---\nflowchart TB')

	const matches = Array.from(output.matchAll(/subgraph ([0-9a-z]+)/gi));
	const subgraphIds = matches.map(([_match, id]) => id);
	output += `\nclass ${subgraphIds.join(',')} subgraphs;`;
	output += `\nclassDef subgraphs fill-opacity:0.1, fill:#888, color:#888, stroke:#888;`;

	process.stdout.write(Buffer.from('```mermaid\n' + output + '\n```\n'));
}
