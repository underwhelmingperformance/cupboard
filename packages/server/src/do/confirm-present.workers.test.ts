import { startCapture } from '@cupboard/logger/testing';
import {
	firstCacheGeneration,
	graceSecondsSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	acceptCapabilitiesHeader,
	confirmPresentCapability,
	publicationCapability,
	publicationRefusalReasonsCapability,
	type UploadAttachRootInput,
	uploadCapabilitiesHeader,
	type UploadConfirmPresentRequest,
	type UploadConfirmPresentRequestInput,
	uploadConfirmPresentRequestSchema,
	type UploadConfirmPresentResponse,
	uploadConfirmPresentResponseSchema,
	type UploadPathMetadata,
	uploadPlanResponseSchema,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	CacheClosedError,
	PublicationConflictError,
	TenantUsageMissingError,
	UploadRequestLimitExceededError
} from '../errors.ts';
import {
	adminGrants,
	authorisedFetch,
	cacheWriteGrants,
	closeSessionAndWait,
	currentNarObjectKey,
	currentOrigin,
	currentServer,
	defaultCache,
	deletePath,
	drivenDirectly,
	initialise,
	issueServerSignedToken,
	listRootTargets,
	narBytes,
	nixSha256Hash,
	openCommitSession,
	pushPath,
	pushSharedNarPaths,
	removeRoot,
	resetTestServer,
	resolvedCache,
	restartTestServers,
	runGcResult,
	seedReservedNarInfo,
	setRoot,
	syntheticStorePathHash,
	testBase,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	withDeployedSubrequestAllowance
} from '../test-support.ts';

import { CacheRegistrationService } from './cache-registration-service.ts';
import { ConfirmationService } from './confirmation-service.ts';
import { type ServerContext } from './context.ts';
import { SectionSubrequests } from './deadline.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { noCost } from './operation-cost.test-support.ts';
import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { withRowBudget } from './row-budget.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

const runRoot = rootNameSchema.parse('run');
const firstDeadline = '2026-01-01T01:00:00.000Z';
const confirmedDeadline = '2026-01-01T02:00:00.000Z';

function at(time: string): void {
	vi.setSystemTime(new Date(`2026-01-01T${time}Z`));
}

function presentPath(index: number): UploadPathMetadata {
	return uploadMetadata({
		fileSize: narBytes.byteLength,
		storePathHash: syntheticStorePathHash(index),
		name: `present-${String(index)}`
	});
}

type DeclaredPath = UploadConfirmPresentRequestInput['paths'][number];

interface Refused {
	readonly body: unknown;
	readonly grants: AuthorizationDetails;
}

interface ProbeChange {
	readonly change: string;
	readonly before: (path: UploadPathMetadata) => Promise<void>;
	readonly during: (
		context: ServerContext,
		path: UploadPathMetadata
	) => Promise<void>;
	readonly outcome: unknown;
}

function declared(path: UploadPathMetadata): DeclaredPath {
	return {
		storePathHash: path.storePathHash,
		storePath: path.storePath,
		narHash: path.narHash
	};
}

function request(
	paths: readonly DeclaredPath[],
	attachRoot?: UploadConfirmPresentRequestInput['attachRoot']
): UploadConfirmPresentRequest {
	return uploadConfirmPresentRequestSchema.parse({
		cacheGeneration: firstCacheGeneration,
		paths,
		...(attachRoot !== undefined && { attachRoot })
	});
}

function confirmedPath(path: UploadPathMetadata) {
	return {
		storePathHash: path.storePathHash,
		status: 'confirmed',
		generation: 0,
		narHash: path.narHash,
		grace: { retainUntil: confirmedDeadline }
	};
}

async function setDefaultCacheGrace(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.update(schema.cacheIdentities)
			.set({ graceSeconds: graceSecondsSchema.parse(3600) })
			.where(eq(schema.cacheIdentities.id, resolvedCache(instance.context).id))
			.run();
	});
}

// Publishes paths that share one NAR. The first path uploads the NAR, and the
// rest reuse it through one commit session.
async function servedPaths(count: number): Promise<UploadPathMetadata[]> {
	const token = await initialise();
	const paths = Array.from({ length: count }, (_, index) => presentPath(index));
	await pushSharedNarPaths(token, paths);

	return paths;
}

async function servedPath(): Promise<UploadPathMetadata> {
	const [path] = await servedPaths(1);
	if (path === undefined) {
		throw new Error('Expected a served path');
	}
	return path;
}

function confirmationService(
	context: ServerContext,
	narInfoObjects = new NarInfoObjectsService(context)
): ConfirmationService {
	const retention = new RetentionService(context);
	const roots = new RootsService(
		context,
		new CacheRegistrationService(context),
		retention,
		narInfoObjects
	);

	return new ConfirmationService(context, narInfoObjects, retention, roots);
}

function confirmationServiceFor(context: ServerContext): ConfirmationService {
	return drivenDirectly(confirmationService(context));
}

// Runs a confirmation and returns its response, or the name and fields of the
// error that refused it.
async function confirmationOutcome(
	confirm: () => Promise<UploadConfirmPresentResponse>
): Promise<unknown> {
	try {
		return { response: await confirm() };
	} catch (error) {
		if (error instanceof PublicationConflictError) {
			return { refused: error.name, reason: error.reason };
		}
		if (error instanceof CacheClosedError) {
			return { refused: error.name, cache: error.cache };
		}
		if (error instanceof TenantUsageMissingError) {
			return { refused: error.name, tenant: error.tenant };
		}
		if (error instanceof UploadRequestLimitExceededError) {
			return { refused: error.name, maxPaths: error.maxPaths };
		}
		throw error;
	}
}

// Confirms through the service within one invocation's subrequest slice and
// returns the response with the cost of the confirmation alone.
async function measuredConfirmation(
	body: UploadConfirmPresentRequest,
	subrequests: number = workersInvocationAllowances.free.subrequests
) {
	return runInDurableObject(currentServer(), async (instance) => {
		let cost: OperationCostRecord | undefined;
		const response = await withOperationCost(
			'confirm-present',
			() =>
				withSubrequestSlice(
					() =>
						withRowBudget(() =>
							confirmationService(instance.context).confirmPresent(
								defaultCache(),
								body
							)
						),
					{ subrequests }
				),
			(recorded) => {
				cost = recorded;
			}
		);

		return { response, cost };
	});
}

async function confirmOverHttp(
	body: unknown,
	grants = adminGrants()
): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await authorisedFetch(
		'/uploads/confirm-present',
		await issueServerSignedToken(grants),
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}
	);
	const json: unknown = await response.json();
	if (!response.ok) {
		const refusal = z
			.object({ code: z.string(), status: z.number() })
			.parse(json);
		return {
			status: response.status,
			body: { code: refusal.code, status: refusal.status }
		};
	}

	return {
		status: response.status,
		body: uploadConfirmPresentResponseSchema.parse(json)
	};
}

const requestLineSchema = z.object({ path: z.string() });

async function retirementRevision(): Promise<number> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			instance.context.db
				.select({ revision: schema.managedCacheRetirements.revision })
				.from(schema.managedCacheRetirements)
				.get()?.revision ?? 0
	);
}

async function graceRows() {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.orderBy(schema.retentionGrace.storePathHash)
			.all()
	);
}

async function runRootRows() {
	return runInDurableObject(currentServer(), (instance) => ({
		roots: instance.context.db
			.select({
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt
			})
			.from(schema.retentionRoots)
			.all()
			.map(({ name, expiresAt }) => ({
				name,
				expiresAt: expiresAt ?? 'permanent'
			})),
		targets: instance.context.db
			.select({ storePathHash: schema.retentionRootTargets.storePathHash })
			.from(schema.retentionRootTargets)
			.orderBy(schema.retentionRootTargets.storePathHash)
			.all()
	}));
}

describe('confirming already-present paths', () => {
	beforeEach(async () => {
		await resetTestServer();
		await initialise();
		await setDefaultCacheGrace();
	});

	// The cache has a managed retirement, so the maintenance hook writes when it
	// runs: it increments the retirement revision.
	it.each([
		{
			confirmation: 'repeats an unchanged confirmation',
			arrange: async (path: UploadPathMetadata) => {
				at('00:30:00.000');
				await confirmOverHttp(request([declared(path)]));
				return request([declared(path)]);
			},
			status: StatusCodes.OK,
			revisions: 0,
			cost: { rowsRead: 31, rowsWritten: 0, d1Calls: 3, d1RowsRead: 6 }
		},
		{
			confirmation: 'extends grace',
			arrange: (path: UploadPathMetadata) => {
				at('00:30:00.000');
				return Promise.resolve(request([declared(path)]));
			},
			status: StatusCodes.OK,
			revisions: 1,
			cost: {
				rowsRead: 62,
				rowsWritten: 7,
				d1Calls: 4,
				d1RowsRead: 7,
				d1RowsWritten: 2
			}
		},
		{
			confirmation: 'attaches a run root',
			arrange: (path: UploadPathMetadata) =>
				Promise.resolve(
					request([declared(path)], {
						name: runRoot,
						retention: { kind: 'inherit' }
					})
				),
			status: StatusCodes.OK,
			revisions: 1,
			cost: { rowsRead: 72, rowsWritten: 12, d1Calls: 4, d1RowsRead: 7 }
		},
		{
			confirmation: 'is refused',
			arrange: (path: UploadPathMetadata) =>
				Promise.resolve({ ...request([declared(path)]), cacheGeneration: 2 }),
			status: StatusCodes.CONFLICT,
			revisions: 1,
			cost: { rowsRead: 32, rowsWritten: 2, d1Calls: 2, d1RowsRead: 1 }
		}
	])(
		'runs maintenance after a confirmation only when it $confirmation and changes state',
		async ({ arrange, status, revisions, cost }) => {
			const path = await servedPath();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.managedCacheRetirements)
					.values({
						cacheId: resolvedCache(instance.context).id,
						eligibleAfter: isoTimestamp(new Date('2099-01-01T00:00:00.000Z'))
					})
					.run();
			});
			const body = await arrange(path);
			const before = await retirementRevision();

			const capture = startCapture();
			let response: Response;
			try {
				response = await authorisedFetch(
					'/uploads/confirm-present',
					await issueServerSignedToken(adminGrants()),
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body)
					}
				);
				await response.text();
			} finally {
				capture.stop();
			}
			const line = capture.logs.find(
				(entry) =>
					entry.message === 'request finished' &&
					requestLineSchema.safeParse(entry.properties).data?.path ===
						'/uploads/confirm-present'
			)?.properties;

			expect({
				status: response.status,
				revisions: (await retirementRevision()) - before,
				line
			}).toStrictEqual({
				status,
				revisions,
				line: {
					method: 'POST',
					path: '/uploads/confirm-present',
					route: '/uploads/confirm-present',
					status,
					...noCost,
					d1CallsWithoutRows: 1,
					r2Head: status === StatusCodes.OK ? 2 : 0,
					...cost
				}
			});
		}
	);

	it('confirms a served path with grace and a run-root target', async () => {
		const path = await servedPath();
		at('00:30:00.000');

		const confirmed = await confirmOverHttp(
			request([declared(path)], {
				name: runRoot,
				retention: { kind: 'inherit' }
			})
		);

		expect({
			confirmed,
			grace: await graceRows(),
			run: await runRootRows()
		}).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: { paths: [confirmedPath(path)] }
			},
			grace: [
				{ storePathHash: path.storePathHash, retainUntil: confirmedDeadline }
			],
			run: {
				roots: [{ name: runRoot, expiresAt: 'permanent' }],
				targets: [{ storePathHash: path.storePathHash }]
			}
		});
	});

	it.each([
		{
			state: 'collected',
			arrange: async (path: UploadPathMetadata): Promise<DeclaredPath> => {
				await servedPaths(1);
				await deletePath(await initialise(), path.storePathHash);
				return declared(path);
			},
			d1Calls: 1,
			d1RowsRead: 0,
			r2Head: 0,
			rowsRead: 12
		},
		{
			state: 'reserved',
			arrange: async (path: UploadPathMetadata): Promise<DeclaredPath> => {
				await seedReservedNarInfo(path);
				return declared(path);
			},
			d1Calls: 2,
			d1RowsRead: 2,
			r2Head: 1,
			rowsRead: 18
		},
		{
			state: 'served under another store path',
			arrange: async (path: UploadPathMetadata): Promise<DeclaredPath> => {
				await servedPaths(1);
				return {
					...declared(path),
					storePath: path.storePath.replace('present-0', 'other')
				};
			},
			d1Calls: 1,
			d1RowsRead: 0,
			r2Head: 0,
			rowsRead: 13
		}
	])(
		'answers missing and writes nothing for a path that is $state',
		async ({ arrange, d1Calls, d1RowsRead, r2Head, rowsRead }) => {
			const path = presentPath(0);
			const body = await arrange(path);

			const confirmed = await measuredConfirmation(request([body]));

			expect(confirmed).toStrictEqual({
				response: {
					paths: [{ storePathHash: path.storePathHash, status: 'missing' }]
				},
				cost: {
					...noCost,
					d1Calls,
					d1CallsWithoutRows: 1,
					d1RowsRead,
					r2Head,
					rowsRead
				}
			});
		}
	);

	it("answers diverged with the cache's NAR hash and retains the cache's version", async () => {
		const path = await servedPath();
		at('00:30:00.000');

		const confirmed = await confirmOverHttp(
			request([{ ...declared(path), narHash: nixSha256Hash('x') }])
		);

		expect({ confirmed, grace: await graceRows() }).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: {
					paths: [{ ...confirmedPath(path), status: 'diverged' }]
				}
			},
			grace: [
				{ storePathHash: path.storePathHash, retainUntil: confirmedDeadline }
			]
		});
	});

	it('retains a path past its removed root until the rounded deadline, which never moves earlier', async () => {
		const path = await servedPath();
		await setRoot(await initialise(), {
			name: 'channel',
			targets: [path.storePath]
		});
		at('00:30:00.000');
		const confirmed = await confirmOverHttp(request([declared(path)]));
		at('00:00:00.000');
		const repeated = await confirmOverHttp(request([declared(path)]));
		at('00:30:00.000');
		await removeRoot(await issueServerSignedToken(adminGrants()), 'channel');
		at('01:59:59.999');
		const beforeDeadline = await runGcResult();
		at('02:00:00.001');
		const afterDeadline = await runGcResult();

		const answer = {
			status: StatusCodes.OK,
			body: { paths: [confirmedPath(path)] }
		};
		expect({
			confirmed,
			repeated,
			collected: [beforeDeadline.pathsCollected, afterDeadline.pathsCollected]
		}).toStrictEqual({
			confirmed: answer,
			repeated: answer,
			collected: [0, 1]
		});
	});

	it('attaches every confirmed path to the run root and extends its expiry once', async () => {
		const paths = await servedPaths(2);
		at('00:30:00.000');

		const confirmed = await measuredConfirmation(
			request(
				paths.map((path) => declared(path)),
				{
					name: runRoot,
					retention: { kind: 'duration', seconds: 3600 }
				}
			)
		);
		const listed = await listRootTargets(
			await issueServerSignedToken(adminGrants()),
			'run'
		);
		at('00:50:00.000');
		const repeated = await measuredConfirmation(
			request(
				paths.map((path) => declared(path)),
				{
					name: runRoot,
					retention: { kind: 'duration', seconds: 3600 }
				}
			)
		);

		expect({
			cost: confirmed.cost,
			repeat: repeated.cost,
			run: await runRootRows(),
			listed: listed.targets.map((target) => target.storePathHash)
		}).toStrictEqual({
			cost: {
				...noCost,
				rowsRead: 66,
				rowsWritten: 23,
				d1Calls: 3,
				d1CallsWithoutRows: 1,
				d1RowsRead: 10,
				r2Head: 3
			},
			repeat: {
				...noCost,
				rowsRead: 61,
				d1Calls: 3,
				d1CallsWithoutRows: 1,
				d1RowsRead: 10,
				r2Head: 3
			},
			run: {
				roots: [{ name: runRoot, expiresAt: '2026-01-01T02:00:00.000Z' }],
				targets: paths.map(({ storePathHash }) => ({ storePathHash }))
			},
			listed: paths.map(({ storePathHash }) => storePathHash)
		});
	});

	it('returns the same response to a replay and writes no rows', async () => {
		const paths = await servedPaths(2);
		at('00:30:00.000');
		const body = request(
			paths.map((path) => declared(path)),
			{
				name: runRoot,
				retention: { kind: 'inherit' }
			}
		);

		const first = await measuredConfirmation(body);
		const replay = await measuredConfirmation(body);

		expect(replay).toStrictEqual({
			response: first.response,
			cost: {
				...noCost,
				rowsRead: 63,
				d1Calls: 3,
				d1CallsWithoutRows: 1,
				d1RowsRead: 10,
				r2Head: 3
			}
		});
	});

	it('writes no rows when 200 retained paths are confirmed again on the Paid plan', async () => {
		const paths = await servedPaths(200);
		at('00:30:00.000');
		const body = request(paths.map((path) => declared(path)));

		const paid = workersInvocationAllowances.paid.subrequests;
		const first = await measuredConfirmation(body, paid);
		const repeat = await measuredConfirmation(body, paid);

		const probes = {
			...noCost,
			d1Calls: 3,
			d1CallsWithoutRows: 1,
			d1RowsRead: 802,
			r2Head: 201
		};
		expect({ first: first.cost, repeat: repeat.cost }).toStrictEqual({
			first: { ...probes, rowsRead: 3812, rowsWritten: 1000 },
			repeat: { ...probes, rowsRead: 3212 }
		});
	});

	it('starts no subrequest inside its critical section', async () => {
		const path = await servedPath();
		at('00:30:00.000');

		const observed = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const { context } = instance;
				const started: string[] = [];
				class RecordingSection extends SectionSubrequests {
					override track(operation: string, call: Promise<unknown>): void {
						started.push(operation);
						super.track(operation, call);
					}
				}
				const enter = context.criticalSection.bind(context);
				const section = vi
					.spyOn(context, 'criticalSection')
					.mockImplementation((run) =>
						enter(() => new RecordingSection().run(run))
					);
				try {
					const response = await confirmationServiceFor(context).confirmPresent(
						defaultCache(),
						request([declared(path)])
					);
					return {
						statuses: response.paths.map((entry) => entry.status),
						sections: section.mock.calls.length,
						started
					};
				} finally {
					section.mockRestore();
				}
			}
		);

		expect(observed).toStrictEqual({
			statuses: ['confirmed'],
			sections: 1,
			started: []
		});
	});

	it("answers a released client's commit for a served path with grace and a run-root target", async () => {
		const path = await servedPath();
		at('00:30:00.000');
		const token = await issueServerSignedToken(adminGrants());
		const attachRoot: UploadAttachRootInput = {
			name: runRoot,
			retention: { kind: 'inherit' }
		};
		const metadata = uploadPathNegotiation(path);
		const planned = await authorisedFetch('/uploads/plan', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: [metadata],
				attachRoot
			})
		});
		const plan = uploadPlanResponseSchema.parse(await planned.json());
		const operationId = plan.uploads[0]?.operationId;
		if (operationId === undefined) {
			throw new Error('Expected a planned operation');
		}
		const session = await openCommitSession(
			token,
			defaultCache(),
			`${publicationCapability},${publicationRefusalReasonsCapability}`
		);
		const frames = [];
		try {
			session.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [
					{
						operationId,
						cacheGeneration: plan.cacheGeneration,
						metadata,
						attachRoot
					}
				]
			});
			frames.push(await session.nextFrame(), await session.nextFrame());
		} finally {
			await closeSessionAndWait(session.socket);
		}

		expect({ frames, run: await runRootRows() }).toStrictEqual({
			frames: [
				{ ev: 'publication-accepted', uploadId: operationId },
				{
					ev: 'settled',
					uploadId: operationId,
					response: {
						storePathHash: path.storePathHash,
						narHash: path.narHash,
						status: 'already-present'
					},
					grace: { retainUntil: confirmedDeadline }
				}
			],
			run: {
				roots: [{ name: runRoot, expiresAt: 'permanent' }],
				targets: [{ storePathHash: path.storePathHash }]
			}
		});
	});

	it.each([
		{
			refusal: 'a changed cache generation',
			arrange: (path: UploadPathMetadata): Promise<Refused> =>
				Promise.resolve({
					body: { ...request([declared(path)]), cacheGeneration: 2 },
					grants: adminGrants()
				}),
			code: 'CONFLICT',
			status: StatusCodes.CONFLICT
		},
		{
			refusal: 'a closed cache',
			arrange: async (path: UploadPathMetadata): Promise<Refused> => {
				await runInDurableObject(currentServer(), (instance, state) => {
					state.storage.sql.exec(
						"INSERT INTO managed_cache_retirement(cache_id,eligible_after,retirement_started_at) VALUES (?, '2099-01-01T00:00:00.000Z', ?)",
						resolvedCache(instance.context).id,
						testBase.toISOString()
					);
				});
				return { body: request([declared(path)]), grants: adminGrants() };
			},
			code: 'CACHE_CLOSED',
			status: StatusCodes.CONFLICT
		},
		{
			refusal: 'an offboarding tenant',
			arrange: async (path: UploadPathMetadata): Promise<Refused> => {
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.offboarding = true;
				});
				return { body: request([declared(path)]), grants: adminGrants() };
			},
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		},
		{
			refusal: 'a run root without root:attach',
			arrange: (path: UploadPathMetadata): Promise<Refused> =>
				Promise.resolve({
					body: request([declared(path)], {
						name: runRoot,
						retention: { kind: 'inherit' }
					}),
					grants: cacheWriteGrants()
				}),
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		},
		...['upload:commit', 'upload:negotiate'].map((action) => ({
			refusal: `a token with ${action} alone`,
			arrange: (path: UploadPathMetadata): Promise<Refused> =>
				Promise.resolve({
					body: request([declared(path)]),
					grants: authorizationDetailsSchema.parse([
						{ type: 'cupboard_cache', actions: [action], cache: defaultCache() }
					])
				}),
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		}))
	])('refuses $refusal', async ({ arrange, code, status }) => {
		const path = await servedPath();
		const { body, grants } = await arrange(path);
		at('00:30:00.000');

		const refused = await confirmOverHttp(body, grants);

		expect({ refused, grace: await graceRows() }).toStrictEqual({
			refused: { status, body: { code, status } },
			grace: [{ storePathHash: path.storePathHash, retainUntil: firstDeadline }]
		});
	});

	it('confirms a path whose stored references exceed a bound string once serialised again', async () => {
		const path = await servedPath();
		const references = Array.from(
			{ length: 38_500 },
			(_, index) => `${'0'.repeat(32)}-reference-${String(index)}`
		);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({ referencesJson: JSON.stringify(references) })
				.where(eq(schema.narInfos.storePathHash, path.storePathHash))
				.run();
		});
		at('00:30:00.000');

		const confirmed = await confirmOverHttp(
			request([declared(path)], {
				name: runRoot,
				retention: { kind: 'inherit' }
			})
		);

		expect({
			confirmed,
			grace: await graceRows(),
			run: await runRootRows()
		}).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: { paths: [confirmedPath(path)] }
			},
			grace: [
				{ storePathHash: path.storePathHash, retainUntil: confirmedDeadline }
			],
			run: {
				roots: [{ name: runRoot, expiresAt: 'permanent' }],
				targets: [{ storePathHash: path.storePathHash }]
			}
		});
	});

	it.each<ProbeChange>([
		{
			change: 'its NAR object is removed before the confirmation',
			before: async (path) => {
				await env.BLOBS.delete(await currentNarObjectKey(path.narHash));
			},
			during: noPreparation,
			outcome: 'missing'
		},
		{
			change: 'its row is deleted during the probe',
			before: noPreparation,
			during: (context, path) => {
				context.db
					.delete(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, path.storePathHash))
					.run();
				return Promise.resolve();
			},
			outcome: 'missing'
		},
		{
			change: 'it is recommitted with another NAR during the probe',
			before: noPreparation,
			during: (context, path) => {
				context.db
					.update(schema.narInfos)
					.set({
						generation: sql`${schema.narInfos.generation} + 1`,
						narHash: nixSha256Hash('x')
					})
					.where(eq(schema.narInfos.storePathHash, path.storePathHash))
					.run();
				return Promise.resolve();
			},
			outcome: 'missing'
		},
		{
			change: 'it is recommitted with the same NAR during the probe',
			before: noPreparation,
			during: (context, path) => {
				context.db
					.update(schema.narInfos)
					.set({ generation: sql`${schema.narInfos.generation} + 1` })
					.where(eq(schema.narInfos.storePathHash, path.storePathHash))
					.run();
				return Promise.resolve();
			},
			outcome: 'missing'
		},
		{
			change: 'its narinfo object is demoted during the probe',
			before: noPreparation,
			during: async (context, path) => {
				await env.BLOBS.delete(await currentNarObjectKey(path.narHash));
				await new NarInfoObjectsService(context).demoteUnbacked(
					resolvedCache(context),
					path.storePathHash,
					path.narHash
				);
			},
			outcome: 'missing'
		},
		{
			change: 'its cache is replaced during the probe',
			before: noPreparation,
			during: (context) => {
				context.db
					.update(schema.cacheIdentities)
					.set({ deletedAt: isoTimestamp(new Date()) })
					.where(eq(schema.cacheIdentities.id, resolvedCache(context).id))
					.run();
				return Promise.resolve();
			},
			outcome: {
				refused: 'PublicationConflictError',
				reason: 'generation-conflict'
			}
		},
		{
			change: 'its cache is closed during the probe',
			before: noPreparation,
			during: (context) => {
				context.db
					.insert(schema.managedCacheRetirements)
					.values({
						cacheId: resolvedCache(context).id,
						eligibleAfter: isoTimestamp(new Date('2099-01-01T00:00:00.000Z')),
						retirementStartedAt: isoTimestamp(testBase)
					})
					.run();
				return Promise.resolve();
			},
			outcome: { refused: 'CacheClosedError', cache: defaultCache() }
		}
	])(
		'retains nothing for a path when $change',
		async ({ before, during, outcome }) => {
			const path = await servedPath();
			await before(path);
			at('00:30:00.000');

			const confirmed = await runInDurableObject(
				currentServer(),
				(instance) => {
					const { context } = instance;
					const narInfoObjects = new NarInfoObjectsService(context);
					const probe =
						narInfoObjects.servableNarInfoVersions.bind(narInfoObjects);
					vi.spyOn(
						narInfoObjects,
						'servableNarInfoVersions'
					).mockImplementation(async (cache, hashes) => {
						const versions = await probe(cache, hashes);
						await during(context, path);
						return versions;
					});
					return confirmationOutcome(() =>
						drivenDirectly(
							confirmationService(context, narInfoObjects)
						).confirmPresent(
							defaultCache(),
							request([declared(path)], {
								name: runRoot,
								retention: { kind: 'inherit' }
							})
						)
					);
				}
			);

			expect({
				confirmed,
				grace: await graceRows(),
				run: await runRootRows()
			}).toStrictEqual({
				confirmed:
					outcome === 'missing'
						? {
								response: {
									paths: [
										{ storePathHash: path.storePathHash, status: 'missing' }
									]
								}
							}
						: outcome,
				grace: [
					{ storePathHash: path.storePathHash, retainUntil: firstDeadline }
				],
				run: { roots: [], targets: [] }
			});
		}
	);

	it('refuses a tenant without a usage row, as a commit does', async () => {
		const path = await servedPath();
		const tenant = await runInDurableObject(currentServer(), (instance) =>
			instance.context.requireTenant()
		);
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, tenant))
			.run();
		at('00:30:00.000');

		const confirmed = await runInDurableObject(currentServer(), (instance) =>
			confirmationOutcome(() =>
				confirmationServiceFor(instance.context).confirmPresent(
					defaultCache(),
					request([declared(path)])
				)
			)
		);

		expect({ confirmed, grace: await graceRows() }).toStrictEqual({
			confirmed: { refused: 'TenantUsageMissingError', tenant },
			grace: [{ storePathHash: path.storePathHash, retainUntil: firstDeadline }]
		});
	});

	// Each path has its own NAR and a lost narinfo object, so each needs a
	// repair. With `race`, the row's signing-key generation changes after each
	// repair's write, so the fence after the write repairs the object again.
	it.each([
		{
			race: false,
			cost: {
				...noCost,
				rowsRead: 148,
				rowsWritten: 23,
				d1Calls: 11,
				d1CallsWithoutRows: 9,
				d1RowsRead: 69,
				r2Head: 24,
				r2Put: 4
			}
		},
		{
			race: true,
			cost: {
				...noCost,
				rowsRead: 164,
				rowsWritten: 35,
				d1Calls: 19,
				d1CallsWithoutRows: 17,
				d1RowsRead: 69,
				r2Head: 24,
				r2Put: 8
			}
		}
	])(
		'repairs only the paths that fit the slice in the worst case (race: $race)',
		async ({ race, cost: expectedCost }) => {
			const paths = await repairablePaths();
			at('00:30:00.000');

			const confirmed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const { context } = instance;
					const narInfoObjects = new NarInfoObjectsService(context);
					const cache = resolvedCache(context);
					for (const path of paths) {
						await env.BLOBS.delete(
							narInfoObjects.objectKey(cache, path.storePathHash)
						);
					}
					const put = narInfoObjects.putNarInfoObject.bind(narInfoObjects);
					const raced = new Set<string>();
					vi.spyOn(narInfoObjects, 'putNarInfoObject').mockImplementation(
						async (target, storePathHash, version, narInfo) => {
							await put(target, storePathHash, version, narInfo);
							if (!race || raced.has(storePathHash)) {
								return;
							}
							raced.add(storePathHash);
							context.db
								.update(schema.narInfos)
								.set({
									signatureGeneration: sql`${schema.narInfos.signatureGeneration} + 1`
								})
								.where(eq(schema.narInfos.storePathHash, storePathHash))
								.run();
						}
					);
					let cost: OperationCostRecord | undefined;
					const answer = await withOperationCost(
						'confirm-present',
						() =>
							withSubrequestSlice(
								() =>
									withRowBudget(() =>
										confirmationOutcome(() =>
											confirmationService(
												context,
												narInfoObjects
											).confirmPresent(
												defaultCache(),
												request(paths.map((path) => declared(path)))
											)
										)
									),
								{ subrequests: 63, reserve: 0 }
							),
						(recorded) => {
							cost = recorded;
						}
					);
					const objects = await Promise.all(
						paths.map(
							async (path) =>
								(await env.BLOBS.head(
									narInfoObjects.objectKey(cache, path.storePathHash)
								)) !== null
						)
					);
					return { answer, objects, cost };
				}
			);

			const repaired = 4;
			expect({ ...confirmed, grace: await graceRows() }).toStrictEqual({
				answer: {
					response: {
						paths: paths.map((path, index) =>
							index < repaired
								? confirmedPath(path)
								: { storePathHash: path.storePathHash, status: 'missing' }
						)
					}
				},
				objects: paths.map((_path, index) => index < repaired),
				cost: expectedCost,
				grace: paths.map((path, index) => ({
					storePathHash: path.storePathHash,
					retainUntil: index < repaired ? confirmedDeadline : firstDeadline
				}))
			});
		}
	);

	it.each([
		{
			accepted: `${publicationCapability},${confirmPresentCapability}`,
			echoed: `${publicationCapability},${confirmPresentCapability}`
		},
		{ accepted: confirmPresentCapability, echoed: confirmPresentCapability },
		{ accepted: publicationCapability, echoed: publicationCapability },
		{ accepted: undefined, echoed: 'none' }
	])(
		'echoes $echoed on a credential that accepts $accepted',
		async ({ accepted, echoed }) => {
			const response = await authorisedFetch(
				'/uploads/credential',
				await initialise(),
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(accepted !== undefined && {
							[acceptCapabilitiesHeader]: accepted
						})
					},
					body: '{}'
				}
			);
			await response.body?.cancel();

			expect({
				status: response.status,
				echoed: response.headers.get(uploadCapabilitiesHeader) ?? 'none'
			}).toStrictEqual({ status: StatusCodes.OK, echoed });
		}
	);

	it.each([
		{ plan: 'Free', subrequests: 1000, advertised: '149' },
		{ plan: 'Paid', subrequests: 10_000, advertised: '200' }
	])(
		'advertises $advertised paths on the $plan plan',
		async ({ subrequests, advertised }) => {
			const path = await servedPath();
			const token = await issueServerSignedToken(adminGrants());

			const header = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const response = await withDeployedSubrequestAllowance(
						instance.context,
						subrequests,
						() => instance.fetch(confirmationRequest(token, [path]))
					);
					await response.body?.cancel();
					return {
						status: response.status,
						advertised: response.headers.get(uploadRequestMaxPathsHeader)
					};
				}
			);

			expect(header).toStrictEqual({ status: StatusCodes.OK, advertised });
		}
	);

	it('confirms a full Free-plan page through the request middleware', async () => {
		const paths = await servedPaths(149);
		at('00:30:00.000');
		const token = await issueServerSignedToken(adminGrants());

		const answer = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const response = await withDeployedSubrequestAllowance(
					instance.context,
					workersInvocationAllowances.free.subrequests,
					() => instance.fetch(confirmationRequest(token, paths))
				);
				const body = uploadConfirmPresentResponseSchema.parse(
					await response.json()
				);
				return {
					status: response.status,
					statuses: body.paths.map((entry) => entry.status)
				};
			}
		);

		expect(answer).toStrictEqual({
			status: StatusCodes.OK,
			statuses: paths.map(() => 'confirmed')
		});
	});

	it('confirms a full advertised Free-plan page when a cold start reconciles the cache catalogue', async () => {
		const paths = await servedPaths(149);
		at('00:30:00.000');
		const token = await issueServerSignedToken(adminGrants());
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.update(d1Schema.tenant)
			.set({ cacheCatalogueVersion: sql`null` })
			.run();
		await restartTestServers();

		const answer = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const response = await withDeployedSubrequestAllowance(
					instance.context,
					workersInvocationAllowances.free.subrequests,
					() => instance.fetch(confirmationRequest(token, paths))
				);
				const advertised = response.headers.get(uploadRequestMaxPathsHeader);
				const body: unknown = await response.json();
				return {
					status: response.status,
					advertised,
					statuses: uploadConfirmPresentResponseSchema
						.safeParse(body)
						.data?.paths.map((entry) => entry.status)
				};
			}
		);

		expect(answer).toStrictEqual({
			status: StatusCodes.OK,
			advertised: '149',
			statuses: paths.map(() => 'confirmed')
		});
	});

	it('refuses more paths than the slice can probe', async () => {
		const paths = await repairablePaths();

		const refused = await runInDurableObject(currentServer(), (instance) =>
			withSubrequestSlice(
				() =>
					withRowBudget(() =>
						confirmationOutcome(() =>
							confirmationService(instance.context).confirmPresent(
								defaultCache(),
								request(paths.map((path) => declared(path)))
							)
						)
					),
				{ subrequests: 62, reserve: 0 }
			)
		);

		expect(refused).toStrictEqual({
			refused: 'UploadRequestLimitExceededError',
			maxPaths: 9
		});
	});
});

function confirmationRequest(
	token: string,
	paths: readonly UploadPathMetadata[]
): Request {
	const body = request(paths.map((path) => declared(path)));
	return new Request(new URL('/uploads/confirm-present', currentOrigin()), {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	});
}

// Publishes ten paths, each with its own NAR.
async function repairablePaths(): Promise<UploadPathMetadata[]> {
	const token = await initialise();
	const paths: UploadPathMetadata[] = [];
	for (let index = 0; index < 10; index += 1) {
		const nar = await verifiableNar(`repair-${String(index)}`);
		const path = uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			fileHash: nar.fileHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			storePathHash: syntheticStorePathHash(index),
			name: `repair-${String(index)}`
		});
		await pushPath(token, path, defaultCache(), nar);
		paths.push(path);
	}
	return paths;
}

function noPreparation(): Promise<void> {
	return Promise.resolve();
}
