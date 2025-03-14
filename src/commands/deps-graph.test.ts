import { jest } from '@jest/globals';
import type { IReporterOutput } from 'dependency-cruiser';

// 1. Mock dependency-cruiser to control the output of `cruise`
jest.unstable_mockModule('dependency-cruiser', () => ({
	cruise: jest.fn(),
}));

// 2. Mock the log/panic module
jest.unstable_mockModule('../lib/log.js', () => ({
	panic: jest.fn((message: string) => {
		throw new Error(message);
	}),
}));

// 3. Import the mocked modules and the function under test
const { cruise } = await import('dependency-cruiser');
const { panic } = await import('../lib/log.js');
const { generateDependencyGraph } = await import('./deps-graph.js');

describe('generateDependencyGraph', () => {
	let mockStdoutWrite: jest.SpiedFunction<typeof process.stdout.write>;

	beforeEach(() => {
		// Reset and clear mocks before each test
		jest.clearAllMocks();

		// Spy on process.stdout.write to check what gets written
		mockStdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		// Restore any spied methods
		mockStdoutWrite.mockRestore();
	});

	it('generates a mermaid diagram, replacing flowchart LR with flowchart TB', async () => {
		// Mock a successful result from dependency-cruiser
		jest.mocked(cruise).mockResolvedValueOnce({
			output: 'flowchart LR\nA-->B',
		} as IReporterOutput);

		await expect(generateDependencyGraph('src')).resolves.toBeUndefined();

		// Verify the call to `cruise` used the expected arguments
		expect(cruise).toHaveBeenCalledWith(
			['src'],
			expect.any(Object),
		);

		// After modification, we expect flowchart TB in the output
		expect(mockStdoutWrite).toHaveBeenCalledTimes(1);
		// The actual argument passed to stdout.write
		const writtenBuffer = mockStdoutWrite.mock.calls[0][0] as Buffer;
		const writtenString = writtenBuffer.toString();

		expect(writtenString).toMatch(/^```mermaid\n/);
		expect(writtenString).toMatch(/\nflowchart TB\nA-->B\n/);
		expect(writtenString).toMatch(/\n```\n$/);
	});

	it('panics if dependency-cruiser throws an error', async () => {
		// Simulate a thrown error from `cruise`
		jest.mocked(cruise).mockImplementationOnce(async () => {
			throw new Error('Some error from dependency-cruiser');
		});

		await expect(generateDependencyGraph('bad/path')).rejects.toThrow('Some error from dependency-cruiser');

		// Confirm the panic function was called with the thrown error message
		expect(panic).toHaveBeenCalledWith('Error: Some error from dependency-cruiser');
		// No output should be written
		expect(mockStdoutWrite).not.toHaveBeenCalled();
	});

	it('panics if the returned output is not a string', async () => {
		// Mock an invalid result (missing or incorrect `output` field)
		jest.mocked(cruise).mockResolvedValueOnce({
			output: null,
		} as unknown as IReporterOutput);

		await expect(generateDependencyGraph('src')).rejects.toThrow('no output');
		expect(panic).toHaveBeenCalledWith('no output');
		expect(mockStdoutWrite).not.toHaveBeenCalled();
	});
});