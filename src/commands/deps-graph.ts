
import { cruise } from 'dependency-cruiser';
import { panic } from '../lib/log.js';

export async function generateDependencyGraph(directory: string): Promise<void> {
	let cruiseResult;
	try {
		cruiseResult = await cruise([directory], {
			includeOnly: '^src',
			outputType: 'mermaid',
			exclude: ["\\.(test|d)\\.ts$", "node_modules"],
		});
	} catch (pError) {
		panic(String(pError));
	}

	let { output } = cruiseResult;
	if (typeof output !== 'string') panic('no output');

	output = output.replace('flowchart LR', 'flowchart TB')

	const matches = Array.from(output.matchAll(/subgraph (\d+)/g));
	for (const [_match, id] of matches) output += `\nstyle ${id} fill-opacity:0.2`;

	process.stdout.write(Buffer.from('```mermaid\n' + output + '\n```\n'));
}
