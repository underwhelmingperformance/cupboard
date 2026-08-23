import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { cacheUrl } from '@cupboard/nix-store/cache-url';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StoredCache,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationAttachResponse,
	AttestationDecision,
	AttestationNegotiateRequest,
	AttestationNegotiateResponse
} from '@cupboard/protocol/attestations';
import {
	type AttestationAttachPath,
	attestationAttachSummaryResultKind,
	attestationAttachSummarySchema
} from '@cupboard/protocol/reports';
import {
	formatBytes,
	formatCount,
	type Reporter,
	type ResultRow,
	type StepLog
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import type { ReadUser } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { z } from 'zod';

import {
	AttestationAttachResponseMismatchError,
	AttestationBundleInvalidError,
	AttestationDivergedPathError,
	AttestationNegotiationMismatchError,
	AttestationSubjectNotPushedError,
	AttestationUploadUnavailableError,
	ReferencePathMismatchError,
	UnexpectedAttestationDecisionError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
import {
	fetchReferenceMetadata,
	type ReferenceFetchDependencies
} from '../push/reference.ts';

export interface AttestationBundleSource {
	readonly path: string;
}

export type ReadAttestationBundle = (path: string) => Promise<Uint8Array>;

export interface AttestationAttachClient {
	negotiateAttestations(
		body: Omit<AttestationNegotiateRequest, 'pushId'>
	): Promise<AttestationNegotiateResponse>;
	uploadNar(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	attachAttestation(uploadId: string): Promise<AttestationAttachResponse>;
}

export function requireAttestationAttachClient(client: {
	negotiateAttestations?: AttestationAttachClient['negotiateAttestations'];
	attachAttestation?: AttestationAttachClient['attachAttestation'];
	uploadNar: AttestationAttachClient['uploadNar'];
}): AttestationAttachClient {
	const { negotiateAttestations, attachAttestation } = client;

	if (negotiateAttestations === undefined) {
		throw new AttestationUploadUnavailableError('negotiateAttestations');
	}

	if (attachAttestation === undefined) {
		throw new AttestationUploadUnavailableError('attachAttestation');
	}

	return {
		negotiateAttestations: (body) => negotiateAttestations(body),
		attachAttestation: (uploadId) => attachAttestation(uploadId),
		uploadNar: (r2Key, body) => client.uploadNar(r2Key, body)
	};
}

/**
 * A skip decision can reveal that the local path and the committed path have
 * different NAR hashes. An attestation for the local bytes cannot be attached
 * to the cache's copy of that store path.
 */
export interface DivergentSkip {
	readonly storePath: StorePathString;
	readonly localNarHash: string;
	readonly cacheNarHash: string;
}

export interface PreparedAttestationBundle {
	readonly storePathHash: StorePathHash;
	readonly digest: string;
	readonly bytes: Uint8Array;
}

export interface PrepareAttestationBundlesOptions {
	readonly sources: readonly AttestationBundleSource[];
	readonly readBundle: ReadAttestationBundle;
	readonly divergent: ReadonlyMap<StorePathHash, DivergentSkip>;
}

export interface AttestationPathInfo {
	readonly storePath: StorePathString;
	readonly narHash: NixSha256Hash;
}

interface AttestationSubject {
	readonly name: string;
	readonly sha256: Sha256HexDigest;
}

const bundleConcurrency = 6;

export interface CommittedAttestationSource {
	readonly url: URL;
	readonly cache: StoredCache;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

/**
 * Reads the path identities from the destination's live narinfos. A path that
 * is absent during this initial read fails the command. The standalone attach
 * command reports an unservable outcome only for a later `NOT_FOUND` response
 * from the attachment request.
 */
export async function readCommittedAttestationPathInfos(
	paths: readonly StorePathString[],
	source: CommittedAttestationSource,
	dependencies: ReferenceFetchDependencies = {}
): Promise<readonly AttestationPathInfo[]> {
	const reference = {
		url: cacheUrl(source.url, source.cache),
		...(source.readUser !== undefined && { readUser: source.readUser }),
		...(source.readPassword !== undefined && {
			readPassword: source.readPassword
		})
	};

	return mapWithConcurrency(paths, bundleConcurrency, async (storePath) => {
		const metadata = await fetchReferenceMetadata(
			reference,
			StorePath.hash(storePath),
			dependencies
		);

		if (metadata.upload.storePath !== storePath) {
			throw new ReferencePathMismatchError(
				storePath,
				metadata.upload.storePath
			);
		}

		return {
			storePath,
			narHash: NixSha256Hash.parse(metadata.upload.narHash)
		};
	});
}

/**
 * Matches every in-toto subject in each bundle against the selected store
 * paths and NAR hashes. If any subject is outside that set, the whole bundle is
 * rejected before upload. A bundle is also rejected when the destination has
 * different bytes for one of its subjects. Duplicate path and bundle pairs
 * collapse to one entry.
 */
export async function prepareAttestationBundles(
	pathInfos: readonly AttestationPathInfo[],
	options: PrepareAttestationBundlesOptions
): Promise<readonly PreparedAttestationBundle[]> {
	const bySubject = new Map(
		pathInfos.map((pathInfo) => [
			attestationSubjectKey({
				name: StorePath.basename(pathInfo.storePath),
				sha256: pathInfo.narHash.digestHex()
			}),
			pathInfo
		])
	);
	const prepared: PreparedAttestationBundle[] = [];
	const seen = new Set<string>();

	for (const source of options.sources) {
		const bytes = await options.readBundle(source.path);
		const parsed = parseAttestationBundle(source.path, bytes);
		const digest = sha256Hex(bytes);

		const unmatched = parsed.subjects.filter(
			(subject) => !bySubject.has(attestationSubjectKey(subject))
		);

		if (unmatched.length > 0) {
			throw new AttestationSubjectNotPushedError(
				source.path,
				unmatched.map((subject) => subject.sha256)
			);
		}

		const matched = parsed.subjects.map((subject) => {
			const pathInfo = bySubject.get(attestationSubjectKey(subject));

			if (pathInfo === undefined) {
				throw new AttestationSubjectNotPushedError(source.path, [
					subject.sha256
				]);
			}

			return pathInfo;
		});

		for (const pathInfo of matched) {
			// The bundle describes the local bytes, but the cache committed a
			// different NAR for this store path, so the attach can never succeed:
			// fail here, before any bundle uploads, with both hashes named.
			const diverged = options.divergent.get(
				StorePath.hash(pathInfo.storePath)
			);

			if (diverged !== undefined) {
				throw new AttestationDivergedPathError(
					diverged.storePath,
					diverged.localNarHash,
					diverged.cacheNarHash
				);
			}

			recordPreparedBundle(pathInfo, digest, bytes, seen, prepared);
		}
	}

	return prepared;
}

function attestationSubjectKey(subject: AttestationSubject): string {
	return `${subject.name}\0${subject.sha256}`;
}

function recordPreparedBundle(
	pathInfo: AttestationPathInfo,
	digest: string,
	bytes: Uint8Array,
	seen: Set<string>,
	prepared: PreparedAttestationBundle[]
): void {
	const storePathHash = StorePath.hash(pathInfo.storePath);
	const key = `${storePathHash}\0${digest}`;

	if (seen.has(key)) {
		return;
	}

	seen.add(key);
	prepared.push({ storePathHash, digest, bytes });
}

export interface AttestationAttachmentOptions {
	readonly client: AttestationAttachClient;
	/**
	 * Treats `NOT_FOUND` during attachment as an `unservable` outcome and
	 * continues with the other bundles. The server uses this response when the
	 * committed path disappears or the pending attachment is missing or expired.
	 * A push leaves this unset because it has just committed every path it attests.
	 */
	readonly skipUnservable?: boolean;
}

export interface AttestationBundleOutcome {
	readonly storePathHash: StorePathHash;
	readonly digest: string;
	readonly outcome: 'attached' | 'reused' | 'unservable';
}

export interface AttestationAttachOutcome {
	readonly attached: number;
	readonly reused: number;
	readonly uploadedBytes: number;
	readonly unservableStorePathHashes: ReadonlySet<StorePathHash>;
	readonly bundles: readonly AttestationBundleOutcome[];
}

interface AttestationBundleIdentity {
	readonly storePathHash: string;
	readonly digest: string;
}

function attestationBundleIdentityKey(
	identity: AttestationBundleIdentity
): string {
	return `${identity.storePathHash}\0${identity.digest}`;
}

// Negotiation must return exactly one decision for every requested bundle.
// Missing, duplicate, and unexpected identities are protocol failures.
function exactAttestationDecisions(
	requested: readonly AttestationBundleIdentity[],
	decisions: readonly AttestationDecision[]
): readonly AttestationDecision[] {
	const requestedByKey = new Map(
		requested.map((identity) => [
			attestationBundleIdentityKey(identity),
			identity
		])
	);
	const answered = new Set<string>();

	for (const decision of decisions) {
		const key = attestationBundleIdentityKey(decision);
		const identity = requestedByKey.get(key);

		if (identity === undefined) {
			throw new AttestationNegotiationMismatchError(
				'unexpected',
				decision.storePathHash,
				decision.digest
			);
		}

		if (answered.has(key)) {
			throw new AttestationNegotiationMismatchError(
				'duplicate',
				decision.storePathHash,
				decision.digest
			);
		}

		answered.add(key);
	}

	for (const [key, identity] of requestedByKey) {
		if (answered.has(key)) {
			continue;
		}

		throw new AttestationNegotiationMismatchError(
			'missing',
			identity.storePathHash,
			identity.digest
		);
	}

	return decisions;
}

function requireMatchingAttachResponse(
	decision: Extract<AttestationDecision, { action: 'upload' }>,
	response: AttestationAttachResponse
): AttestationAttachResponse {
	if (
		response.storePathHash === decision.storePathHash &&
		response.digest === decision.digest
	) {
		return response;
	}

	throw new AttestationAttachResponseMismatchError(
		decision.storePathHash,
		decision.digest,
		response.storePathHash,
		response.digest
	);
}

// The server returns `NOT_FOUND` when the committed path disappears or the
// pending attachment is missing or expired before this request.
function isUnservablePathAttachError(error: unknown): boolean {
	return error instanceof ORPCError && error.code === 'NOT_FOUND';
}

export async function runAttestationAttachment(
	prepared: readonly PreparedAttestationBundle[],
	log: StepLog,
	options: AttestationAttachmentOptions
): Promise<AttestationAttachOutcome> {
	const negotiateStep = log.group('negotiate');
	const negotiation = await options.client.negotiateAttestations({
		bundles: prepared.map((bundle) => ({
			storePathHash: bundle.storePathHash,
			digest: bundle.digest
		}))
	});
	const decisions = exactAttestationDecisions(prepared, negotiation.bundles);
	const toUpload = decisions.filter((decision) =>
		isAttestationUpload(decision)
	);
	let reused = decisions.filter((decision) =>
		isAttestationSkip(decision)
	).length;
	negotiateStep.success(
		`${formatCount(toUpload.length)} to upload, ${formatCount(reused)} reused`
	);

	const uploadStep = log.group('upload');
	let uploadedBytes = 0;

	await mapWithConcurrency(toUpload, bundleConcurrency, async (decision) => {
		const bundle = findAttestationBundle(prepared, decision);

		// Attestation bytes use the same staging uploader and push credential as
		// NARs. The negotiated `r2Key` selects the attestation staging object.
		await options.client.uploadNar(decision.r2Key, byteStream([bundle.bytes]));

		uploadedBytes += bundle.bytes.byteLength;
	});

	uploadStep.success(formatBytes(uploadedBytes));

	const attachStep = log.group('attach');
	let attached = 0;
	const unservableStorePathHashes = new Set<StorePathHash>();
	const bundles: AttestationBundleOutcome[] = decisions
		.filter((decision) => isAttestationSkip(decision))
		.flatMap((decision) => {
			const match = prepared.find(
				(item) =>
					item.storePathHash === decision.storePathHash &&
					item.digest === decision.digest
			);

			return match === undefined
				? []
				: [
						{
							storePathHash: match.storePathHash,
							digest: match.digest,
							outcome: 'reused' as const
						}
					];
		});

	await mapWithConcurrency(toUpload, bundleConcurrency, async (decision) => {
		const bundle = findAttestationBundle(prepared, decision);

		try {
			const response = requireMatchingAttachResponse(
				decision,
				await options.client.attachAttestation(decision.uploadId)
			);
			const outcome =
				response.status === 'already-present' ? 'reused' : 'attached';

			if (outcome === 'attached') {
				attached += 1;
			} else {
				reused += 1;
			}

			bundles.push({
				storePathHash: bundle.storePathHash,
				digest: bundle.digest,
				outcome
			});
		} catch (error) {
			if (
				options.skipUnservable !== true ||
				!isUnservablePathAttachError(error)
			) {
				throw error;
			}

			unservableStorePathHashes.add(bundle.storePathHash);
			bundles.push({
				storePathHash: bundle.storePathHash,
				digest: bundle.digest,
				outcome: 'unservable'
			});
		}
	});

	attachStep.success(`${formatCount(attached)} attached`);

	return {
		attached,
		reused,
		uploadedBytes,
		unservableStorePathHashes,
		bundles
	};
}

export interface AttestAttachDependencies {
	readonly client: AttestationAttachClient;
	readonly pathInfos: readonly AttestationPathInfo[];
	readonly attestations: readonly AttestationBundleSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
}

/**
 * Attaches bundles after their subjects have been matched against live
 * destination narinfos. If the server returns `NOT_FOUND` during attachment,
 * the summary reports the path as unservable and continues with the other
 * bundles.
 */
export async function runAttestAttach(
	paths: readonly string[],
	reporter: Reporter,
	dependencies: AttestAttachDependencies
): Promise<void> {
	const readBundle =
		dependencies.readAttestationBundle ?? defaultReadAttestationBundle;

	const pathInfos = await reporter.phase('Resolving store paths', (ctx) => {
		const named = new Set(paths);
		const infos = dependencies.pathInfos.filter((info) =>
			named.has(info.storePath)
		);
		ctx.fact('paths', formatCount(infos.length));

		return infos;
	});

	const { prepared, outcome } = await reporter.steps(
		'Attestations',
		async (log) => {
			const readStep = log.group('read');
			const bundles = await prepareAttestationBundles(pathInfos, {
				sources: dependencies.attestations,
				readBundle,
				divergent: new Map()
			});
			readStep.success(
				`${formatCount(bundles.length)} ${bundles.length === 1 ? 'bundle' : 'bundles'}`
			);

			return {
				prepared: bundles,
				outcome: await runAttestationAttachment(bundles, log, {
					client: dependencies.client,
					skipUnservable: true
				})
			};
		}
	);

	const storePathByHash = new Map<StorePathHash, StorePathString>(
		pathInfos.map((info) => [StorePath.hash(info.storePath), info.storePath])
	);
	const summaryPaths = attachSummaryPaths(prepared, outcome, storePathByHash);

	for (const path of summaryPaths) {
		if (path.outcome !== 'unservable') {
			continue;
		}

		reporter.warn(
			'unservable',
			`${path.storePath === undefined ? path.storePathHash : StorePath.basename(path.storePath)}: the committed path disappeared or the pending attachment was no longer available; attachment not recorded`
		);
	}

	const summary = {
		attached: outcome.attached,
		reused: outcome.reused,
		unservable: outcome.unservableStorePathHashes.size,
		uploadedBytes: outcome.uploadedBytes,
		paths: summaryPaths
	};
	// A result-schema failure must not hide the attachment outcome from the
	// reporter, so reporting falls back to the unvalidated summary.
	const validated = attestationAttachSummarySchema.safeParse(summary);

	reporter.result({
		kind: attestationAttachSummaryResultKind,
		data: validated.success ? validated.data : summary,
		rows: [
			{
				label: 'Attestations',
				value:
					`${formatCount(outcome.attached)} attached, ` +
					`${formatCount(outcome.reused)} reused, ` +
					`${formatCount(summary.unservable)} unservable`
			},
			{
				label: 'Attestation upload',
				value: formatBytes(outcome.uploadedBytes)
			},
			...summaryPaths.map((path): ResultRow => ({
				label: path.storePathHash,
				value: attachPathRow(path.outcome)
			}))
		]
	});
}

function attachPathRow(outcome: AttestationAttachPath['outcome']): string {
	switch (outcome) {
		case 'attached': {
			return 'attached';
		}

		case 'reused': {
			return 'already attached';
		}

		case 'unservable': {
			return 'attachment no longer available; not recorded';
		}
	}
}

// Fold the bundle outcomes into one result per path, preserving preparation
// order. Use the highest-severity outcome for each path: unservable, attached,
// then reused.
function attachSummaryPaths(
	prepared: readonly PreparedAttestationBundle[],
	outcome: AttestationAttachOutcome,
	storePathByHash: ReadonlyMap<StorePathHash, StorePathString>
): readonly AttestationAttachPath[] {
	const rank = { reused: 0, attached: 1, unservable: 2 } as const;
	const outcomeByBundle = new Map(
		outcome.bundles.map((bundle) => [
			`${bundle.storePathHash}\0${bundle.digest}`,
			bundle.outcome
		])
	);
	const byPath = new Map<StorePathHash, AttestationAttachPath['outcome']>();

	for (const bundle of prepared) {
		const bundleOutcome = outcomeByBundle.get(
			`${bundle.storePathHash}\0${bundle.digest}`
		);

		if (bundleOutcome === undefined) {
			continue;
		}

		const current = byPath.get(bundle.storePathHash);

		if (current === undefined || rank[bundleOutcome] > rank[current]) {
			byPath.set(bundle.storePathHash, bundleOutcome);
		}
	}

	return [...byPath].map(([storePathHash, pathOutcome]) => {
		const storePath = storePathByHash.get(storePathHash);

		return {
			storePathHash,
			...(storePath !== undefined && { storePath }),
			outcome: pathOutcome
		};
	});
}

export function isAttestationUpload(
	decision: AttestationDecision
): decision is Extract<AttestationDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

export function isAttestationSkip(
	decision: AttestationDecision
): decision is Extract<AttestationDecision, { action: 'skip' }> {
	return decision.action === 'skip';
}

export function findAttestationBundle(
	bundles: readonly PreparedAttestationBundle[],
	decision: Extract<AttestationDecision, { action: 'upload' }>
): PreparedAttestationBundle {
	const bundle = bundles.find(
		(item) =>
			item.storePathHash === decision.storePathHash &&
			item.digest === decision.digest
	);

	if (bundle !== undefined) {
		return bundle;
	}

	throw new UnexpectedAttestationDecisionError(
		decision.storePathHash,
		decision.digest
	);
}

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';

const dsseEnvelopeSchema = z.object({
	payload: z.string(),
	payloadType: z.literal(inTotoPayloadType)
});

const sigstoreBundleSubjectSchema = z.object({
	name: z.string().min(1),
	digest: z.object({
		sha256: sha256HexDigestSchema
	})
});

const sigstoreBundleStatementSchema = z.object({
	_type: z.literal(inTotoStatementType),
	subject: z.array(sigstoreBundleSubjectSchema).min(1),
	predicateType: z.string(),
	predicate: z.unknown()
});

const sigstoreBundleSchema = z.object({
	dsseEnvelope: dsseEnvelopeSchema
});

export function parseAttestationBundle(
	path: string,
	bytes: Uint8Array
): { readonly subjects: readonly AttestationSubject[] } {
	let json: unknown;

	try {
		const decoder = new TextDecoder();
		json = JSON.parse(decoder.decode(bytes));
	} catch {
		throw new AttestationBundleInvalidError(path, 'bundle is not JSON');
	}

	const bundle = sigstoreBundleSchema.safeParse(json);

	if (!bundle.success) {
		throw new AttestationBundleInvalidError(
			path,
			'bundle has no DSSE envelope'
		);
	}

	let statementJson: unknown;

	try {
		statementJson = JSON.parse(
			Buffer.from(bundle.data.dsseEnvelope.payload, 'base64').toString('utf8')
		);
	} catch {
		throw new AttestationBundleInvalidError(
			path,
			'DSSE envelope payload is not JSON'
		);
	}

	const statement = sigstoreBundleStatementSchema.safeParse(statementJson);

	if (!statement.success) {
		throw new AttestationBundleInvalidError(
			path,
			'DSSE envelope payload is not a supported in-toto statement'
		);
	}

	return {
		subjects: statement.data.subject.map((subject) => ({
			name: subject.name,
			sha256: subject.digest.sha256
		}))
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export async function defaultReadAttestationBundle(
	path: string
): Promise<Uint8Array> {
	return readFile(path);
}
