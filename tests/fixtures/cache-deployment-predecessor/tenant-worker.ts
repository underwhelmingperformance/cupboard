import { DurableObject } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import migrations from '../../../packages/server/drizzle/migrations.js';

import { seededFixtureTenants } from './constants.ts';

const predecessorMigrationIndex = 41;
const lastDrizzleMigrationIndex = 24;
const createdAt = '2026-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
const pathHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const storePath = `/nix/store/${pathHash}-predecessor`;
const narHash = 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347';

const seedRequestSchema = z.strictObject({
	tenant: z.enum(seededFixtureTenants)
});
const migrationTagRowSchema = z.strictObject({ hash: z.string() });
const migrationJournalRowSchema = z.strictObject({
	hash: z.string(),
	created_at: z.number()
});
const nameRowSchema = z.strictObject({ name: z.string() });

interface FixtureEnvironment {
	readonly CUPBOARD_AUTH_ISSUER: string;
	readonly CUPBOARD_AUTH_AUDIENCE: string;
}

function json(value: unknown): Response {
	return Response.json(value);
}

class FixtureMigrationError extends Error {
	constructor(readonly migration: string) {
		super(`The predecessor fixture cannot apply migration ${migration}`);
		this.name = 'FixtureMigrationError';
	}
}

function migrationKey(index: number): string {
	return `m${index.toString().padStart(4, '0')}`;
}

function applyHistoricalMigrations(
	storage: DurableObjectStorage,
	throughIndex: number
): void {
	storage.sql.exec(
		'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
	);
	const applied = Array.from(
		storage.sql.exec(
			'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id'
		),
		(row) => migrationJournalRowSchema.parse(row)
	);
	const entries = migrations.journal.entries
		.filter((entry) => entry.idx <= throughIndex)
		.toSorted((left, right) => left.idx - right.idx);

	for (const [index, row] of applied.entries()) {
		const entry = entries[index];

		if (entry === undefined) {
			throw new FixtureMigrationError(row.hash || 'unknown');
		}

		const expectedHash =
			entry.idx <= lastDrizzleMigrationIndex ? '' : entry.tag;

		if (entry.when !== row.created_at || row.hash !== expectedHash) {
			throw new FixtureMigrationError(row.hash || 'unknown');
		}
	}

	for (const entry of entries.slice(applied.length)) {
		const source = migrations.migrations[migrationKey(entry.idx)];

		if (source === undefined) {
			throw new FixtureMigrationError(entry.tag);
		}
		const statements = source
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter((statement) => statement !== '');

		storage.transactionSync(() => {
			for (const statement of statements) {
				storage.sql.exec(statement);
			}
			storage.sql.exec(
				'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
				entry.idx <= lastDrizzleMigrationIndex ? '' : entry.tag,
				entry.when
			);
		});
	}
}

function sleepingMigrationIndex(
	tenant: z.infer<typeof seedRequestSchema>['tenant']
): number | undefined {
	switch (tenant) {
		case 'upgrade-sleeping-0022': {
			return 22;
		}
		case 'upgrade-sleeping-0024': {
			return 24;
		}
		case 'upgrade-sleeping-0031': {
			return 31;
		}
		default: {
			return;
		}
	}
}

export class CupboardServer extends DurableObject<FixtureEnvironment> {
	private seed(tenant: z.infer<typeof seedRequestSchema>['tenant']): void {
		const sleepingWatermark = sleepingMigrationIndex(tenant);
		applyHistoricalMigrations(
			this.ctx.storage,
			sleepingWatermark ?? predecessorMigrationIndex
		);

		if (sleepingWatermark !== undefined) {
			return;
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO tenant_identity (id, tenant, issuer, audience, owner_issuer, owner_subject, owner_audience, config_version)
			 VALUES ('singleton', ?, 'cupboard', 'cupboard', 'https://issuer.invalid', 'owner', 'owner-client', 1)
			 ON CONFLICT (id) DO NOTHING`,
			tenant
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO cache (name, priority, grace_managed, created_at) VALUES
			 ('', 40, 1, ?),
			 ('builds', 30, 1, ?),
			 ('private/secrets', 20, 1, ?)
			 ON CONFLICT (name) DO NOTHING`,
			createdAt,
			createdAt,
			createdAt
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_policy (id, scope, pattern, default_ttl_seconds, created_at) VALUES
			 ('cache-default', 'cache', '', 1209600, ?),
			 ('cache-builds', 'cache', 'builds', 604800, ?),
			 ('root-pr', 'root-name-prefix', 'pr/', 86400, ?)
			 ON CONFLICT (id) DO NOTHING`,
			createdAt,
			createdAt,
			createdAt
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES
			 ('all', '', 3600, ?),
			 ('builds', 'builds', 7200, ?)
			 ON CONFLICT (id) DO NOTHING`,
			createdAt,
			createdAt
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_root (cache, name, expires_at, created_at, updated_at) VALUES
			 ('builds', 'permanent', NULL, ?, ?),
			 ('builds', 'expiring', ?, ?, ?)
			 ON CONFLICT (cache, name) DO NOTHING`,
			createdAt,
			createdAt,
			future,
			createdAt,
			createdAt
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, sigs_json, created_at)
			 VALUES ('builds', ?, ?, ?, 16, '[]', '[]', ?)
			 ON CONFLICT (cache, store_path_hash) DO NOTHING`,
			pathHash,
			storePath,
			narHash,
			createdAt
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_root_target (cache, root_name, store_path_hash, store_path)
			 VALUES ('builds', 'permanent', ?, ?)
			 ON CONFLICT (cache, root_name, store_path_hash) DO NOTHING`,
			pathHash,
			storePath
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_grace (cache, store_path_hash, retain_until)
			 VALUES ('builds', ?, ?)
			 ON CONFLICT (cache, store_path_hash) DO NOTHING`,
			pathHash,
			future
		);
	}

	private lateWrite(): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO retention_root (cache, name, expires_at, created_at, updated_at)
			 VALUES ('builds', 'late-write', ?, ?, ?)
			 ON CONFLICT (cache, name) DO NOTHING`,
			future,
			createdAt,
			createdAt
		);
	}

	private snapshot(): {
		readonly migrationTags: readonly string[];
		readonly caches: readonly string[];
		readonly roots: readonly string[];
	} {
		return {
			migrationTags: Array.from(
				this.ctx.storage.sql.exec(
					'SELECT hash FROM __drizzle_migrations ORDER BY created_at, id'
				),
				(row) => migrationTagRowSchema.parse(row).hash
			),
			caches: Array.from(
				this.ctx.storage.sql.exec('SELECT name FROM cache ORDER BY name'),
				(row) => nameRowSchema.parse(row).name
			),
			roots: Array.from(
				this.ctx.storage.sql.exec(
					'SELECT name FROM retention_root ORDER BY name'
				),
				(row) => nameRowSchema.parse(row).name
			)
		};
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/fixture/seed') {
			const input: unknown = await request.json();
			const { tenant } = seedRequestSchema.parse(input);

			this.seed(tenant);

			return json({ tenant, seeded: true });
		}

		if (request.method === 'POST' && url.pathname === '/fixture/late-write') {
			this.lateWrite();

			return json({ written: true });
		}

		if (request.method === 'GET' && url.pathname === '/fixture/snapshot') {
			return json(this.snapshot());
		}

		return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
	}
}

export default {
	fetch(request: Request): Response {
		if (new URL(request.url).pathname === '/_health') {
			return new Response('ok\n');
		}

		return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
	}
};
