import {
	nixSha256HashSchema,
	type NixSha256HashString
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq, inArray } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	BatchStatementLimitError,
	causedBy,
	EmptyStatementBatchError,
	StatementAllowanceExceededError,
	StatementParameterLimitError
} from '../errors.ts';
import { d1StatementsPerInvocation } from '../http/http.ts';
import {
	currentServer,
	initialise,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import {
	drainStatementBatches,
	executeChunkedStatement,
	type InspectableBatchItem,
	maxBoundParameters
} from './bulk.ts';
import {
	MaintenanceEligibilityService,
	withMaintenanceEligibility
} from './maintenance-eligibility-service.ts';
import { CupboardServer } from './server.ts';
import {
	enterStatementAllowanceOnDispatch,
	statementsRemaining,
	withStatementAllowance
} from './statement-scope.ts';

const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';

// Each hash contains a fixture number and a row number. Fixtures therefore use
// distinct D1 rows.
function syntheticNarHash(fixture: number, index: number): NixSha256HashString {
	const suffix =
		nixBase32.charAt(fixture) +
		nixBase32.charAt(Math.floor(index / nixBase32.length)) +
		nixBase32.charAt(index % nixBase32.length);

	return nixSha256HashSchema.parse(`sha256:${'0'.repeat(49)}${suffix}`);
}

interface BlobStateValues {
	readonly narHash: NixSha256HashString;
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
	readonly compression: 'zstd';
	readonly narSize: number;
	readonly verifiedAt: IsoTimestamp;
}

function blobStateValues(narHash: NixSha256HashString): BlobStateValues {
	return {
		narHash,
		fileHash: narHash,
		fileSize: 1,
		compression: 'zstd',
		narSize: 1,
		verifiedAt: isoTimestamp(new Date())
	};
}

/**
 * Runs `body` against the tenant Durable Object's own D1 binding, which is the
 * bounded binding the services use.
 */
async function withTenantD1<T>(
	server: string,
	body: (d1: DrizzleD1Database<typeof d1Schema>) => Promise<T>
): Promise<T> {
	await useTestServer(server);
	await initialise();

	return runInDurableObject(currentServer(), (instance) =>
		body(instance.context.d1)
	);
}

type BlobStateBatch = (
	d1: DrizzleD1Database<typeof d1Schema>,
	chunk: readonly NixSha256HashString[]
) => readonly InspectableBatchItem[];

/**
 * Drains `hashes` through `buildBatch` under an allowance of `allowance`
 * statements.
 *
 * Reports the processed prefix and the `blob_state` rows inserted by the
 * batches. Tests compare the reported work with the resulting D1 rows.
 */
async function driveDrain(
	server: string,
	hashes: readonly NixSha256HashString[],
	allowance: number,
	buildBatch: BlobStateBatch
): Promise<{
	readonly processed: readonly NixSha256HashString[];
	readonly written: readonly NixSha256HashString[];
}> {
	return withTenantD1(server, async (d1) => {
		const processed = await withStatementAllowance(
			async () =>
				drainStatementBatches(d1, hashes, (chunk) => buildBatch(d1, chunk)),
			allowance
		);
		const rows = await d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(inArray(d1Schema.blobState.narHash, [...hashes]))
			.orderBy(d1Schema.blobState.narHash)
			.all();

		return { processed, written: rows.map((row) => row.narHash) };
	});
}

describe('D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('refuses the statement that would take the invocation past its allowance', async () => {
		const refusal = await withTenantD1('allowance-refusal', async (d1) =>
			withStatementAllowance(async () => {
				await d1.select({ id: d1Schema.tenant.id }).from(d1Schema.tenant).all();
				const remainingAfterFirst = statementsRemaining();

				try {
					await d1
						.select({ id: d1Schema.tenant.id })
						.from(d1Schema.tenant)
						.all();

					return { remainingAfterFirst, refused: undefined };
				} catch (error) {
					const refusal = causedBy(error, StatementAllowanceExceededError);

					return {
						remainingAfterFirst,
						refused:
							refusal === undefined
								? error
								: {
										subject: refusal.subject,
										statements: refusal.statements,
										available: refusal.available
									}
					};
				}
			}, 1)
		);

		expect(refusal).toStrictEqual({
			remainingAfterFirst: 0,
			// Drizzle reads a projected select through the statement's `raw`
			// terminal, which is the call the allowance refuses.
			refused: { subject: 'd1.raw', statements: 1, available: 0 }
		});
	});

	it('does not run any statement from a batch larger than the remaining allowance', async () => {
		const hashes = [0, 1, 2].map((index) => syntheticNarHash(1, index));
		const written = await withTenantD1('allowance-batch', async (d1) => {
			const [first, ...rest] = hashes.map((narHash) =>
				d1.insert(d1Schema.blobState).values(blobStateValues(narHash))
			);

			if (first === undefined) {
				throw new Error('The fixture built no insert statements.');
			}

			const refused = await withStatementAllowance(async () => {
				try {
					await d1.batch([first, ...rest]);

					return;
				} catch (error) {
					const refusal = causedBy(error, StatementAllowanceExceededError);

					return refusal === undefined
						? error
						: {
								subject: refusal.subject,
								statements: refusal.statements,
								available: refusal.available
							};
				}
			}, 2);
			const rows = await d1
				.select({ narHash: d1Schema.blobState.narHash })
				.from(d1Schema.blobState)
				.where(inArray(d1Schema.blobState.narHash, hashes))
				.all();

			return { refused, rowsWritten: rows.length };
		});

		expect(written).toStrictEqual({
			refused: { subject: 'd1.batch', statements: 3, available: 2 },
			rowsWritten: 0
		});
	});

	it('refuses a statement that binds more parameters than the platform accepts', async () => {
		const hashes = Array.from({ length: maxBoundParameters + 1 }, (_, index) =>
			syntheticNarHash(2, index)
		);
		const refused = await withTenantD1('allowance-parameters', async (d1) => {
			try {
				await d1
					.select({ narHash: d1Schema.blobState.narHash })
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, hashes))
					.all();

				return;
			} catch (error) {
				const refusal = causedBy(error, StatementParameterLimitError);

				return refusal === undefined
					? error
					: { parameters: refusal.parameters, limit: refusal.limit };
			}
		});

		expect(refused).toStrictEqual({
			parameters: maxBoundParameters + 1,
			limit: maxBoundParameters
		});
	});

	it('narrows a chunked statement to the parameter limit and stops on the allowance', async () => {
		const hashes = Array.from({ length: 250 }, (_, index) =>
			syntheticNarHash(3, index)
		);
		const read = await withTenantD1('allowance-chunked', async (d1) =>
			withStatementAllowance(async () => {
				const outcome = await executeChunkedStatement(hashes, (chunk) =>
					d1
						.select({ narHash: d1Schema.blobState.narHash })
						.from(d1Schema.blobState)
						.where(inArray(d1Schema.blobState.narHash, [...chunk]))
				);

				return {
					processed: outcome.processed.length,
					statements: outcome.results.length,
					remaining: statementsRemaining()
				};
			}, 2)
		);

		// Each chunk binds one parameter for each hash, so it is as wide as the
		// parameter limit. Two statements cover two of those chunks and the rest of
		// the list is left for a later invocation.
		expect(read).toStrictEqual({
			processed: 2 * maxBoundParameters,
			statements: 2,
			remaining: 0
		});
	});

	it('narrows a batch chunk until the allowance covers its statements', async () => {
		const hashes = [0, 1, 2].map((index) => syntheticNarHash(4, index));
		const drained = await driveDrain(
			'drain-narrowing',
			hashes,
			2,
			(d1, chunk) =>
				chunk.map((narHash) =>
					d1.insert(d1Schema.blobState).values(blobStateValues(narHash))
				)
		);

		// A batch for all three hashes needs three statements and the allowance
		// covers two. The chunk narrows to two hashes, and the third is left for
		// a later invocation.
		expect(drained).toStrictEqual({
			processed: hashes.slice(0, 2),
			written: hashes.slice(0, 2)
		});
	});

	it('runs a chunk width that fits when both a wider and a narrower one do not', async () => {
		const hashes = [0, 1, 2].map((index) => syntheticNarHash(8, index));
		const drained = await driveDrain(
			'drain-skipped-width',
			hashes,
			1,
			(d1, chunk) => {
				if (chunk.length === 1) {
					return chunk.flatMap((narHash) => [
						d1.insert(d1Schema.blobState).values(blobStateValues(narHash)),
						d1
							.update(d1Schema.blobState)
							.set({ narSize: 2 })
							.where(eq(d1Schema.blobState.narHash, narHash))
					]);
				}

				if (chunk.length === 2) {
					return [
						d1
							.insert(d1Schema.blobState)
							.values(chunk.map((narHash) => blobStateValues(narHash)))
					];
				}

				return chunk.map((narHash) =>
					d1.insert(d1Schema.blobState).values(blobStateValues(narHash))
				);
			}
		);

		// The batch for all three hashes needs three statements and the allowance
		// covers one. Two hashes go into a single multi-row insert, which the
		// allowance covers, so the drain measures that width and runs it. The
		// third hash alone needs two statements, but the allowance is exhausted, so
		// that hash stays queued.
		expect(drained).toStrictEqual({
			processed: hashes.slice(0, 2),
			written: hashes.slice(0, 2)
		});
	});

	it('leaves the work queued when the current allowance is short of the batch', async () => {
		const hashes = [syntheticNarHash(5, 0)];
		const drained = await driveDrain('drain-short', hashes, 1, (d1, chunk) =>
			chunk.flatMap((narHash) => [
				d1.insert(d1Schema.blobState).values(blobStateValues(narHash)),
				d1
					.update(d1Schema.blobState)
					.set({ narSize: 2 })
					.where(eq(d1Schema.blobState.narHash, narHash))
			])
		);

		// One hash is the narrowest chunk possible and its batch needs two
		// statements. The current invocation leaves the hash queued for a later
		// invocation with a fresh allowance.
		expect(drained).toStrictEqual({ processed: [], written: [] });
	});

	it('refuses a batch larger than the per-invocation limit', async () => {
		const narHash = syntheticNarHash(6, 0);
		const refused = await withTenantD1('drain-invocation-limit', async (d1) =>
			withStatementAllowance(async () => {
				try {
					await drainStatementBatches(d1, [narHash], (chunk) =>
						chunk.flatMap((hash) =>
							Array.from({ length: d1StatementsPerInvocation + 1 }, () =>
								d1.insert(d1Schema.blobState).values(blobStateValues(hash))
							)
						)
					);

					return;
				} catch (error) {
					const refusal = causedBy(error, BatchStatementLimitError);

					return refusal === undefined
						? error
						: { statements: refusal.statements, limit: refusal.limit };
				}
			})
		);

		expect(refused).toStrictEqual({
			statements: d1StatementsPerInvocation + 1,
			limit: d1StatementsPerInvocation
		});
	});

	it('refuses a batch builder that produces no statements', async () => {
		const narHash = syntheticNarHash(7, 0);
		const refused = await withTenantD1('drain-empty-batch', async (d1) =>
			withStatementAllowance(async () => {
				try {
					await drainStatementBatches(d1, [narHash], () => []);

					return;
				} catch (error) {
					const refusal = causedBy(error, EmptyStatementBatchError);

					return refusal === undefined ? error : { items: refusal.items };
				}
			})
		);

		expect(refused).toStrictEqual({ items: 1 });
	});
});

/**
 * Runs a maintenance body that spends every statement it is allowed, inside the
 * eligibility wrapper and with reconciliation failing.
 *
 * Reports the statement count when the binding refused the body, the available
 * allowance reported by the error, and the allowance left after the wrapper
 * completes its failure path.
 */
async function driveExhaustingMaintenanceBody(server: string): Promise<{
	readonly bodyStatements: number;
	readonly refusedAvailable: number | undefined;
	readonly remainingAfterEligibility: number;
}> {
	await useTestServer(server);
	await initialise();

	return runInDurableObject(currentServer(), async (instance) => {
		const d1 = instance.context.d1;
		const eligibility = new MaintenanceEligibilityService(instance.context);
		const reconcile = vi
			.spyOn(eligibility, 'reconcile')
			.mockRejectedValue(new Error('simulated eligibility outage'));
		// The same failure path the Durable Object uses: a reconciliation that
		// fails invalidates the projection instead, so the tenant stays due.
		const reconcileWithFallback = async (): Promise<void> => {
			try {
				await eligibility.reconcile();
			} catch {
				await eligibility.invalidate();
			}
		};

		try {
			return await withStatementAllowance(async () => {
				let bodyStatements = 0;
				let refusedAvailable: number | undefined;

				await withMaintenanceEligibility(
					eligibility,
					reconcileWithFallback,
					async () => {
						// Bound the loop so a broken binding cannot make the test hang.
						// If the binding does not charge the reads, the result reports a
						// full loop without a refusal.
						for (
							let attempt = 0;
							attempt < d1StatementsPerInvocation;
							attempt += 1
						) {
							try {
								await d1
									.select({ id: d1Schema.tenant.id })
									.from(d1Schema.tenant)
									.all();
								bodyStatements += 1;
							} catch (error) {
								refusedAvailable = causedBy(
									error,
									StatementAllowanceExceededError
								)?.available;

								return;
							}
						}
					}
				);

				return {
					bodyStatements,
					refusedAvailable,
					remainingAfterEligibility: statementsRemaining()
				};
			});
		} finally {
			reconcile.mockRestore();
		}
	});
}

describe('maintenance eligibility reservation', () => {
	beforeEach(resetTestServer);

	it('reserves the statements required by the eligibility failure path', async () => {
		const driven = await driveExhaustingMaintenanceBody(
			'allowance-eligibility'
		);

		// One statement invalidates the projection before the body. The body may
		// then spend everything except the two reserved by the wrapper. The binding
		// refuses the next statement when only the reserve remains. Reconciliation
		// fails without running a statement here, so its fallback invalidation
		// spends one of the two and one is left over.
		expect(driven).toStrictEqual({
			bodyStatements: d1StatementsPerInvocation - 3,
			refusedAvailable: 0,
			remainingAfterEligibility: 1
		});
	});
});

/**
 * The methods the runtime can dispatch to on the tenant Durable Object.
 *
 * The test reads the prototype so newly added methods appear without a manual
 * update to this list.
 */
function dispatchedMethods(prototype: object): readonly string[] {
	return Object.getOwnPropertyNames(prototype)
		.filter((property) => property !== 'constructor')
		.filter(
			(property) =>
				typeof Object.getOwnPropertyDescriptor(prototype, property)?.value ===
				'function'
		);
}

function methodSource(prototype: object, property: string): string {
	const method: unknown = Object.getOwnPropertyDescriptor(
		prototype,
		property
	)?.value;

	return typeof method === 'function' ? String(method) : '';
}

/**
 * The source produced after applying the dispatch wrapper to a sample method.
 * The test compares this source with each Durable Object method, so method and
 * wrapper renames do not require a separate list.
 */
function wrappedMethodSource(): string {
	const sample = {
		method(): void {
			// The body does not matter: only the wrapper's own source is compared.
		}
	};
	enterStatementAllowanceOnDispatch(sample);

	return methodSource(sample, 'method');
}

describe('dispatch coverage', () => {
	it('applies a statement allowance to every dispatchable method', () => {
		const prototype: object = CupboardServer.prototype;
		const wrapped = wrappedMethodSource();
		const methods = dispatchedMethods(prototype);
		const unmetered = methods.filter(
			(property) => methodSource(prototype, property) !== wrapped
		);

		// A method added to the Durable Object that the prototype wrapper never
		// touched would run unmetered, and would appear here.
		expect({
			unmetered,
			counted: methods.length > 20
		}).toStrictEqual({ unmetered: [], counted: true });
	});

	it('runs a dispatched method with the allowance in force', async () => {
		await useTestServer('allowance-dispatch');
		await initialise();

		// A verification pass sizes its page from the allowance, which throws when
		// none is in force. Reaching the end of the pass is the proof that the
		// dispatch wrapper opened one.
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.runVerification()
			)
		).resolves.toBeUndefined();
	});
});
