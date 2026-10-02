import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
	bootstrapLocalDevelopment,
	type LocalDevelopmentDatabase
} from '../packages/server/src/db/local-development.ts';

const executeFile = promisify(execFile);
const serverDirectory = path.resolve(import.meta.dirname, '../packages/server');
const commandOutput = z.object({
	stdout: z.string().optional(),
	stderr: z.string().optional()
});

export class LocalWranglerCommandError extends Error {
	constructor(cause: unknown) {
		const output = commandOutput.safeParse(cause);
		const detail = output.success
			? [output.data.stdout, output.data.stderr].filter(Boolean).join('\n')
			: '';
		const message = [
			cause instanceof Error ? cause.message : String(cause),
			detail
		]
			.filter(Boolean)
			.join('\n');
		super(message, { cause });
		this.name = 'LocalWranglerCommandError';
	}
}

const commandResult = z.object({
	success: z.literal(true),
	results: z.array(z.unknown())
});
const queryResults = z.array(commandResult);

export class LocalWranglerDatabase implements LocalDevelopmentDatabase {
	constructor(private readonly persistTo?: string) {}

	private async wrangler(command: readonly string[]): Promise<string> {
		const commandArguments = [
			path.join(serverDirectory, 'node_modules/wrangler/bin/wrangler.js'),
			'd1',
			...command,
			'CUPBOARD_DB',
			'--config',
			'wrangler.jsonc',
			'--local',
			...(this.persistTo === undefined ? [] : ['--persist-to', this.persistTo])
		];
		try {
			const { stdout } = await executeFile(process.execPath, commandArguments, {
				cwd: serverDirectory,
				env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
				maxBuffer: 4 * 1024 * 1024
			});
			return stdout;
		} catch (error) {
			throw new LocalWranglerCommandError(error);
		}
	}

	async query(sql: string): Promise<readonly unknown[]> {
		const stdout = await this.wrangler(['execute', '--command', sql, '--json']);
		return queryResults
			.parse(JSON.parse(stdout))
			.flatMap(({ results }) => results);
	}

	async execute(sql: string): Promise<void> {
		await this.query(sql);
	}

	async setup(): Promise<void> {
		await bootstrapLocalDevelopment(this, async () => {
			await this.wrangler(['migrations', 'apply']);
		});
	}
}

async function main(): Promise<void> {
	if (process.argv.length > 2) {
		throw new Error(
			'Local setup does not accept arguments. Run pnpm dev:setup.'
		);
	}
	await new LocalWranglerDatabase().setup();
	console.log(
		'Local D1 schema and deployment transitions are ready. Run pnpm dev.'
	);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await main();
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
