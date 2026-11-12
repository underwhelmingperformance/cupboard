import { startCapture } from '@cupboard/logger/testing';
import {
	commitEntryResendStatus,
	type CommitSessionFrame,
	type CommitSessionRequestInput,
	publicationCapability,
	type PublicationEntry,
	publicationRefusalReasonsCapability,
	type UploadId,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	type CommitConversation,
	commitUpload,
	currentServer,
	defaultCache,
	expectSingleUploadDecision,
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	syntheticStorePathHash,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	withDeployedSubrequestAllowance
} from '../test-support.ts';

import { maxOutgoingConnections } from './bulk.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { subrequestSliceReserve } from './subrequest-slice.ts';

const publicationSession = `${publicationCapability},${publicationRefusalReasonsCapability}`;

// One uninterrupted entry makes fewer calls than this; a test below checks
// each scenario.
const entryCallBound = 12;

// A slice admits no unit of work within its reserve. An allowance up to the
// reserve therefore stops an entry at its first budget check, or at a call
// before it. An allowance above the reserve stops the entry at whichever
// budget check the remaining calls cannot cover.
const allowances = [
	...Array.from({ length: entryCallBound }, (_unused, calls) => calls),
	...Array.from(
		{ length: entryCallBound },
		(_unused, calls) => subrequestSliceReserve + calls
	)
];

const terminalEvents = new Set<string>([
	'publication-refused',
	'upload-required',
	'settled',
	'deferred',
	'verdict',
	'error'
]);

const messageCostSchema = z.object({
	method: z.string(),
	d1Calls: z.number(),
	r2Head: z.number(),
	r2Get: z.number(),
	r2Put: z.number(),
	r2Delete: z.number(),
	r2List: z.number()
});

const exhaustionWarningSchema = z.object({
	operation: z.string(),
	refusedEntries: z.number()
});

interface PreparedMessage {
	readonly request: CommitSessionRequestInput;
	readonly uploadIds: readonly UploadId[];
	// The answer to each entry, normalised, after a complete run.
	readonly answer: unknown;
	// The stored state after a complete run.
	readonly state: unknown;
}

interface MessageScenario {
	readonly op: CommitSessionRequestInput['op'];
	readonly accepted?: string;
	readonly prepare: (token: string) => Promise<PreparedMessage>;
}

// Replaces upload IDs, which negotiation chooses at random, and drops message
// text.
function normalised(frame: CommitSessionFrame): unknown {
	if (!('uploadId' in frame)) {
		return frame;
	}
	if ('message' in frame) {
		const { message: _message, ...rest } = frame;
		return { ...rest, uploadId: 'upload' };
	}
	return { ...frame, uploadId: 'upload' };
}

// Reads frames until each upload has a frame that answers it. Frames that
// only report progress, such as `publication-accepted`, are skipped.
async function answers(
	conversation: CommitConversation,
	uploadIds: readonly UploadId[]
): Promise<CommitSessionFrame[]> {
	const answered = new Map<string, CommitSessionFrame>();
	while (answered.size < uploadIds.length) {
		const frame = await conversation.nextFrame();
		if (terminalEvents.has(frame.ev) && 'uploadId' in frame) {
			answered.set(frame.uploadId, frame);
		}
	}
	return uploadIds.flatMap((id) => answered.get(id) ?? []);
}

async function stagedNar(seed: string, index: number) {
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		storePathHash: syntheticStorePathHash(index),
		name: seed
	});
	return { nar, metadata };
}

// Plans and stages one fresh path, so the entry runs admission and a commit.
// With `isAcceptedFirst`, a `publish-batch` sent before the bytes are staged
// records the operation and asks for an upload.
async function stagedPublication(
	token: string,
	seed: string,
	index = 1,
	isAcceptedFirst = false
) {
	const { nar, metadata } = await stagedNar(seed, index);
	const response = await authorisedFetch('/uploads/plan', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		})
	});
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const [planned] = plan.uploads;
	if (planned === undefined) {
		throw new Error('Expected a planned entry');
	}
	const entry: PublicationEntry = {
		operationId: planned.operationId,
		cacheGeneration: plan.cacheGeneration,
		metadata: uploadPathNegotiation(metadata),
		blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
	};
	if (isAcceptedFirst) {
		const conversation = await openCommitSession(
			token,
			defaultCache(),
			publicationCapability
		);
		try {
			conversation.send({
				op: 'publish-batch',
				pushId: testPushId,
				entries: [entry]
			});
			const accepted = await answers(conversation, [entry.operationId]);
			expect(accepted.map((frame) => normalised(frame))).toStrictEqual([
				{ ev: 'upload-required', uploadId: 'upload' }
			]);
		} finally {
			conversation.socket.close();
		}
	}
	await putNarBytes(planned.r2Key, nar);
	return { entry, metadata };
}

// Negotiates and stages one fresh path through the legacy protocol.
async function stagedUpload(token: string, seed: string) {
	const { nar, metadata } = await stagedNar(seed, 1);
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	return {
		nar,
		entry: {
			uploadId: upload.uploadId,
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash
		}
	};
}

// The state of a path whose commit has deferred to verification.
function committingState(
	storePathHash: string,
	narHash: string,
	operationId?: string
): unknown {
	return {
		pending: [{ narHash, verdict: 'committing' }],
		operations:
			operationId === undefined ? [] : [{ id: operationId, state: 'accepted' }],
		narInfos: [{ storePathHash, narHash, generation: 0 }],
		references: [],
		usage: [{ bytes: 0, narinfos: 0, blobs: 0 }]
	};
}

async function publicationMessage(
	token: string,
	op: 'publish-batch' | 'subscribe-publication',
	isAcceptedFirst: boolean
): Promise<PreparedMessage> {
	const { entry, metadata } = await stagedPublication(
		token,
		op,
		1,
		isAcceptedFirst
	);
	return {
		request: { op, pushId: testPushId, entries: [entry] },
		uploadIds: [entry.operationId],
		answer: {
			ev: 'deferred',
			uploadId: 'upload',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			grace: {}
		},
		state: committingState(
			metadata.storePathHash,
			metadata.narHash,
			entry.operationId
		)
	};
}

const scenarios: readonly MessageScenario[] = [
	{
		op: 'publish-batch',
		accepted: publicationSession,
		prepare: (token) => publicationMessage(token, 'publish-batch', false)
	},
	{
		// A client without `publication-refusal-reasons` has its subscription
		// admitted and committed, so the subscription writes state.
		op: 'subscribe-publication',
		accepted: publicationCapability,
		prepare: (token) => publicationMessage(token, 'subscribe-publication', true)
	},
	{
		op: 'commit-batch',
		prepare: async (token) => {
			const { entry } = await stagedUpload(token, 'commit-batch');
			return {
				request: { op: 'commit-batch', commits: [entry] },
				uploadIds: [entry.uploadId],
				answer: {
					ev: 'deferred',
					uploadId: 'upload',
					storePathHash: entry.storePathHash,
					narHash: entry.narHash
				},
				state: committingState(entry.storePathHash, entry.narHash)
			};
		}
	},
	{
		// The committed path's narinfo object is missing, so answering the
		// entry repairs the object.
		op: 'subscribe-identity',
		prepare: async (token) => {
			const { nar, entry } = await stagedUpload(token, 'subscribe-identity');
			await commitUpload(token, entry.uploadId);
			await env.BLOBS.delete(
				narInfoObjectKey(fixtureTenant, entry.storePathHash, defaultCache())
			);
			return {
				request: { op: 'subscribe-identity', entries: [entry] },
				uploadIds: [entry.uploadId],
				answer: {
					ev: 'settled',
					uploadId: 'upload',
					response: {
						storePathHash: entry.storePathHash,
						narHash: entry.narHash,
						status: 'already-present'
					}
				},
				state: {
					pending: [],
					operations: [],
					narInfos: [
						{
							storePathHash: entry.storePathHash,
							narHash: entry.narHash,
							generation: 0
						}
					],
					references: [
						{
							storePathHash: entry.storePathHash,
							generation: 0,
							narHash: entry.narHash,
							readable: true
						}
					],
					usage: [{ bytes: nar.narBytes.byteLength, narinfos: 1, blobs: 1 }]
				}
			};
		}
	}
];

// Sends one message under a dispatch allowance of `subrequests` and returns
// the normalised answers with the calls that the message made.
async function sendWithin(
	conversation: CommitConversation,
	request: CommitSessionRequestInput,
	uploadIds: readonly UploadId[],
	subrequests: number
): Promise<{
	readonly frames: unknown[];
	readonly calls: number;
	readonly warnings: unknown[];
}> {
	const context = await runInDurableObject(
		currentServer(),
		(instance) => instance.context
	);
	const capture = startCapture();
	try {
		const frames = await withDeployedSubrequestAllowance(
			context,
			subrequests,
			() => {
				conversation.send(request);
				return answers(conversation, uploadIds);
			}
		);
		const calls = capture.logs
			.filter((entry) => entry.message === 'method finished')
			.map((entry) => messageCostSchema.parse(entry.properties))
			.filter((cost) => cost.method === 'webSocketMessage')
			.reduce(
				(total, cost) =>
					total +
					cost.d1Calls +
					cost.r2Head +
					cost.r2Get +
					cost.r2Put +
					cost.r2Delete +
					cost.r2List,
				0
			);
		const warnings = capture.logs
			.filter(
				(entry) => entry.message === 'commit message ran out of subrequests'
			)
			.map((entry) => exhaustionWarningSchema.parse(entry.properties));
		return {
			frames: frames.map((frame) => normalised(frame)),
			calls,
			warnings
		};
	} finally {
		capture.stop();
	}
}

// The state that a commit or publication can change: the tenant's rows, its
// shared D1 references and its usage charge.
async function storedState(): Promise<unknown> {
	const local = await runInDurableObject(currentServer(), (instance) => ({
		pending: instance.context.db
			.select({
				narHash: schema.pendingUploads.narHash,
				verdict: schema.pendingUploads.verdict
			})
			.from(schema.pendingUploads)
			.all(),
		operations: instance.context.db
			.select({
				id: schema.publicationOperations.id,
				state: schema.publicationOperations.state
			})
			.from(schema.publicationOperations)
			.all(),
		narInfos: instance.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.all()
	}));
	const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const [references, usage] = await d1.batch([
		d1
			.select({
				storePathHash: d1Schema.blobReference.storePathHash,
				generation: d1Schema.blobReference.generation,
				narHash: d1Schema.blobReference.narHash,
				readable: d1Schema.blobReference.readable
			})
			.from(d1Schema.blobReference),
		d1
			.select({
				bytes: d1Schema.tenantUsage.bytes,
				narinfos: d1Schema.tenantUsage.narinfos,
				blobs: d1Schema.tenantUsage.blobs
			})
			.from(d1Schema.tenantUsage)
	]);
	return { ...local, references, usage };
}

// Runs the scenario's message once under `subrequests`, then sends it again
// with an unlimited allowance, as a client sends an entry again after a
// retryable answer.
async function interruptedThenResent(
	scenario: MessageScenario,
	subrequests: number
) {
	await resetTestServer();
	const token = await initialise();
	const prepared = await scenario.prepare(token);
	const conversation = await openCommitSession(
		token,
		defaultCache(),
		scenario.accepted
	);
	try {
		const first = await sendWithin(
			conversation,
			prepared.request,
			prepared.uploadIds,
			subrequests
		);
		const resent = await sendWithin(
			conversation,
			prepared.request,
			prepared.uploadIds,
			Number.MAX_SAFE_INTEGER
		);
		return {
			prepared,
			first: first.frames,
			firstCalls: first.calls,
			resent: resent.frames,
			state: await storedState()
		};
	} finally {
		conversation.socket.close();
	}
}

function retryableAnswer(op: CommitSessionRequestInput['op']): unknown {
	const isPublication =
		op === 'publish-batch' || op === 'subscribe-publication';
	return {
		ev: isPublication ? 'publication-refused' : 'error',
		uploadId: 'upload',
		...(isPublication && { reason: 'temporary-failure' }),
		status: commitEntryResendStatus
	};
}

const retryableStatusSchema = z.object({
	status: z.literal(commitEntryResendStatus)
});

function refusedAnswers(entries: number): unknown[] {
	return Array.from({ length: entries }, () =>
		retryableAnswer('publish-batch')
	);
}

// Stages `entries` fresh paths and sends them in one `publish-batch` message
// whose allowance equals the slice reserve.
async function sendWithinReserve(entries: number) {
	await resetTestServer();
	const token = await initialise();
	const planned: PublicationEntry[] = [];
	for (let index = 1; index <= entries; index += 1) {
		const { entry } = await stagedPublication(
			token,
			`wave-${String(index)}`,
			index
		);
		planned.push(entry);
	}
	const conversation = await openCommitSession(
		token,
		defaultCache(),
		publicationSession
	);
	try {
		return await sendWithin(
			conversation,
			{ op: 'publish-batch', pushId: testPushId, entries: planned },
			planned.map((entry) => entry.operationId),
			subrequestSliceReserve
		);
	} finally {
		conversation.socket.close();
	}
}

describe('commit messages that run out of subrequests', () => {
	it.each(scenarios)(
		'completes an uninterrupted $op entry in fewer than the enumerated calls',
		async (scenario) => {
			const outcome = await interruptedThenResent(
				scenario,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				first: outcome.first,
				resent: outcome.resent,
				state: outcome.state,
				isWithinBound:
					outcome.firstCalls > 0 && outcome.firstCalls < entryCallBound
			}).toStrictEqual({
				first: [outcome.prepared.answer],
				resent: [outcome.prepared.answer],
				state: outcome.prepared.state,
				isWithinBound: true
			});
		}
	);

	it.each(
		scenarios.flatMap((scenario) =>
			allowances.map((subrequests) => ({
				op: scenario.op,
				scenario,
				subrequests
			}))
		)
	)(
		'answers a $op entry stopped by an allowance of $subrequests so that a resend completes it',
		async ({ scenario, subrequests }) => {
			const outcome = await interruptedThenResent(scenario, subrequests);
			const { answer } = outcome.prepared;

			expect({
				first: outcome.first,
				resent: outcome.resent,
				state: outcome.state
			}).toStrictEqual({
				// An allowance of 0 refuses the entry's first call, so it must
				// interrupt every entry.
				first: [
					subrequests === 0 ||
					retryableStatusSchema.safeParse(outcome.first[0]).success
						? retryableAnswer(scenario.op)
						: answer
				],
				resent: [answer],
				state: outcome.prepared.state
			});
		}
	);

	// Publication admission checks the budget for its NAR probes, so one call
	// above the reserve stops it there. A commit of a staged upload makes no
	// budget check, and its few calls fit any allowance above the reserve.
	it.each(
		scenarios.map((scenario) => ({
			op: scenario.op,
			scenario,
			hasBudgetCheck:
				scenario.op === 'publish-batch' ||
				scenario.op === 'subscribe-publication'
		}))
	)(
		'stops a $op entry above the reserve only at a budget check',
		async ({ scenario, hasBudgetCheck }) => {
			const outcome = await interruptedThenResent(
				scenario,
				subrequestSliceReserve + 1
			);
			const { answer } = outcome.prepared;

			expect({
				first: outcome.first,
				resent: outcome.resent,
				state: outcome.state
			}).toStrictEqual({
				first: [hasBudgetCheck ? retryableAnswer(scenario.op) : answer],
				resent: [answer],
				state: outcome.prepared.state
			});
		}
	);

	it('refuses a publication entry whose commit the slice stops as a publication', async () => {
		await resetTestServer();
		const token = await initialise();
		const prepared = await publicationMessage(token, 'publish-batch', false);
		const conversation = await openCommitSession(
			token,
			defaultCache(),
			publicationSession
		);
		const commit = vi
			.spyOn(CommitPipelineService.prototype, 'commit')
			.mockRejectedValueOnce(new SubrequestSliceExceededError('d1.raw', 1));
		onTestFinished(() => {
			commit.mockRestore();
		});
		try {
			const first = await sendWithin(
				conversation,
				prepared.request,
				prepared.uploadIds,
				Number.MAX_SAFE_INTEGER
			);
			const resent = await sendWithin(
				conversation,
				prepared.request,
				prepared.uploadIds,
				Number.MAX_SAFE_INTEGER
			);

			expect({ first: first.frames, resent: resent.frames }).toStrictEqual({
				first: [retryableAnswer('publish-batch')],
				resent: [prepared.answer]
			});
		} finally {
			conversation.socket.close();
		}
	});

	it('answers the entries that start after a refusal without running them', async () => {
		// With an allowance equal to the reserve, every budget check refuses, so
		// each running entry is refused at its first check. The commit entry
		// semaphore runs at most `maxOutgoingConnections` entries at once, so
		// every later entry starts after the slice has refused work.
		const firstWave = await sendWithinReserve(maxOutgoingConnections);
		const withLaterEntries = await sendWithinReserve(
			maxOutgoingConnections + 4
		);

		expect({ firstWave, withLaterEntries }).toStrictEqual({
			firstWave: {
				frames: refusedAnswers(maxOutgoingConnections),
				calls: firstWave.calls,
				warnings: [
					{
						operation: 'publish-batch',
						refusedEntries: maxOutgoingConnections
					}
				]
			},
			withLaterEntries: {
				frames: refusedAnswers(maxOutgoingConnections + 4),
				calls: firstWave.calls,
				warnings: [
					{
						operation: 'publish-batch',
						refusedEntries: maxOutgoingConnections + 4
					}
				]
			}
		});
	});
});
