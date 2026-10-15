import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { D1Database } from '@cloudflare/workers-types';
import { bestEffort, withCleanup } from '@cupboard/shared/cleanup';

export type LocalDevelopmentBinding = 'CUPBOARD_DB' | 'CONTROL_DB';

export interface LocalDevelopmentPlatform {
	query(
		binding: LocalDevelopmentBinding,
		statement: string
	): Promise<readonly unknown[]>;
	execute(binding: LocalDevelopmentBinding, statement: string): Promise<void>;
	dispose(): Promise<void>;
}

export type LocalDevelopmentPlatformFactory = (
	configuration: string,
	persistTo: string
) => Promise<LocalDevelopmentPlatform>;

async function createLocalPlatform(
	configuration: string,
	persistTo: string
): Promise<LocalDevelopmentPlatform> {
	const { getPlatformProxy, unstable_readConfig } = await import('wrangler');
	const config = unstable_readConfig({ config: configuration });
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'cupboard-local-bindings-')
	);
	try {
		const configPath = path.join(directory, 'wrangler.json');
		await writeFile(
			configPath,
			JSON.stringify({
				name: config.name,
				compatibility_date: config.compatibility_date,
				compatibility_flags: config.compatibility_flags,
				d1_databases: config.d1_databases
			})
		);
		const platform = await getPlatformProxy<
			Record<LocalDevelopmentBinding, D1Database>
		>({
			configPath,
			persist: { path: path.join(persistTo, 'v3') },
			remoteBindings: false,
			envFiles: []
		});
		return {
			async query(binding, statement) {
				const result = await platform.env[binding].prepare(statement).all();
				return result.results;
			},
			async execute(binding, statement) {
				await platform.env[binding].exec(statement);
			},
			dispose: () =>
				withCleanup(
					() => platform.dispose(),
					() => rm(directory, { recursive: true, force: true })
				)
		};
	} catch (error) {
		await bestEffort(() => rm(directory, { recursive: true, force: true }));
		throw error;
	}
}

/**
 * Reuses local D1 bindings within a bootstrap phase. Dispose the session before
 * an external migration process opens the same persisted databases.
 */
export class LocalDevelopmentSession {
	private platform?: Promise<LocalDevelopmentPlatform>;

	constructor(
		private readonly configuration: string,
		private readonly persistTo: string,
		private readonly create: LocalDevelopmentPlatformFactory = createLocalPlatform
	) {}

	private async current(): Promise<LocalDevelopmentPlatform> {
		const pending =
			this.platform ?? this.create(this.configuration, this.persistTo);
		this.platform = pending;
		try {
			return await pending;
		} catch (error) {
			if (this.platform === pending) {
				this.platform = undefined;
			}
			throw error;
		}
	}

	async query(
		binding: LocalDevelopmentBinding,
		statement: string
	): Promise<readonly unknown[]> {
		const platform = await this.current();
		return platform.query(binding, statement);
	}

	async execute(
		binding: LocalDevelopmentBinding,
		statement: string
	): Promise<void> {
		const platform = await this.current();
		return platform.execute(binding, statement);
	}

	async dispose(): Promise<void> {
		const pending = this.platform;
		this.platform = undefined;
		if (pending === undefined) {
			return;
		}
		const platform = await pending;
		await platform.dispose();
	}
}
