import { execFile } from 'node:child_process';
import {
	copyFile,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { withCleanup } from '@cupboard/shared/cleanup';
import { z } from 'zod';

import {
	bootstrapLocalDevelopmentDatabases,
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
	constructor(
		private readonly persistTo?: string,
		readonly binding = 'CUPBOARD_DB'
	) {}

	private async wrangler(
		command: readonly string[],
		configuration = 'wrangler.jsonc'
	): Promise<string> {
		const commandArguments = [
			path.join(serverDirectory, 'node_modules/wrangler/bin/wrangler.js'),
			'd1',
			...command,
			this.binding,
			'--config',
			configuration,
			'--local',
			'--persist-to',
			this.persistTo ?? path.join(serverDirectory, '.wrangler/state')
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

	async applyMigrations(): Promise<void> {
		await this.wrangler(['migrations', 'apply']);
	}

	async applyExpandMigrations(): Promise<void> {
		if (this.binding !== 'CUPBOARD_DB') {
			await this.applyMigrations();
			return;
		}
		const temporary = await mkdtemp(
			path.join(os.tmpdir(), 'cupboard-local-migrations-')
		);
		await withCleanup(
			async () => {
				const directory = path.join(serverDirectory, 'drizzle-d1');
				const files = await readdir(directory);
				for (const file of files) {
					if (
						file === '0042_control_database_contract.sql' ||
						!file.endsWith('.sql')
					) {
						continue;
					}
					await copyFile(
						path.join(directory, file),
						path.join(temporary, file)
					);
				}
				const source = await readFile(
					path.join(serverDirectory, 'wrangler.jsonc'),
					'utf8'
				);
				const configuration = source
					.replace(
						'"main": "src/worker.ts"',
						() =>
							`"main": ${JSON.stringify(path.join(serverDirectory, 'src/worker.ts'))}`
					)
					.replace(
						'"migrations_dir": "drizzle-d1"',
						() => `"migrations_dir": ${JSON.stringify(temporary)}`
					)
					.replace(
						'"migrations_dir": "drizzle-control-d1"',
						() =>
							`"migrations_dir": ${JSON.stringify(path.join(serverDirectory, 'drizzle-control-d1'))}`
					);
				const filename = path.join(temporary, 'wrangler.jsonc');
				await writeFile(filename, configuration);
				await this.wrangler(['migrations', 'apply'], filename);
			},
			async () => rm(temporary, { recursive: true, force: true })
		);
	}

	async setup(): Promise<void> {
		await setupLocalDatabases(this.persistTo);
	}
}

export async function setupLocalDatabases(persistTo?: string): Promise<void> {
	const shared = new LocalWranglerDatabase(persistTo);
	const control = new LocalWranglerDatabase(persistTo, 'CONTROL_DB');
	await bootstrapLocalDevelopmentDatabases(
		[
			{
				database: shared,
				applyMigrations: () => shared.applyExpandMigrations()
			},
			{ database: control, applyMigrations: () => control.applyMigrations() }
		],
		async () => {
			await control.execute(
				"INSERT INTO control_database_ready (id, source_database_id, state) VALUES ('current', 'local-shared', 'ready') ON CONFLICT(id) DO NOTHING"
			);
			await shared.execute(
				"INSERT INTO control_database_split (id, target_database_id, frozen_at, copied_at) VALUES ('current', 'local-control', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO NOTHING"
			);
			await shared.applyMigrations();
		}
	);
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
