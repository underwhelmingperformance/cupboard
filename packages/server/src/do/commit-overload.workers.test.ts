import { atWarningOrAbove, startCapture } from '@cupboard/logger/testing';
import {
	type NixSha256HashString,
	type StorePathHash,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { cacheMetadataErrorCodes } from '@cupboard/protocol/cache-metadata';
import {
	commitAcceptCapabilitiesHeader,
	type CommitSessionFrame,
	type UploadId,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	d1AccountThrottleMessage,
	d1QueueOverloadMessage
} from '../db/transient.test-support.ts';
import {
	MetadataNarInfoInvalidError,
	ObjectIncarnationReservationContendedError,
	PublicationPathChangedError,
	PublicationPushExpiredError,
	PublicationResendRequiredError,
	PublicationStateChangedError,
	QuotaExceededError,
	SharedFactsUnavailableError
} from '../errors.ts';
import {
	commitSocketCeiling,
	maxUncreditedCommitSessions
} from '../policy/commit-sockets.ts';
import {
	authorisedFetch,
	type CommitConversation,
	commitCreditAccept,
	commitSessionFromResponse,
	currentServer,
	defaultCache,
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const stringMatcher: unknown = expect.any(String);

const overloads = [
	{ name: 'the D1 queue overload', error: new Error(d1QueueOverloadMessage) },
	{
		name: 'the D1 account throttle',
		error: new Error(d1AccountThrottleMessage)
	}
];

// Each error has a URL in its cause, which the warning must not contain.
const providerUrl = 'https://r2.example/secret?signature=abc';

const serverFaults = [
	{
		name: 'an error without a code',
		error: new SharedFactsUnavailableError(
			new Error(`${d1AccountThrottleMessage} ${providerUrl}`)
		),
		facts: {
			errorName: 'SharedFactsUnavailableError',
			errorStatus: StatusCodes.SERVICE_UNAVAILABLE
		}
	},
	{
		name: 'an error with a code',
		error: new MetadataNarInfoInvalidError(undefined, new Error(providerUrl)),
		facts: {
			errorName: 'MetadataNarInfoInvalidError',
			errorCode: cacheMetadataErrorCodes.narInfoInvalid,
			errorStatus: StatusCodes.INTERNAL_SERVER_ERROR
		}
	}
];

// Refusals that are a normal step of the protocol, with the frame that the
// server sends for each. None of them is logged, although most have a 5xx
// status.
const expectedRefusals = [
	{
		name: 'a full quota',
		error: new QuotaExceededError(tenantIdSchema.parse('acme')),
		frame: {
			ev: 'error',
			status: StatusCodes.INSUFFICIENT_STORAGE,
			hasMessage: true
		}
	},
	...[
		{ name: 'a resend request', error: new PublicationResendRequiredError() },
		{ name: 'an expired push lease', error: new PublicationPushExpiredError() },
		{
			name: 'a changed publication state',
			error: new PublicationStateChangedError()
		},
		{
			name: 'a changed path',
			error: new PublicationPathChangedError()
		},
		{
			name: 'a contended object incarnation',
			error: new ObjectIncarnationReservationContendedError()
		}
	].map((refusal) => ({
		...refusal,
		frame: {
			ev: 'error',
			status: StatusCodes.SERVICE_UNAVAILABLE,
			hasMessage: true
		}
	}))
];

// The frame without its message text, which these tests do not assert on.
function frameFacts(frame: CommitSessionFrame): object {
	if (!('message' in frame)) {
		return frame;
	}

	const { message, ...facts } = frame;

	return { ...facts, hasMessage: message.length > 0 };
}

const cacheFields = {
	access: 'public',
	generation: 1,
	id: 1,
	scope: { kind: 'default' }
};

interface StagedCommit {
	readonly uploadId: UploadId;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
}

async function stageCommit(token: string): Promise<StagedCommit> {
	const path = uploadMetadata({
		storePathHash: 'a'.repeat(32),
		fileSize: 1
	});
	const negotiated = await negotiateUploads(token, [path]);
	const decision = negotiated.uploads[0];

	if (decision?.action !== 'upload') {
		throw new Error('expected an upload decision');
	}

	await putNarBytes(decision.r2Key);

	return {
		uploadId: uploadIdSchema.parse(decision.uploadId),
		storePathHash: path.storePathHash,
		narHash: path.narHash
	};
}

describe('commit socket overload handling', () => {
	beforeEach(resetTestServer);

	it.each(overloads)(
		'sends a 503 error frame and logs the overload when the commit is rejected with $name',
		async ({ error }) => {
			const token = await initialise();
			const { uploadId } = await stageCommit(token);
			const batchSpy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockRejectedValue(error);
			const capture = startCapture();

			try {
				const session = await openCommitSession(token);
				session.send({ op: 'commit', uploadId });
				const frame = await session.nextFrame();
				session.socket.close();

				expect({
					frame,
					logged: atWarningOrAbove(capture.logs)
				}).toStrictEqual({
					frame: {
						ev: 'error',
						uploadId,
						status: StatusCodes.SERVICE_UNAVAILABLE,
						message: 'Database is temporarily overloaded'
					},
					logged: [
						{
							level: 'warning',
							category: ['cupboard'],
							message: 'request refused: database overloaded',
							properties: {
								cache: cacheFields,
								op: 'commit',
								sessionId: stringMatcher,
								uploadId,
								error
							}
						}
					]
				});
			} finally {
				capture.stop();
				batchSpy.mockRestore();
			}
		}
	);
});

describe('commit refusal logging', () => {
	beforeEach(resetTestServer);

	// A typed error keeps its own response when a D1 overload is in its cause
	// chain, and the overload log record is not written. The server logs the
	// refusal instead, with the error's class, code and status but without its
	// message or cause.
	it.each(
		serverFaults.flatMap((fault) =>
			(['commit', 'commit-batch'] as const).map((op) => ({ ...fault, op }))
		)
	)(
		'logs one warning for a $op entry refused with $name',
		async ({ op, error, facts }) => {
			const token = await initialise();
			const staged = await stageCommit(token);
			const batchSpy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockRejectedValue(error);
			const capture = startCapture();

			try {
				const session = await openCommitSession(token);
				session.send(
					op === 'commit'
						? { op, uploadId: staged.uploadId }
						: { op, commits: [staged] }
				);
				const frame = await session.nextFrame();
				session.socket.close();
				const logged = atWarningOrAbove(capture.logs);

				expect({ frame: frameFacts(frame), logged }).toStrictEqual({
					frame: {
						ev: 'error',
						uploadId: staged.uploadId,
						status: facts.errorStatus,
						hasMessage: true
					},
					logged: [
						{
							level: 'warning',
							category: ['cupboard'],
							message: 'commit refused',
							properties: {
								cache: cacheFields,
								op,
								sessionId: stringMatcher,
								uploadId: staged.uploadId,
								storePathHash: staged.storePathHash,
								...facts
							}
						}
					]
				});
				expect(JSON.stringify(logged)).not.toContain(providerUrl);
			} finally {
				capture.stop();
				batchSpy.mockRestore();
			}
		}
	);

	it.each(expectedRefusals)(
		'does not log a warning when a commit is refused with $name',
		async ({ error, frame: expected }) => {
			const token = await initialise();
			const { uploadId } = await stageCommit(token);
			const batchSpy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockRejectedValue(error);
			const capture = startCapture();

			try {
				const session = await openCommitSession(token);
				session.send({ op: 'commit', uploadId });
				const frame = await session.nextFrame();
				session.socket.close();

				expect({
					frame: frameFacts(frame),
					logged: atWarningOrAbove(capture.logs)
				}).toStrictEqual({ frame: { ...expected, uploadId }, logged: [] });
			} finally {
				capture.stop();
				batchSpy.mockRestore();
			}
		}
	);

	it('does not log a warning when a commit is refused with a 4xx error', async () => {
		const token = await initialise();
		const uploadId = uploadIdSchema.parse('never-negotiated');
		const capture = startCapture();

		try {
			const session = await openCommitSession(token);
			session.send({ op: 'commit', uploadId });
			const frame = await session.nextFrame();
			session.socket.close();

			expect({
				frame: frameFacts(frame),
				logged: atWarningOrAbove(capture.logs)
			}).toStrictEqual({
				frame: {
					ev: 'error',
					uploadId,
					status: StatusCodes.NOT_FOUND,
					hasMessage: true
				},
				logged: []
			});
		} finally {
			capture.stop();
		}
	});
});

async function openSessions(
	token: string,
	count: number,
	accepted?: string
): Promise<CommitConversation[]> {
	const sessions: CommitConversation[] = [];

	for (let index = 0; index < count; index += 1) {
		sessions.push(await openCommitSession(token, defaultCache(), accepted));
	}

	return sessions;
}

function closeAll(sessions: readonly CommitConversation[]): void {
	for (const session of sessions) {
		session.socket.close();
	}
}

function attemptUpgrade(token: string, accepted?: string): Promise<Response> {
	return authorisedFetch('/commit', token, {
		headers: {
			upgrade: 'websocket',
			...(accepted !== undefined && {
				[commitAcceptCapabilitiesHeader]: accepted
			})
		}
	});
}

// The test environment configures a lower ceiling than production so the suite
// can reach it with a small number of sockets.
const ceiling = commitSocketCeiling(env);

describe('commit socket ceiling', () => {
	beforeEach(resetTestServer);

	it('accepts sessions up to the ceiling and refuses the next upgrade retryably', async () => {
		const token = await initialise();
		const sessions = await openSessions(token, ceiling, commitCreditAccept);

		const refused = await attemptUpgrade(token, commitCreditAccept);

		expect({
			accepted: sessions.length,
			status: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			cacheControl: refused.headers.get('cache-control')
		}).toStrictEqual({
			accepted: ceiling,
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			cacheControl: 'no-store'
		});

		closeAll(sessions);
	});

	it('returns the credit of a session when its close handler finishes', async () => {
		const token = await initialise();
		const first = await openCommitSession(
			token,
			defaultCache(),
			commitCreditAccept
		);

		// The promise is created and awaited inside the object. A test that
		// awaits a promise resolved by the object continues in the object's I/O
		// context, and its next call into another object fails.
		const closeHandled = await runInDurableObject(
			currentServer(),
			(instance) => {
				const handled = Promise.withResolvers<undefined>();
				instance.afterCommitSocketClose = () => {
					handled.resolve(undefined);
				};

				return handled;
			}
		);
		first.socket.close();
		await runInDurableObject(currentServer(), async () => {
			await closeHandled.promise;
		});

		// The opening grant is half of the credit that is free. It matches the
		// first session's grant only when the first session's credit is free again.
		const reopened = await openCommitSession(
			token,
			defaultCache(),
			commitCreditAccept
		);

		expect({ capabilities: reopened.capabilities }).toStrictEqual({
			capabilities: first.capabilities
		});

		reopened.socket.close();
	});

	// The server cannot pace a session that did not negotiate credit, so it uses
	// a lower limit for those sessions. A credited session remains admissible at
	// that limit because the server controls its send budget.
	it('applies the lower uncredited limit without refusing a credited session', async () => {
		const token = await initialise();
		const unpaced = await openSessions(token, maxUncreditedCommitSessions);

		const refused = await attemptUpgrade(token);
		const credited = await attemptUpgrade(token, commitCreditAccept);
		const creditedSession = commitSessionFromResponse(credited);

		expect({
			opened: unpaced.length,
			refused: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			credited: credited.status
		}).toStrictEqual({
			opened: maxUncreditedCommitSessions,
			refused: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			credited: StatusCodes.SWITCHING_PROTOCOLS
		});

		closeAll([creditedSession, ...unpaced]);
	});
});
