import type { TenantId } from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import type { ServerContext } from '../do/context.ts';

type LocalContractPhase =
	| 'pending'
	| 'bookmark-recorded'
	| 'contracting'
	| 'restoration-scheduled'
	| 'restored-awaiting-verification'
	| 'complete'
	| 'terminal-failure';

export interface LocalContractRecord {
	readonly phase: LocalContractPhase;
	readonly preContractBookmark?: string;
	readonly restoreUndoBookmark?: string;
}

export interface LocalContractLedger {
	isRequired(): Promise<boolean>;
	loadOrCreate(): Promise<LocalContractRecord>;
	recordBookmark(bookmark: string): Promise<LocalContractRecord>;
	markContracting(): Promise<LocalContractRecord>;
	markRestored(): Promise<LocalContractRecord>;
	scheduleRestore(undoBookmark: string, failure: unknown): Promise<void>;
	markComplete(): Promise<void>;
	markTerminalFailure(failure: unknown): Promise<void>;
}

export interface LocalContractPitr {
	getCurrentBookmark(): Promise<string>;
	scheduleRestore(bookmark: string): Promise<string>;
	abort(reason: string): never;
}

export interface LocalContractMigrationOptions {
	readonly ledger: LocalContractLedger;
	readonly pitr: LocalContractPitr;
	readonly isRestored: () => boolean;
	readonly applyContract: () => void;
}

export class LocalContractMigrationFailedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'LocalContractMigrationFailedError';
	}
}

function storedFailure(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);

	return JSON.stringify({
		code: 'LOCAL_CONTRACT_FAILED',
		detail: detail.slice(0, 1024)
	});
}

/**
 * Applies the tenant-local contract after its recovery bookmark is durable in
 * D1. A failed contract schedules restoration before the object admits another
 * event. The next session retries the idempotent contract from the restored
 * local database.
 */
export async function runLocalContractMigration(
	options: LocalContractMigrationOptions
): Promise<void> {
	if (!(await options.ledger.isRequired())) {
		options.applyContract();

		return;
	}

	let record = await options.ledger.loadOrCreate();

	if (record.phase === 'complete') {
		return;
	}

	if (record.phase === 'terminal-failure') {
		throw new LocalContractMigrationFailedError(
			'The tenant-local storage contract has a terminal migration failure'
		);
	}

	if (record.phase === 'restoration-scheduled') {
		if (!options.isRestored()) {
			const error = new LocalContractMigrationFailedError(
				'The Durable Object did not restore its pre-contract local schema'
			);
			await options.ledger.markTerminalFailure(error);

			throw error;
		}

		record = await options.ledger.markRestored();
	}

	if (record.phase === 'pending') {
		const bookmark = await options.pitr.getCurrentBookmark();
		record = await options.ledger.recordBookmark(bookmark);

		if (record.preContractBookmark !== bookmark) {
			throw new LocalContractMigrationFailedError(
				'D1 did not retain the Durable Object recovery bookmark'
			);
		}
	}

	if (
		record.phase === 'bookmark-recorded' ||
		record.phase === 'restored-awaiting-verification'
	) {
		record = await options.ledger.markContracting();
	}

	if (record.phase !== 'contracting') {
		throw new LocalContractMigrationFailedError(
			`The tenant-local storage contract cannot continue from ${record.phase}`
		);
	}

	try {
		options.applyContract();
	} catch (error) {
		const bookmark = record.preContractBookmark;

		if (bookmark === undefined) {
			await options.ledger.markTerminalFailure(error);

			throw new LocalContractMigrationFailedError(
				'The tenant-local storage contract failed without a recovery bookmark',
				{ cause: error }
			);
		}

		let undoBookmark: string;

		try {
			undoBookmark = await options.pitr.scheduleRestore(bookmark);
		} catch (restoreError) {
			await options.ledger.markTerminalFailure(restoreError);

			throw new LocalContractMigrationFailedError(
				'The tenant-local storage contract failed and restoration could not be scheduled',
				{ cause: restoreError }
			);
		}

		await options.ledger.scheduleRestore(undoBookmark, error);
		options.pitr.abort('tenant-local storage restoration');
	}

	await options.ledger.markComplete();
}

class D1LocalContractLedger implements LocalContractLedger {
	constructor(
		private readonly context: ServerContext,
		private readonly tenant: TenantId
	) {}

	private async requireRecord(): Promise<LocalContractRecord> {
		const head = await this.context.d1
			.select({
				artifactId: d1Schema.deploymentHead.artifactId,
				instanceId: d1Schema.deploymentHead.instanceId
			})
			.from(d1Schema.deploymentHead)
			.where(eq(d1Schema.deploymentHead.id, 'current'))
			.get();

		if (head === undefined) {
			throw new LocalContractMigrationFailedError(
				'Tenant-local contract admission requires a current deployment head'
			);
		}

		const record = await this.context.d1
			.select({
				phase: d1Schema.localContractMigration.phase,
				preContractBookmark:
					d1Schema.localContractMigration.preContractBookmark,
				restoreUndoBookmark: d1Schema.localContractMigration.restoreUndoBookmark
			})
			.from(d1Schema.localContractMigration)
			.where(
				and(
					eq(d1Schema.localContractMigration.artifactId, head.artifactId),
					eq(d1Schema.localContractMigration.instanceId, head.instanceId),
					eq(d1Schema.localContractMigration.tenant, this.tenant)
				)
			)
			.get();

		if (record === undefined) {
			throw new LocalContractMigrationFailedError(
				'D1 did not retain the tenant-local contract record'
			);
		}

		return {
			phase: record.phase,
			...(record.preContractBookmark !== null && {
				preContractBookmark: record.preContractBookmark
			}),
			...(record.restoreUndoBookmark !== null && {
				restoreUndoBookmark: record.restoreUndoBookmark
			})
		};
	}

	private async updatePhase(
		expected: LocalContractPhase,
		values: Partial<typeof d1Schema.localContractMigration.$inferInsert>
	): Promise<void> {
		const head = await this.context.d1
			.select({
				artifactId: d1Schema.deploymentHead.artifactId,
				instanceId: d1Schema.deploymentHead.instanceId
			})
			.from(d1Schema.deploymentHead)
			.where(eq(d1Schema.deploymentHead.id, 'current'))
			.get();

		if (head === undefined) {
			throw new LocalContractMigrationFailedError(
				'Tenant-local contract admission requires a current deployment head'
			);
		}

		const result = await this.context.d1
			.update(d1Schema.localContractMigration)
			.set({
				...values,
				admissionRevision: sql`${d1Schema.localContractMigration.admissionRevision} + 1`,
				updatedAt: isoTimestampSchema.parse(new Date().toISOString())
			})
			.where(
				and(
					eq(d1Schema.localContractMigration.artifactId, head.artifactId),
					eq(d1Schema.localContractMigration.instanceId, head.instanceId),
					eq(d1Schema.localContractMigration.tenant, this.tenant),
					eq(d1Schema.localContractMigration.phase, expected)
				)
			)
			.run();

		if (result.meta.changes !== 1) {
			throw new LocalContractMigrationFailedError(
				`Tenant-local contract phase ${expected} changed concurrently`
			);
		}
	}

	async isRequired(): Promise<boolean> {
		const control = await this.context.d1
			.select({
				admission:
					d1Schema.deploymentRuntimeControl.tenantLocalContractAdmission
			})
			.from(d1Schema.deploymentRuntimeControl)
			.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
			.get();

		return control?.admission === 'required';
	}

	async loadOrCreate(): Promise<LocalContractRecord> {
		const head = await this.context.d1
			.select({
				artifactId: d1Schema.deploymentHead.artifactId,
				instanceId: d1Schema.deploymentHead.instanceId
			})
			.from(d1Schema.deploymentHead)
			.where(eq(d1Schema.deploymentHead.id, 'current'))
			.get();

		if (head === undefined) {
			throw new LocalContractMigrationFailedError(
				'Tenant-local contract admission requires a current deployment head'
			);
		}

		const now = isoTimestampSchema.parse(new Date().toISOString());

		await this.context.d1
			.insert(d1Schema.localContractMigration)
			.values({
				artifactId: head.artifactId,
				instanceId: head.instanceId,
				tenant: this.tenant,
				phase: 'pending',
				admission: 'closed',
				updatedAt: now
			})
			.onConflictDoNothing();

		return this.requireRecord();
	}

	async recordBookmark(bookmark: string): Promise<LocalContractRecord> {
		await this.updatePhase('pending', {
			phase: 'bookmark-recorded',
			preContractBookmark: bookmark
		});

		return this.requireRecord();
	}

	async markContracting(): Promise<LocalContractRecord> {
		const record = await this.requireRecord();

		if (
			record.phase !== 'bookmark-recorded' &&
			record.phase !== 'restored-awaiting-verification'
		) {
			return record;
		}

		await this.updatePhase(record.phase, { phase: 'contracting' });

		return this.requireRecord();
	}

	async markRestored(): Promise<LocalContractRecord> {
		await this.updatePhase('restoration-scheduled', {
			phase: 'restored-awaiting-verification'
		});

		return this.requireRecord();
	}

	async scheduleRestore(undoBookmark: string, failure: unknown): Promise<void> {
		await this.updatePhase('contracting', {
			phase: 'restoration-scheduled',
			restoreUndoBookmark: undoBookmark,
			lastFailureJson: storedFailure(failure)
		});
	}

	async markComplete(): Promise<void> {
		await this.updatePhase('contracting', {
			phase: 'complete',
			admission: 'open'
		});
	}

	async markTerminalFailure(failure: unknown): Promise<void> {
		const record = await this.requireRecord();

		await this.updatePhase(record.phase, {
			phase: 'terminal-failure',
			lastFailureJson: storedFailure(failure)
		});
	}
}

class DurableObjectPitr implements LocalContractPitr {
	constructor(private readonly context: ServerContext) {}

	getCurrentBookmark(): Promise<string> {
		return this.context.ctx.storage.getCurrentBookmark();
	}

	scheduleRestore(bookmark: string): Promise<string> {
		return this.context.ctx.storage.onNextSessionRestoreBookmark(bookmark);
	}

	abort(reason: string): never {
		this.context.ctx.abort(reason);

		throw new LocalContractMigrationFailedError(
			'The Durable Object runtime did not abort the restored session'
		);
	}
}

export function runTenantLocalContractMigration(
	context: ServerContext,
	tenant: TenantId,
	isRestored: () => boolean,
	applyContract: () => void
): Promise<void> {
	return runLocalContractMigration({
		ledger: new D1LocalContractLedger(context, tenant),
		pitr: new DurableObjectPitr(context),
		isRestored,
		applyContract
	});
}
