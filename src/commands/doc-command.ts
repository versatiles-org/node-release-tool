import { Shell } from '../lib/shell.js';
import { getErrorMessage } from '../lib/utils.js';

/**
 * Generates documentation for a CLI command and its subcommands.
 * @param command The base CLI command to document.
 * @returns A Promise resolving to a string containing the generated Markdown documentation.
 */
export async function generateCommandDocumentation(command: string): Promise<string> {
	// Get the base command's documentation and list of subcommands.
	// eslint-disable-next-line prefer-const
	let { markdown, subcommands } = await getCommandResults(command);

	// Iterate over each subcommand to generate its documentation.
	markdown += (
		await Promise.all(
			subcommands.map(async (subcommand) => {
				const fullCommand = `${command} ${subcommand}`;
				try {
					// Get documentation for each subcommand.
					const { markdown: subcommandMarkdown } = await getCommandResults(fullCommand);
					return `\n# Subcommand: \`${fullCommand}\`\n\n${subcommandMarkdown}`;
				} catch (error) {
					// Handle errors in generating subcommand documentation.
					throw new Error(
						`Error generating documentation for subcommand '${fullCommand}': ${getErrorMessage(error)}`,
						{ cause: error },
					);
				}
			}),
		)
	).join('');

	return markdown;
}

/**
 * Executes a CLI command with the '--help' flag and parses the output.
 * @param command The CLI command to execute.
 * @returns A Promise resolving to an object containing the Markdown documentation and a list of subcommands.
 */
async function getCommandResults(command: string): Promise<{ markdown: string; subcommands: string[] }> {
	// The help output is captured into the documentation, so colours must not end up in it.
	const shell = new Shell(process.cwd(), {
		...process.env,
		NODE_ENV: undefined,
		NODE_DISABLE_COLORS: '1',
		NO_COLORS: '1',
		FORCE_COLOR: '0',
	});

	// The subprocess writes progress notices to stderr that say nothing about the documentation,
	// so its output is only reported when the command actually fails: exec() then rejects with a
	// ShellError carrying the captured stderr, instead of printing it on every run.
	const { stdout } = await shell.exec('npm', ['--offline', 'exec', '--', ...command.split(' '), '--help']);

	const result = stdout.trim();
	return {
		markdown: `\`\`\`console\n$ ${command}\n${result}\n\`\`\`\n`,
		subcommands: extractSubcommands(result),
	};
}

/**
 * Extracts a list of subcommands from the help output of a command.
 * @param result The string output from a command's help flag.
 * @returns An array of subcommand names.
 */
function extractSubcommands(result: string): string[] {
	return result
		.replace(/.*\nCommands:/gims, '') // Remove everything before the "Commands:" section.
		.replace(/\n[a-z]+:.*/ims, '') // Remove everything after the subcommands list.
		.split('\n') // Split by newline to process each line.
		.flatMap((line): string[] => {
			// Extract subcommand names from each line.
			const extract = /^ {2}([^ ]{2,})/.exec(line);
			if (!extract) return [];

			const [, subcommand] = extract;
			// Ignore the 'help' subcommand.
			if (subcommand === 'help') return [];
			return [subcommand];
		});
}
