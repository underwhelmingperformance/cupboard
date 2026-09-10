import {
	Nix,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import { implicitPinName } from '@cupboard/nix-store/retention';
import {
	type RootName,
	type StorePathHash,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import type {
	AttestationAttachResponseInput,
	AttestationNegotiateRequestInput,
	AttestationNegotiateResponseInput
} from '@cupboard/protocol/attestations';
import {
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildSubjectV3Input,
	type NixStoreUri
} from '@cupboard/protocol/build';
import {
	type PushSummaryPathInput,
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import {
	type RootSetBodyInput,
	rootSetMaxTargets,
	type RootSetResponseInput,
	type RootSummaryInput
} from '@cupboard/protocol/retention';
import {
	type UploadAttachRootInput,
	type UploadDecision,
	type UploadNegotiateRequestInput,
	type UploadNegotiateResponse,
	type UploadPathNegotiationFields,
	type UploadPreviewDecision,
	type UploadPreviewRequestInput,
	type UploadPreviewResponse
} from '@cupboard/protocol/upload';
import {
	formatBytes,
	formatCount,
	formatTimestamp,
	type PhaseContext,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { UsageError } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { isAbortError } from '../abort.ts';
import {
	type AttestationBundleSource,
	defaultReadAttestationBundle,
	type DivergentSkip,
	prepareAttestationBundles,
	type ReadAttestationBundle,
	requireAttestationAttachClient,
	runAttestationAttachment
} from '../attest/attach.ts';
import type { CommitOptions, CommitTarget } from '../client/client.ts';
import type { CommitOutcome, CommitSession } from '../client/commit-socket.ts';
import { isStaleUploadError } from '../client/rpc-errors.ts';
import {
	type WaitTimeoutSeconds,
	waitTimeoutSecondsSchema
} from '../duration.ts';
import {
	PushIncompleteError,
	PushNarMetadataMismatchError,
	ReferencePathMismatchError,
	ReferenceSourcePairError,
	ReferenceUploadRequiredError,
	UnexpectedUploadDecisionError,
	UploadGraceFactsUnsupportedError,
	UploadVerificationFailedError
} from '../errors.ts';
import { countingByteStream } from '../io/byte-stream.ts';
import { compressNarToStream, type NarUploadStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';

import { capacityWaitReporter } from './capacity-wait.ts';
import { narDivergence } from './divergence.ts';
import { exactUploadDecisions } from './negotiation.ts';
import { publishedSubjects, republishedSubject } from './origin.ts';
import {
	type PublicationCollection,
	type PublicationEntry,
	type PublicationKind
} from './publication.ts';
import {
	fetchReferenceMetadata as fetchReferenceMetadataFromSource,
	type ReferenceMetadata,
	type ReferenceSource
} from './reference.ts';

export type PushStore = Pick<
	Nix,
	'storeKind' | 'narFromPath' | 'resolveClosure' | 'queryValidPathsInfo'
>;

export interface PushDependencies {
	readonly nix?: PushStore;
	readonly client: PushClient;
	/**
	 * Include the complete realised closure of each publication entry. By
	 * default, publication includes only the entries themselves.
	 */
	readonly closure?: boolean;
	readonly referenceSource?: ReferenceSource;
	readonly fetchReferenceMetadata?: typeof fetchReferenceMetadataFromSource;
	readonly root?: RootName;
	readonly ttlSeconds?: TtlSeconds;
	// Attach each committed path to this run root during negotiation. Run-root
	// retention is independent of target `root` and `retain`, so an unretained
	// push can still contribute paths to its run root.
	readonly runRoot?: UploadAttachRootInput;
	// Unless this is false, retain targets under the named root or under one
	// implicit pin per path. `--no-retain` makes no root requests, so only the
	// cache's configured grace can protect a published path from collection.
	readonly retain?: boolean;
	// `push` records retention once the server has reserved every path. By
	// default it then waits for deferred verification; `--no-wait` returns while
	// those paths remain pending.
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: WaitTimeoutSeconds;
	readonly signal?: AbortSignal;
	readonly attest?: boolean;
	readonly attestations?: readonly AttestationBundleSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	/**
	 * An ssh-ng store streams NAR content through the store client instead of
	 * reading the runner's filesystem.
	 */
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
	/**
	 * `alreadyHeld` and `claimable` constrain which published paths can be
	 * attributed to this build invocation.
	 */
	readonly buildStore?: string;
	/**
	 * Paths already present in the build store when this run began. Their
	 * presence after the build is not evidence that this invocation realised
	 * them.
	 */
	readonly alreadyHeld?: readonly string[];
	/**
	 * Paths whose realisation this build invocation established. Other paths use
	 * store-derived provenance because post-build presence does not prove that the
	 * invocation realised them. `undefined` preserves the internal default that
	 * every published path is eligible; receipt-producing callers must provide the
	 * set explicitly.
	 */
	readonly claimable?: readonly string[];
	/**
	 * The builder for each delegated derivation, keyed by derivation path.
	 * When a published path's deriver appears here, a builder produced that
	 * path at this run's request, and the receipt subject records the builder
	 * in `machine`.
	 */
	readonly delegated?: ReadonlyMap<string, string>;
	/**
	 * Copy sources observed by a supervised build, keyed by store path. Without an
	 * activity log, copied subjects contain no source URL.
	 */
	readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

// Compress and upload several NARs concurrently so zstd work can overlap R2
// transfers instead of serialising the closure.
export const defaultUploadConcurrency = 6;

/**
 * Contract procedures cover negotiation, attestations, and roots. Blob upload
 * and WebSocket commit remain raw protocol operations because they stream bytes
 * or use temporary upload credentials.
 */
export interface PushClient {
	negotiate(
		body: Omit<UploadNegotiateRequestInput, 'pushId'>
	): Promise<UploadNegotiateResponse>;
	// Preview creates no upload state or credentials.
	preview(body: UploadPreviewRequestInput): Promise<UploadPreviewResponse>;
	// The no-path probe creates no upload state.
	probeUploadGraceFacts?(kind: 'negotiate' | 'preview'): Promise<boolean>;
	// Whether the most recent upload response acknowledged grace-aware
	// reporting. Clients without transport metadata are treated as capable.
	hasUploadGraceFacts?(): boolean;
	// Checks a route supported by every server version. This distinguishes an
	// unknown tenant from an old server without the preview route.
	tenantServes?(): Promise<boolean>;
	// Streams one compressed NAR to its staging key. The request body contains
	// only bytes; the server computes the file hash and size.
	uploadNar(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	commit(target: CommitTarget, options: CommitOptions): Promise<CommitOutcome>;
	// Opens a shared commit session. Minimal clients may omit this method and use
	// the per-path `commit` operation instead.
	openCommitSession?(options: CommitOptions): Promise<CommitSession>;
	negotiateAttestations?(
		body: Omit<AttestationNegotiateRequestInput, 'pushId'>
	): Promise<AttestationNegotiateResponseInput>;
	attachAttestation?(uploadId: string): Promise<AttestationAttachResponseInput>;
	setRoot(name: string, body: RootSetBodyInput): Promise<RootSetResponseInput>;
}

const defaultWaitTimeoutSeconds = waitTimeoutSecondsSchema.parse(600);

export type PushNarArchive =
	ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type CompressNar = (nar: PushNarArchive) => NarUploadStream;

type UploadDecisionOf<A extends UploadDecision['action']> = Extract<
	UploadDecision,
	{ action: A }
>;

// A failure recorded while the other paths continue. Any recorded failure
// makes the push return a non-zero result after it reports all path outcomes.
interface PushFailure {
	readonly storePathHash: StorePathHash;
	readonly storePath: string;
	readonly stage: 'resolve' | 'upload' | 'commit' | 'verify';
	readonly reason: string;
}

function failureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const notFoundStatus: number = StatusCodes.NOT_FOUND;

async function requireUploadGraceFacts(
	client: PushClient,
	kind: 'negotiate' | 'preview'
): Promise<void> {
	if (client.probeUploadGraceFacts === undefined) {
		return;
	}

	if (await client.probeUploadGraceFacts(kind)) {
		return;
	}

	throw new UploadGraceFactsUnsupportedError(
		new Error('The server did not acknowledge upload-grace-facts')
	);
}

async function negotiateUpload(
	client: PushClient,
	paths: Omit<UploadNegotiateRequestInput, 'pushId'>['paths'],
	attachRoot?: UploadAttachRootInput
): Promise<UploadNegotiateResponse> {
	const response = await client.negotiate({
		paths,
		...(attachRoot !== undefined && { attachRoot })
	});

	exactUploadDecisions(paths, response.uploads);

	return response;
}

// Servers from before the preview procedure return a contract-undefined
// `NOT_FOUND`. Other failures can return the same status, so repeat the request
// with an empty path list. A current server accepts that probe. Diagnose an old
// server only when both requests return the same undefined error.
//
// A defined `NOT_FOUND` is a procedure error, not evidence of a missing route.
// An unknown tenant also returns an undefined `NOT_FOUND` from every route, so
// confirm that the tenant serves `nix-cache-info` before diagnosing its server
// as too old. Otherwise preserve the original preview error.
async function previewUpload(
	client: PushClient,
	paths: UploadPreviewRequestInput['paths']
): Promise<UploadPreviewResponse> {
	try {
		const response = await client.preview({ paths });

		exactUploadDecisions(paths, response.uploads);

		return response;
	} catch (error) {
		if (
			error instanceof ORPCError &&
			error.status === notFoundStatus &&
			!error.defined
		) {
			try {
				await client.preview({ paths: [] });
			} catch (probeError) {
				if (
					probeError instanceof ORPCError &&
					probeError.status === notFoundStatus &&
					!probeError.defined &&
					(await canTenantAnswer(client))
				) {
					throw new UploadGraceFactsUnsupportedError(error);
				}
			}
		}

		throw error;
	}
}

// A failed tenant probe is inconclusive. Return false so the caller preserves
// the original preview error instead of diagnosing an old server.
async function canTenantAnswer(client: PushClient): Promise<boolean> {
	if (client.tenantServes === undefined) {
		return true;
	}

	try {
		return await client.tenantServes();
	} catch {
		return false;
	}
}

export async function runPush(
	publication: PublicationCollection,
	reporter: Reporter,
	dependencies: PushDependencies
): Promise<BuildReceiptV3 | undefined> {
	// Validate the retention before any upload work: an invalid root name or
	// target must fail fast, not after NARs are built and committed. Only the
	// declared targets are retained; intermediates join no root or pin.
	const retention = planRetention(
		publication.targetPaths,
		dependencies.root,
		dependencies.ttlSeconds,
		dependencies.retain ?? true
	);
	// A reference-only publication reads no local metadata and needs no store
	// on the system, so the store client only opens once a local entry needs it.
	const nix =
		dependencies.nix ??
		(publication.localEntries.length > 0 ? Nix.open() : undefined);
	const createNarArchive =
		dependencies.createNarArchive ?? ((storePath) => new NarArchive(storePath));
	// NAR metadata must describe the bytes supplied by the selected store. A
	// local store and a same-machine daemon both use the files at the store path,
	// so read those files directly. Paths in an ssh-ng store exist on the remote
	// machine, so stream their NARs through the store client.
	const narSource =
		nix?.storeKind === 'ssh-ng'
			? (storePath: string): PushNarArchive => nix.narFromPath(storePath)
			: createNarArchive;
	const compressNar = dependencies.compressNar ?? compressNarToStream;

	return runPushFlow(publication, reporter, {
		...dependencies,
		retention,
		nix,
		createNarArchive: narSource,
		compressNar,
		wait: dependencies.wait ?? true,
		waitTimeoutSeconds:
			dependencies.waitTimeoutSeconds ?? defaultWaitTimeoutSeconds
	});
}

interface PushRuntimeDependencies {
	readonly nix?: PushStore;
	readonly client: PushClient;
	readonly retention: RetentionPlan;
	readonly closure?: boolean;
	readonly referenceSource?: ReferenceSource;
	readonly fetchReferenceMetadata?: typeof fetchReferenceMetadataFromSource;
	readonly signal?: AbortSignal;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly wait: boolean;
	readonly waitTimeoutSeconds: WaitTimeoutSeconds;
	readonly runRoot?: UploadAttachRootInput;
	readonly attest?: boolean;
	readonly attestations?: readonly AttestationBundleSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
	readonly buildStore?: string;
	readonly alreadyHeld?: readonly string[];
	readonly claimable?: readonly string[];
	readonly delegated?: ReadonlyMap<string, string>;
	readonly copiedFrom?: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

// Keep the publication kind so local collection is reported differently for
// targets and intermediates.
type ResolvedPushPath =
	| {
			readonly source: 'local';
			readonly kind: PublicationKind;
			readonly pathInfo: NixValidPathInfo;
	  }
	| {
			readonly source: 'reference';
			readonly kind: PublicationKind;
			readonly storePath: StorePathString;
			readonly metadata: ReferenceMetadata;
	  };

interface CollectedPath {
	readonly storePathHash: StorePathHash;
	readonly storePath: string;
}

function resolvedStorePath(path: ResolvedPushPath): StorePathString {
	return path.source === 'local' ? path.pathInfo.storePath : path.storePath;
}

function resolvedNarHash(path: ResolvedPushPath): string {
	return path.source === 'local'
		? path.pathInfo.narHash.toString()
		: path.metadata.upload.narHash;
}

// Upload negotiation describes the uncompressed store object. A reference
// narinfo also describes its cached blob, but those file hash, size and
// compression fields do not belong in the negotiation request.
function negotiationOf(path: ResolvedPushPath): UploadPathNegotiationFields {
	if (path.source === 'local') {
		return prepareStorePathNegotiation(path.pathInfo);
	}

	const { upload } = path.metadata;

	return {
		storePathHash: upload.storePathHash,
		storePath: upload.storePath,
		narHash: upload.narHash,
		narSize: upload.narSize,
		references: upload.references,
		...(upload.deriver !== undefined && { deriver: upload.deriver }),
		...(upload.ca !== undefined && { ca: upload.ca })
	};
}

// Recognises both ways a source store reports collection: the store client's
// typed error and `ENOENT` from a filesystem NAR read.
function isVanishedPathError(error: unknown): boolean {
	if (error instanceof NixStorePathNotFoundError) {
		return true;
	}

	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Treat an unmatched server decision as a target. An intermediate may be
// reported as collected, so using that fallback could hide a protocol fault.
function kindOfDecision(
	negotiated: NegotiatedPaths,
	decision: UploadDecisionOf<'upload' | 'commit'>
): PublicationKind {
	return (
		negotiated.get(negotiatedPathKey(decision.storePathHash, decision.narHash))
			?.kind ?? 'target'
	);
}

// Reference publication requires the destination to reuse existing content. If
// negotiation requests an upload, report the typed per-path failure instead of
// attempting a local NAR read.
function requireLocalPathInfo(path: ResolvedPushPath): NixValidPathInfo {
	if (path.source === 'local') {
		return path.pathInfo;
	}

	throw new ReferenceUploadRequiredError(path.storePath);
}

function localPathInfos(
	resolved: readonly ResolvedPushPath[]
): readonly NixValidPathInfo[] {
	return resolved.flatMap((path) =>
		path.source === 'local' ? [path.pathInfo] : []
	);
}

// Fetch reference metadata concurrently, then restore declaration order. The
// hash in the request URL does not prove the complete path identity, so reject a
// narinfo whose `StorePath` differs from the requested entry.
async function resolveReferenceEntries(
	entries: readonly PublicationEntry[],
	dependencies: PushRuntimeDependencies
): Promise<readonly ResolvedPushPath[]> {
	if (entries.length === 0) {
		return [];
	}

	const source = dependencies.referenceSource;

	if (source === undefined) {
		throw new ReferenceSourcePairError();
	}

	const fetchMetadata =
		dependencies.fetchReferenceMetadata ?? fetchReferenceMetadataFromSource;
	const resolved = await mapWithConcurrency(
		entries,
		defaultUploadConcurrency,
		async (entry, index) => {
			const metadata = await fetchMetadata(
				source,
				StorePath.hash(entry.storePath),
				{ signal: dependencies.signal }
			);

			if (metadata.upload.storePath !== entry.storePath) {
				throw new ReferencePathMismatchError(
					entry.storePath,
					metadata.upload.storePath
				);
			}

			return {
				index,
				path: {
					source: 'reference' as const,
					kind: entry.kind,
					storePath: entry.storePath,
					metadata
				}
			};
		}
	);

	return resolved
		.toSorted((left, right) => left.index - right.index)
		.map((item) => item.path);
}

interface ReceiptClaims {
	readonly buildStore: string;
	readonly alreadyHeld: ReadonlySet<string>;
	/**
	`undefined` leaves every published path eligible for build attribution.
	*/
	readonly claimable: ReadonlySet<string> | undefined;
	readonly delegated: ReadonlyMap<string, string>;
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	readonly referenceSource: string | undefined;
}

// Claim a current-run build only when the selected store reports a deriver and
// the run's evidence shows it realised the path. Pre-existing and ineligible
// paths are excluded. `ultimate` proves the selected store built the output;
// activity logs can instead prove a delegated builder produced it. Any other
// path falls back to store-derived provenance in `publishedSubjects`.
function builtSubject(
	claims: ReceiptClaims,
	pathInfo: NixValidPathInfo
): BuildSubjectV3Input | undefined {
	if (pathInfo.deriver === undefined) {
		return undefined;
	}

	if (
		claims.claimable !== undefined &&
		!claims.claimable.has(pathInfo.storePath)
	) {
		return undefined;
	}

	if (claims.alreadyHeld.has(pathInfo.storePath)) {
		return undefined;
	}

	const machine = claims.delegated.get(pathInfo.deriver);

	if (machine === undefined && !pathInfo.ultimate) {
		return undefined;
	}

	return {
		origin: 'built',
		storePath: pathInfo.storePath,
		narHash: pathInfo.narHash.digestHex(),
		derivation: pathInfo.deriver,
		buildStore: claims.buildStore,
		...(machine !== undefined && { machine }),
		verification: 'build-store'
	};
}

/**
 * Current-run build evidence and reference narinfos establish preferred
 * subjects for paths that reached a final servable outcome;
 * `publishedSubjects` fills the remainder from selected-store metadata.
 */
function reconciledReceipt(
	claims: ReceiptClaims,
	resolved: readonly ResolvedPushPath[],
	summaryPaths: readonly PushSummaryPathInput[]
): BuildReceiptV3 {
	const servable = new Set<string>();
	const published = new Set<string>();

	for (const path of summaryPaths) {
		if (path.storePath === undefined) {
			continue;
		}

		if (path.outcome === 'committed') {
			published.add(path.storePath);
		}

		if (path.outcome === 'committed' || path.outcome === 'already-present') {
			servable.add(path.storePath);
		}
	}

	const infos = resolved.flatMap((path) =>
		path.source === 'local' ? [path.pathInfo] : []
	);
	const described = new Map<string, BuildSubjectV3Input>();

	for (const pathInfo of infos) {
		const subject = builtSubject(claims, pathInfo);

		if (subject !== undefined) {
			described.set(pathInfo.storePath, subject);
		}
	}

	for (const path of resolved) {
		if (path.source !== 'reference' || claims.referenceSource === undefined) {
			continue;
		}

		described.set(
			path.storePath,
			republishedSubject(path.metadata, claims.referenceSource)
		);
	}

	return buildReceiptV3Schema.parse({
		version: 3,
		paths: [...servable].toSorted(byCodeUnit),
		subjects: publishedSubjects({
			described,
			infos,
			servable,
			buildStore: claims.buildStore,
			copiedFrom: claims.copiedFrom
		}),
		uploaded: [...published].toSorted(byCodeUnit)
	});
}

async function runPushFlow(
	publication: PublicationCollection,
	reporter: Reporter,
	dependencies: PushRuntimeDependencies
): Promise<BuildReceiptV3 | undefined> {
	const {
		nix,
		client,
		retention,
		createNarArchive,
		compressNar,
		wait: shouldWait,
		waitTimeoutSeconds
	} = dependencies;
	// A path that fails to resolve, upload or commit is recorded here, so the
	// paths that can finish still do. The push then fails as a whole (see the end
	// of this function) so the incomplete result is never mistaken for a finished
	// one. A vanished intermediate is not a failure: it is recorded as collected
	// and the run continues.
	const failures: PushFailure[] = [];
	const collected: CollectedPath[] = [];

	// Resolve local declarations from the selected store, expanding only those
	// entries when closure publication is enabled. Resolve references from their
	// source narinfos without touching the local store. A missing local target is
	// a per-path failure; a missing intermediate is recorded as collected.
	const resolved = await reporter.phase(
		dependencies.closure === true
			? 'Resolving store closure'
			: 'Resolving store paths',
		async (ctx) => {
			ctx.fact('roots', formatCount(publication.entries.length));
			const localPaths = publication.localEntries.map(
				(entry) => entry.storePath
			);
			const localInfos =
				nix === undefined || localPaths.length === 0
					? []
					: dependencies.closure === true
						? await nix.resolveClosure(localPaths)
						: await nix.queryValidPathsInfo(localPaths);
			const present = new Set(localInfos.map((info) => info.storePath));

			for (const storePath of localPaths) {
				if (present.has(storePath)) {
					continue;
				}

				const vanished = new NixStorePathNotFoundError(storePath);

				if (publication.kindOf(storePath) === 'intermediate') {
					collected.push({
						storePathHash: StorePath.hash(storePath),
						storePath
					});
					continue;
				}

				failures.push({
					storePathHash: StorePath.hash(storePath),
					storePath,
					stage: 'resolve',
					reason: failureReason(vanished)
				});
				ctx.warn(
					'vanished target',
					`${StorePath.basename(storePath)}: ${failureReason(vanished)}`
				);
			}

			const paths: ResolvedPushPath[] = [
				...localInfos.map((pathInfo): ResolvedPushPath => ({
					source: 'local',
					kind: publication.kindOf(pathInfo.storePath),
					pathInfo
				})),
				...(await resolveReferenceEntries(
					publication.referenceEntries,
					dependencies
				))
			];
			ctx.fact('paths', formatCount(paths.length));

			if (collected.length > 0) {
				ctx.fact('collected', formatCount(collected.length));
			}

			return paths;
		}
	);

	if (dependencies.dryRun === true) {
		await reportDryRun(reporter, client, resolved, retention);
		return undefined;
	}

	const { response: negotiation, hasGraceFacts } = await reporter.phase(
		'Negotiating with cache',
		async (ctx) => {
			if (retention.kind === 'none') {
				await requireUploadGraceFacts(client, 'negotiate');
			}

			const response = await negotiateUpload(
				client,
				resolved.map((path) => negotiationOf(path)),
				dependencies.runRoot
			);
			const uploadCount = response.uploads.filter((decision) =>
				isUpload(decision)
			).length;

			ctx.fact('upload', formatCount(uploadCount));
			ctx.fact(
				'skip',
				formatCount(
					response.uploads.filter((decision) => isSkip(decision)).length
				)
			);

			return {
				response,
				hasGraceFacts: client.hasUploadGraceFacts?.() ?? true
			};
		}
	);

	const divergent = divergentSkips(resolved, negotiation.uploads);

	warnDivergentSkips(reporter, divergent);

	const uploadDecisions = negotiation.uploads.filter((item) => isUpload(item));
	const failedUploadIds = new Set<string>();
	const negotiated = indexNegotiatedPaths(resolved);
	const storePathByHash = new Map<StorePathHash, string>(
		resolved.map((path) => [
			StorePath.hash(resolvedStorePath(path)),
			resolvedStorePath(path)
		])
	);

	let uploadedBytes = 0;
	const onBytes = (count: number): void => {
		uploadedBytes += count;
	};
	const uploadContext: UploadContext = {
		client,
		negotiated,
		createNarArchive,
		compressNar,
		onBytes
	};
	const uploaded: UploadDecisionOf<'upload'>[] = [];

	await reporter.progress(
		'Uploading missing NARs',
		{ total: uploadDecisions.length },
		async (bar) => {
			let done = 0;
			bar.fact(
				'nars',
				`${formatCount(done)}/${formatCount(uploadDecisions.length)}`
			);

			await mapWithConcurrency(
				uploadDecisions,
				dependencies.uploadConcurrency ?? defaultUploadConcurrency,
				async (decision) => {
					try {
						await streamNarUpload(decision, uploadContext);
						uploaded.push(decision);
						done += 1;
					} catch (error) {
						if (isAbortError(error)) {
							throw error;
						}

						const storePath =
							storePathByHash.get(decision.storePathHash) ??
							decision.storePathHash;
						failedUploadIds.add(decision.uploadId);

						// An intermediate whose path vanished before its NAR read is
						// recorded as collected and the run continues; a vanished
						// target, and every other loss, joins the failures.
						if (
							isVanishedPathError(error) &&
							kindOfDecision(negotiated, decision) === 'intermediate'
						) {
							collected.push({
								storePathHash: decision.storePathHash,
								storePath
							});
							bar.fact('collected', formatCount(collected.length));
							return;
						}

						const reason = failureReason(error);
						failures.push({
							storePathHash: decision.storePathHash,
							storePath,
							stage: 'upload',
							reason
						});
						bar.warn(
							'upload failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
					} finally {
						bar.advance(1);
						bar.fact(
							'nars',
							`${formatCount(done)}/${formatCount(uploadDecisions.length)}`
						);
					}
				}
			);
		}
	);

	// Start every commit before awaiting deferred verification. The server can
	// verify those paths in one pass; serial commits could require a separate
	// pass for each path. With `--no-wait`, a deferred commit returns `pending`
	// once the server has stored its metadata.
	const commitDecisions = [
		...uploaded,
		...negotiation.uploads.filter((decision) => isReusedBlobCommit(decision))
	].filter((decision) => !failedUploadIds.has(decision.uploadId));
	const commitOptions: CommitOptions = {
		timeoutSeconds: waitTimeoutSeconds,
		onWaiting: capacityWaitReporter(reporter)
	};
	const session = await client.openCommitSession?.(commitOptions);
	// A re-drive replaces the original outcome for the same store path. The
	// summary therefore reports only the latest commit attempt.
	const outcomes = new Map<StorePathHash, CommitOutcome>();
	// A re-drive can change the action, for example when a reused blob is
	// collected and the next negotiation requests an upload. Keep only the
	// latest action for the summary counts.
	const effectiveActions = new Map<string, UploadDecision['action']>(
		negotiation.uploads.map((decision) => [
			decision.storePathHash,
			decision.action
		])
	);
	// Exclude collected intermediates because publication did not complete their
	// negotiated actions.
	for (const path of collected) {
		effectiveActions.delete(path.storePathHash);
	}
	const commitContext: CommitContext = {
		client,
		session,
		negotiated,
		createNarArchive,
		compressNar,
		options: commitOptions,
		hasGraceFacts,
		...(dependencies.runRoot !== undefined && {
			runRoot: dependencies.runRoot
		}),
		onBytes,
		onRedriven: (fresh) => {
			effectiveActions.set(fresh.storePathHash, fresh.action);
		}
	};

	try {
		const commit = await reporter.progress(
			'Committing metadata',
			{ total: commitDecisions.length },
			async (bar) => {
				const settled = await Promise.allSettled(
					commitDecisions.map(async (decision) => {
						try {
							return await commitNegotiated(decision, commitContext);
						} finally {
							bar.advance(1);
						}
					})
				);

				// A pending outcome means the server reserved the row but has not made
				// the path servable. Preserve the decision so an `absent` verdict can
				// be negotiated again. Identify the outcome by store-path hash because
				// a re-drive receives a new upload ID.
				const pending: {
					decision: UploadDecisionOf<'upload' | 'commit'>;
					storePathHash: StorePathHash;
					settled: Promise<void>;
				}[] = [];
				let committed = 0;

				for (const [index, result] of settled.entries()) {
					const decision = commitDecisions[index];

					if (decision === undefined) {
						continue;
					}

					if (result.status === 'rejected') {
						if (isAbortError(result.reason)) {
							throw result.reason;
						}

						const storePath =
							storePathByHash.get(decision.storePathHash) ??
							decision.storePathHash;
						const reason = failureReason(result.reason);
						failures.push({
							storePathHash: decision.storePathHash,
							storePath,
							stage: 'commit',
							reason
						});
						bar.warn(
							'commit failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
						continue;
					}

					outcomes.set(result.value.storePathHash, result.value);

					if (result.value.status === 'pending') {
						pending.push({
							decision,
							storePathHash: result.value.storePathHash,
							settled: result.value.settled
						});
					} else {
						committed += 1;
					}
				}

				bar.fact('committed', formatCount(committed));

				return { pending };
			}
		);

		// A reserved row is enough for a root to refer to the path, even while
		// verification is pending. Record retention before waiting so it survives
		// a client disconnect. A failed commit creates no row and prevents all
		// retention updates for this push.
		const isIncomplete = failures.length > 0;

		if (isIncomplete) {
			reporter.warn(
				'incomplete',
				`${formatCount(failures.length)} path(s) failed to publish; retention not recorded, re-run cupboard push to finish`
			);
		}

		const retentionRows = isIncomplete
			? []
			: await reporter.phase(retentionPhaseLabel(retention), (ctx) =>
					recordRetention(retention, client, ctx)
				);

		// Retention is already recorded, so the wait phase only collects the
		// verdicts. A deferred path that fails verification fails the push.
		// `--no-wait` leaves the server to reach their verdicts and reports them
		// as pending.
		if (shouldWait && commit.pending.length > 0) {
			await reporter.progress(
				'Verifying uploads',
				{ total: commit.pending.length },
				async (bar) => {
					const verdicts = await Promise.allSettled(
						commit.pending.map(async (entry) => {
							try {
								await awaitDeferredVerdict(entry, commitContext, outcomes);
							} finally {
								bar.advance(1);
							}
						})
					);

					for (const [index, result] of verdicts.entries()) {
						const entry = commit.pending[index];

						if (entry === undefined || result.status === 'fulfilled') {
							continue;
						}

						if (isAbortError(result.reason)) {
							throw result.reason;
						}

						const storePath =
							storePathByHash.get(entry.storePathHash) ?? entry.storePathHash;
						const reason = failureReason(result.reason);
						failures.push({
							storePathHash: entry.storePathHash,
							storePath,
							stage: 'verify',
							reason
						});
						bar.warn(
							'verification failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
					}
				}
			);
		}

		// Attestations attach only to a committed narinfo row, so they run after the
		// wait, once a deferred path has verified and materialised. A path that
		// failed (at commit or verification) has no such row, and `--no-wait` leaves
		// its deferred paths pending, so both are skipped.
		const unservableStorePathHashes = new Set<StorePathHash>(
			failures.map((failure) => failure.storePathHash)
		);
		if (!shouldWait) {
			for (const entry of commit.pending) {
				unservableStorePathHashes.add(entry.storePathHash);
			}
		}

		const attestationRows = await attachPushedAttestations(
			localPathInfos(resolved),
			reporter,
			{
				client,
				enabled: dependencies.attest ?? true,
				sources: dependencies.attestations ?? [],
				readBundle:
					dependencies.readAttestationBundle ?? defaultReadAttestationBundle,
				pendingStorePathHashes: unservableStorePathHashes,
				divergent
			}
		);

		const actions = effectiveActions.values().toArray();
		const uploadedPaths = actions.filter(
			(action) => action === 'upload'
		).length;
		const reusedBlobs = actions.filter((action) => action === 'commit').length;
		const skipped = actions.filter((action) => action === 'skip').length;
		const failedStorePathHashes = new Set(
			failures.map((failure) => failure.storePathHash)
		);
		const summaryPaths: PushSummaryPathInput[] = [
			...negotiation.uploads
				.filter((decision) => isSkip(decision))
				.map((decision) => ({
					storePathHash: decision.storePathHash,
					storePath: storePathByHash.get(decision.storePathHash),
					outcome: 'already-present' as const,
					...(decision.grace !== undefined && { grace: decision.grace })
				})),
			...outcomes
				.entries()
				.filter(([storePathHash]) => !failedStorePathHashes.has(storePathHash))
				.map(([storePathHash, outcome]) =>
					committedOrPendingPath(
						storePathHash,
						outcome,
						shouldWait,
						storePathByHash
					)
				),
			...collected.map((path) => ({
				storePathHash: path.storePathHash,
				storePath: path.storePath,
				outcome: 'collected' as const
			}))
		];
		const summary = {
			uploadedPaths,
			reusedBlobs,
			skipped,
			uploadedBytes,
			failures,
			paths: summaryPaths
		};
		// Server data can make a locally assembled failure entry invalid, for
		// example by leaving only a hash where the schema expects a store path.
		// Preserve the unvalidated summary so reporting does not hide the original
		// push failure.
		const validated = pushSummarySchema.safeParse(summary);

		reporter.result({
			kind: pushSummaryResultKind,
			data: validated.success ? validated.data : summary,
			rows: [
				{ label: 'Uploaded paths', value: formatCount(uploadedPaths) },
				{ label: 'Already cached', value: formatCount(reusedBlobs) },
				{ label: 'Skipped', value: formatCount(skipped) },
				{ label: 'Bytes uploaded', value: formatBytes(uploadedBytes) },
				...(collected.length > 0
					? [{ label: 'Collected', value: formatCount(collected.length) }]
					: []),
				...attestationRows,
				...retentionRows,
				...pushSummaryPathRows(summaryPaths, retention),
				...(failures.length > 0
					? [{ label: 'Failed', value: formatCount(failures.length) }]
					: [])
			]
		});
		unretainedUngracedWarning(reporter, retention, summaryPaths);

		// Report every successful path first, then fail the overall command so a
		// caller cannot treat a partial publication as complete.
		if (failures.length > 0) {
			throw new PushIncompleteError(
				failures.map((failure) => StorePath.basename(failure.storePath))
			);
		}

		return dependencies.buildStore === undefined
			? undefined
			: reconciledReceipt(
					{
						buildStore: dependencies.buildStore,
						alreadyHeld: new Set(dependencies.alreadyHeld),
						claimable:
							dependencies.claimable === undefined
								? undefined
								: new Set(dependencies.claimable),
						delegated: dependencies.delegated ?? new Map(),
						copiedFrom: dependencies.copiedFrom ?? new Map(),
						referenceSource:
							dependencies.referenceSource === undefined
								? undefined
								: canonicalHref(dependencies.referenceSource.url)
					},
					resolved,
					summaryPaths
				);
	} finally {
		session?.close();
	}
}

async function reportDryRun(
	reporter: Reporter,
	client: PushClient,
	resolved: readonly ResolvedPushPath[],
	retention: RetentionPlan
): Promise<void> {
	const preview = await reporter.phase(
		'Previewing against cache',
		async (ctx) => {
			if (retention.kind === 'none') {
				await requireUploadGraceFacts(client, 'preview');
			}

			const response = await previewUpload(
				client,
				resolved.map((path) => negotiationOf(path))
			);

			ctx.fact(
				'upload',
				formatCount(
					response.uploads.filter((decision) => decision.action === 'upload')
						.length
				)
			);
			ctx.fact(
				'skip',
				formatCount(
					response.uploads.filter((decision) => decision.action === 'skip')
						.length
				)
			);

			return response;
		}
	);

	warnDivergentSkips(reporter, divergentSkips(resolved, preview.uploads));

	const wouldUpload = preview.uploads.filter(
		(decision) => decision.action === 'upload'
	).length;
	const reusedBlobs = preview.uploads.filter(
		(decision) => decision.action === 'commit'
	).length;
	const skipped = preview.uploads.filter(
		(decision) => decision.action === 'skip'
	).length;

	reporter.result({
		kind: 'push-plan',
		data: { wouldUpload, reusedBlobs, skipped, paths: preview.uploads },
		rows: [
			{ label: 'Would upload', value: formatCount(wouldUpload) },
			{ label: 'Already cached', value: formatCount(reusedBlobs) },
			{ label: 'Skipped', value: formatCount(skipped) },
			...retentionPlanRows(retention),
			...previewPathRows(preview.uploads, retention)
		]
	});
	unretainedUngracedWarning(reporter, retention, preview.uploads);
}

// A stored deadline is an existing server fact. This wording is shared by real
// pushes and by dry-run rows for paths already present in the cache.
function graceRetainUntilRow(retainUntil: string): string {
	return `kept until ${formatTimestamp(retainUntil)}`;
}

function pushSummaryPathRow(path: PushSummaryPathInput): ResultRow {
	if (path.outcome === 'collected') {
		return {
			label: path.storePathHash,
			value: 'collected from the store before publication; not published'
		};
	}

	if (path.grace?.retainUntil !== undefined) {
		return {
			label: path.storePathHash,
			value: graceRetainUntilRow(path.grace.retainUntil)
		};
	}

	const graceSeconds = path.grace?.graceSeconds;

	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label: path.storePathHash,
			value:
				path.outcome === 'pending'
					? `pending (grace ${formatCount(graceSeconds)}s)`
					: `captured grace ${formatCount(graceSeconds)}s`
		};
	}

	if (graceSeconds === 0) {
		return { label: path.storePathHash, value: zeroGraceRow };
	}

	return {
		label: path.storePathHash,
		value: 'no cache retention grace configured'
	};
}

// Rooted and pinned pushes omit these rows unless the server returned at least
// one grace fact. Otherwise the human report would repeat the absence of a
// configured grace for every path. An unretained push always shows the rows because grace
// is its only possible retention. JSON output always includes every path fact.
function pushSummaryPathRows(
	paths: readonly PushSummaryPathInput[],
	retention: RetentionPlan
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		paths.every((path) => !hasGraceFact(path.grace))
	) {
		return [];
	}

	return cappedPathRows(paths.map((path) => pushSummaryPathRow(path)));
}

// The human report caps the per-path rows; the JSON output always lists
// every path.
const maxPathRows = 20;

function cappedPathRows(rows: readonly ResultRow[]): readonly ResultRow[] {
	if (rows.length <= maxPathRows) {
		return rows;
	}

	return [
		...rows.slice(0, maxPathRows),
		{
			label: '…',
			value: `${formatCount(rows.length - maxPathRows)} more path(s); the full list is in the JSON output`
		}
	];
}

// Distinguish zero grace from a cache without configured grace.
const zeroGraceRow = 'configured zero grace; no grace period applies';

// An unretained push needs a positive grace fact to survive collection. Keep a
// zero-grace configuration distinct from a cache without configured grace in the
// warning.
function unretainedUngracedWarning(
	reporter: Reporter,
	retention: RetentionPlan,
	paths: readonly {
		grace?: { retainUntil?: string; graceSeconds?: number };
	}[]
): void {
	if (retention.kind !== 'none') {
		return;
	}

	const hasPositiveFact = paths.some(
		(path) =>
			path.grace?.retainUntil !== undefined ||
			(path.grace?.graceSeconds ?? 0) > 0
	);

	if (hasPositiveFact) {
		return;
	}

	const isZeroMatched = paths.some((path) => path.grace?.graceSeconds === 0);

	reporter.warn(
		'unretained',
		isZeroMatched
			? 'the cache has zero retention grace; these paths have no retention root or grace deadline, so the next collection can remove them'
			: 'the cache has no retention grace; these paths have no retention root or grace deadline, so the next collection can remove them'
	);
}

function hasGraceFact(
	grace: { retainUntil?: string; graceSeconds?: number } | undefined
): boolean {
	return grace?.retainUntil !== undefined || grace?.graceSeconds !== undefined;
}

// An `upload` or `commit` preview can report only the grace a real push would
// capture. A `skip` refers to a path already in the cache, so it can report the
// current stored deadline. It does not include the extension that a real push
// would apply.
function previewPathRow(decision: UploadPreviewDecision): ResultRow {
	if (decision.grace?.retainUntil !== undefined) {
		return {
			label: decision.storePathHash,
			value: graceRetainUntilRow(decision.grace.retainUntil)
		};
	}

	const graceSeconds = decision.grace?.graceSeconds;

	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label: decision.storePathHash,
			value:
				decision.action === 'skip'
					? `a push would extend its grace ${formatCount(graceSeconds)}s`
					: `would capture grace ${formatCount(graceSeconds)}s`
		};
	}

	if (graceSeconds === 0) {
		return { label: decision.storePathHash, value: zeroGraceRow };
	}

	return {
		label: decision.storePathHash,
		value: 'no cache retention grace configured'
	};
}

// An unretained plan always shows per-path grace results.
function previewPathRows(
	decisions: readonly UploadPreviewDecision[],
	retention: RetentionPlan
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		decisions.every((decision) => !hasGraceFact(decision.grace))
	) {
		return [];
	}

	return cappedPathRows(decisions.map((decision) => previewPathRow(decision)));
}

// Deferred verification produces a final deadline only after the wait phase
// receives its verdict. Without that wait, report the path as `pending` with
// the grace captured when the server reserved the row.
function committedOrPendingPath(
	storePathHash: StorePathHash,
	outcome: CommitOutcome,
	shouldWait: boolean,
	storePathByHash: ReadonlyMap<StorePathHash, string>
): PushSummaryPathInput {
	const isFinal = outcome.status !== 'pending' || shouldWait;
	const grace = isFinal
		? (outcome.verdictGrace?.() ?? outcome.grace)
		: outcome.grace;

	return {
		storePathHash,
		storePath: storePathByHash.get(storePathHash),
		outcome:
			outcome.status === 'already-present'
				? 'already-present'
				: isFinal
					? 'committed'
					: 'pending',
		...(grace !== undefined && { grace })
	};
}

function retentionPlanRows(retention: RetentionPlan): ResultRow[] {
	if (retention.kind === 'none') {
		return [{ label: 'Retention', value: noRetainLabel }];
	}

	if (retention.kind === 'root') {
		return [
			{ label: 'Would set root', value: retention.name },
			{
				label: 'Root expiry',
				value: planExpiry(retention.request.body.ttlSeconds)
			}
		];
	}

	return [
		{ label: 'Would pin paths', value: formatCount(retention.requests.length) },
		{
			label: 'Pin expiry',
			value: planExpiry(retention.requests[0]?.body.ttlSeconds)
		}
	];
}

function planExpiry(ttlSeconds: number | undefined): string {
	return ttlSeconds === undefined
		? 'permanent'
		: `expires after ${formatCount(ttlSeconds)}s`;
}

interface AttachAttestationsDependencies {
	readonly client: PushClient;
	readonly enabled: boolean;
	readonly sources: readonly AttestationBundleSource[];
	readonly readBundle: ReadAttestationBundle;
	readonly pendingStorePathHashes: ReadonlySet<StorePathHash>;
	readonly divergent: ReadonlyMap<StorePathHash, DivergentSkip>;
}

interface AttestationSummary {
	readonly uploaded: number;
	readonly reused: number;
	readonly deferred: number;
	readonly uploadedBytes: number;
}

async function attachPushedAttestations(
	pathInfos: readonly NixValidPathInfo[],
	reporter: Reporter,
	dependencies: AttachAttestationsDependencies
): Promise<readonly ResultRow[]> {
	if (!dependencies.enabled || dependencies.sources.length === 0) {
		return [];
	}

	return reporter.steps('Attestations', async (log) => {
		const readStep = log.group('read');
		const prepared = await prepareAttestationBundles(pathInfos, {
			sources: dependencies.sources,
			readBundle: dependencies.readBundle,
			divergent: dependencies.divergent
		});
		readStep.success(`${formatCount(prepared.length)} bundle(s)`);

		const ready = prepared.filter(
			(bundle) => !dependencies.pendingStorePathHashes.has(bundle.storePathHash)
		);
		const deferred = prepared.length - ready.length;

		if (deferred > 0) {
			log.warn(
				'pending verification',
				`${formatCount(deferred)} attestation bundle(s) describe path(s) still awaiting server-side verification; the push did not attach them`
			);
		}

		if (ready.length === 0) {
			return attestationResultRows({
				uploaded: 0,
				reused: 0,
				deferred,
				uploadedBytes: 0
			});
		}

		const outcome = await runAttestationAttachment(ready, log, {
			client: requireAttestationAttachClient(dependencies.client)
		});

		return attestationResultRows({
			uploaded: outcome.attached,
			reused: outcome.reused,
			deferred,
			uploadedBytes: outcome.uploadedBytes
		});
	});
}

function attestationResultRows(
	summary: AttestationSummary
): readonly ResultRow[] {
	const status = [
		`${formatCount(summary.uploaded)} attached`,
		`${formatCount(summary.reused)} reused`,
		`${formatCount(summary.deferred)} deferred`
	].join(', ');

	return [
		{ label: 'Attestations', value: status },
		{ label: 'Attestation upload', value: formatBytes(summary.uploadedBytes) }
	];
}

interface RootRequest {
	readonly name: string;
	readonly body: RootSetBodyInput;
}

export class RootTargetLimitError extends UsageError {
	constructor(
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`the named root would contain ${String(count)} targets, but a root accepts ` +
				`at most ${String(limit)}; split the paths across named roots`
		);
		this.name = 'RootTargetLimitError';
	}
}

// The CLI cannot see the cache's configured retention grace, so the
// `--no-retain` label makes no claim about it.
const noRetainLabel = 'none (--no-retain)';

type RetentionPlan =
	| {
			readonly kind: 'root';
			readonly name: RootName;
			readonly request: RootRequest;
	  }
	| { readonly kind: 'pins'; readonly requests: readonly RootRequest[] }
	| { readonly kind: 'none' };

function planRetention(
	paths: readonly string[],
	root: RootName | undefined,
	ttlSeconds: TtlSeconds | undefined,
	shouldRetain: boolean
): RetentionPlan {
	if (!shouldRetain) {
		return { kind: 'none' };
	}

	if (root !== undefined && paths.length > rootSetMaxTargets) {
		throw new RootTargetLimitError(paths.length, rootSetMaxTargets);
	}

	const ttlFields = ttlSeconds === undefined ? {} : { ttlSeconds };

	if (root !== undefined) {
		return {
			kind: 'root',
			name: root,
			request: { name: root, body: { targets: [...paths], ...ttlFields } }
		};
	}

	return {
		kind: 'pins',
		requests: paths.map((path) => ({
			name: implicitPinName(StorePath.hash(path)),
			body: { targets: [path], ...ttlFields }
		}))
	};
}

function retentionPhaseLabel(retention: RetentionPlan): string {
	switch (retention.kind) {
		case 'root': {
			return 'Updating retention root';
		}

		case 'pins': {
			return 'Pinning pushed paths';
		}

		case 'none': {
			return 'Recording retention';
		}
	}
}

async function recordRetention(
	retention: RetentionPlan,
	client: PushClient,
	ctx: PhaseContext
): Promise<readonly ResultRow[]> {
	if (retention.kind === 'none') {
		ctx.fact('retention', noRetainLabel);

		return [{ label: 'Retention', value: noRetainLabel }];
	}

	if (retention.kind === 'root') {
		const { name, body } = retention.request;
		const summary = await client.setRoot(name, body);
		const expiry = formatExpiry(summary);
		ctx.fact('root', retention.name);
		ctx.fact('expiry', expiry);

		return [
			{ label: 'Root', value: retention.name },
			{ label: 'Root expiry', value: expiry }
		];
	}

	// Each pin is a separate root request, and the requests are independent, so
	// they are sent concurrently under the same limit as blob uploads. The
	// expiry summary sorts the results, so the order they arrive in does not
	// affect it.
	const summaries: RootSummaryInput[] = [];

	await mapWithConcurrency(
		retention.requests,
		defaultUploadConcurrency,
		async ({ name, body }) => {
			summaries.push(await client.setRoot(name, body));
		}
	);

	const expiry = describePinExpiry(summaries);
	ctx.fact('pins', formatCount(retention.requests.length));
	ctx.fact('expiry', expiry);

	return [
		{ label: 'Pinned paths', value: formatCount(retention.requests.length) },
		{ label: 'Pin expiry', value: expiry }
	];
}

function formatExpiry(summary: RootSummaryInput): string {
	return summary.expiresAt === undefined
		? 'permanent'
		: `expires ${formatTimestamp(summary.expiresAt)}`;
}

function describePinExpiry(summaries: readonly RootSummaryInput[]): string {
	// The comparison below is on the rendered timestamps, so expiries that differ
	// only below the displayed minute report as one value rather than as a range
	// between two identical timestamps.
	const expiries = summaries
		.map((summary) => summary.expiresAt)
		.filter((expiresAt) => expiresAt !== undefined)
		.toSorted(byCodeUnit)
		.map((expiresAt) => formatTimestamp(expiresAt));
	const earliest = expiries.at(0);
	const latest = expiries.at(-1);

	if (earliest === undefined || latest === undefined) {
		return 'permanent';
	}

	return earliest === latest
		? `expires ${earliest}`
		: `expires ${earliest} to ${latest}`;
}

interface UploadContext {
	readonly client: PushClient;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly onBytes: (count: number) => void;
}

// Stream compression keeps large closures out of the runner's temporary
// storage. Once the stream ends, compare its uncompressed hash and size with
// the negotiated metadata so changed source bytes cannot be committed under
// stale path metadata.
async function streamNarUpload(
	decision: UploadDecisionOf<'upload'>,
	context: UploadContext
): Promise<void> {
	const pathInfo = requireLocalPathInfo(
		findNegotiatedPath(context.negotiated, decision)
	);
	const upload = context.compressNar(
		context.createNarArchive(pathInfo.storePath)
	);

	await context.client.uploadNar(
		decision.r2Key,
		countingByteStream(upload.body, context.onBytes)
	);
	verifyNarMetadata(pathInfo, upload.digest());
}

interface CommitContext {
	readonly client: PushClient;
	readonly session: CommitSession | undefined;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly options: CommitOptions;
	readonly hasGraceFacts: boolean;
	// Re-drives must attach the replacement pending row to the same run root.
	readonly runRoot?: UploadAttachRootInput;
	readonly onBytes: (count: number) => void;
	readonly onRedriven: (fresh: UploadDecision) => void;
}

// A minimal client that opens no shared session uses its per-path commit.
function commitVia(
	context: CommitContext,
	target: CommitTarget
): Promise<CommitOutcome> {
	if (context.session === undefined) {
		return context.client.commit(target, context.options);
	}

	return context.session.commit(target);
}

function commitTarget(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	shouldReportGraceFacts: boolean
): CommitTarget {
	return {
		uploadId: decision.uploadId,
		storePathHash: decision.storePathHash,
		narHash: decision.narHash,
		...(shouldReportGraceFacts && { retention: true as const })
	};
}

// An `absent` verdict means the pending row or its shared blob was collected
// before verification. Renegotiation recovers it in the same way as a
// commit-time `NOT_FOUND`.
function isAbsentVerdict(error: unknown): boolean {
	return (
		error instanceof UploadVerificationFailedError && error.status === 'absent'
	);
}

// Pending rows can expire during a long upload phase, and a reused blob can be
// collected between negotiation and commit. Re-negotiate after the resulting
// `NOT_FOUND` or `absent` verdict. The replacement commit bypasses this wrapper
// so a second loss propagates.
async function commitNegotiated(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	context: CommitContext
): Promise<CommitOutcome> {
	try {
		return await commitVia(
			context,
			commitTarget(decision, context.hasGraceFacts)
		);
	} catch (error) {
		if (!isStaleUploadError(error) && !isAbsentVerdict(error)) {
			throw error;
		}

		return redriveExpiredCommit(decision, context);
	}
}

// After an `absent` verdict, replace the expired commit and wait for its new
// verdict. Retention already refers to the store path, so the replacement row
// needs no additional root update. A second loss propagates to the wait phase.
async function awaitDeferredVerdict(
	entry: {
		readonly decision: UploadDecisionOf<'upload' | 'commit'>;
		readonly settled: Promise<void>;
	},
	context: CommitContext,
	outcomes: Map<StorePathHash, CommitOutcome>
): Promise<void> {
	try {
		await entry.settled;
	} catch (error) {
		if (isAbortError(error) || !isAbsentVerdict(error)) {
			throw error;
		}

		const redriven = await redriveExpiredCommit(entry.decision, context);
		outcomes.set(redriven.storePathHash, redriven);
		await redriven.settled;
	}
}

// Replace an expired commit according to a fresh negotiation. A reusable blob
// can be committed directly, a missing blob requires another upload, and a
// path now served by the destination needs no commit. Expiring a pending row
// also removes its staged bytes, so an upload decision must send the NAR again.
async function redriveExpiredCommit(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	context: CommitContext
): Promise<CommitOutcome> {
	const resolved = findNegotiatedPath(context.negotiated, decision);
	const renegotiation = await negotiateUpload(
		context.client,
		[negotiationOf(resolved)],
		context.runRoot
	);
	const fresh = renegotiation.uploads.at(0);

	if (fresh === undefined) {
		throw new UnexpectedUploadDecisionError(
			decision.storePathHash,
			decision.narHash
		);
	}

	context.onRedriven(fresh);

	if (isReusedBlobCommit(fresh)) {
		return commitVia(context, commitTarget(fresh, context.hasGraceFacts));
	}

	if (isSkip(fresh)) {
		// A skip is already servable and has no deferred verdict.
		return {
			storePathHash: fresh.storePathHash,
			narHash: fresh.narHash,
			status: 'already-present',
			settled: Promise.resolve(),
			...(fresh.grace !== undefined && { grace: fresh.grace })
		};
	}

	// The replacement upload must read the NAR again. Reference entries have no
	// local NAR source, so `requireLocalPathInfo` rejects this recovery path.
	const pathInfo = requireLocalPathInfo(resolved);
	const upload = context.compressNar(
		context.createNarArchive(pathInfo.storePath)
	);

	await context.client.uploadNar(
		fresh.r2Key,
		countingByteStream(upload.body, context.onBytes)
	);
	verifyNarMetadata(pathInfo, upload.digest());

	return commitVia(context, commitTarget(fresh, context.hasGraceFacts));
}

function verifyNarMetadata(
	pathInfo: NixValidPathInfo,
	digest: NarDigest
): NixValidPathInfo {
	const expectedNarHash = pathInfo.narHash.toString();
	const actualNarHash = digest.narHash.toString();

	if (
		expectedNarHash === actualNarHash &&
		pathInfo.narSize === digest.narSize
	) {
		return pathInfo;
	}

	throw new PushNarMetadataMismatchError(
		pathInfo.storePath,
		expectedNarHash,
		actualNarHash,
		pathInfo.narSize,
		digest.narSize
	);
}

function divergentSkips(
	resolved: readonly ResolvedPushPath[],
	decisions: readonly (UploadDecision | UploadPreviewDecision)[]
): ReadonlyMap<StorePathHash, DivergentSkip> {
	const byStorePathHash = new Map<StorePathHash, ResolvedPushPath>(
		resolved.map((path) => [StorePath.hash(resolvedStorePath(path)), path])
	);
	const divergent = new Map<StorePathHash, DivergentSkip>();

	for (const decision of decisions) {
		if (decision.action !== 'skip') {
			continue;
		}

		const local = byStorePathHash.get(decision.storePathHash);

		if (local === undefined) {
			continue;
		}

		const difference = narDivergence(
			resolvedStorePath(local),
			resolvedNarHash(local),
			decision.narHash
		);

		if (difference !== undefined) {
			divergent.set(decision.storePathHash, difference);
		}
	}

	return divergent;
}

// Different NAR hashes for the same store path are evidence of a
// non-reproducible realisation. Preview and negotiation report the same cached
// hash, so both modes use the same warning.
function warnDivergentSkips(
	reporter: Reporter,
	divergent: ReadonlyMap<StorePathHash, DivergentSkip>
): void {
	for (const skip of divergent.values()) {
		reporter.warn(
			'divergent',
			`${StorePath.basename(skip.storePath)}: local NAR ${skip.localNarHash} ` +
				`differs from the cached copy ${skip.cacheNarHash}; the cache keeps ` +
				`its copy`
		);
	}
}

// Negotiation decisions identify paths by store-path hash and NAR hash. Index
// that pair once to avoid scanning and rehashing the full closure for every
// decision.
type NegotiatedPaths = ReadonlyMap<string, ResolvedPushPath>;

function negotiatedPathKey(storePathHash: string, narHash: string): string {
	return `${storePathHash}\0${narHash}`;
}

function indexNegotiatedPaths(
	resolved: readonly ResolvedPushPath[]
): NegotiatedPaths {
	return new Map(
		resolved.map((path) => [
			negotiatedPathKey(
				StorePath.hash(resolvedStorePath(path)),
				resolvedNarHash(path)
			),
			path
		])
	);
}

function findNegotiatedPath(
	negotiated: NegotiatedPaths,
	decision: UploadDecisionOf<'upload' | 'commit'>
): ResolvedPushPath {
	const path = negotiated.get(
		negotiatedPathKey(decision.storePathHash, decision.narHash)
	);

	if (path !== undefined) {
		return path;
	}

	throw new UnexpectedUploadDecisionError(
		decision.storePathHash,
		decision.narHash
	);
}

function isSkip(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'skip' }> {
	return decision.action === 'skip';
}

function isUpload(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

function isReusedBlobCommit(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'commit' }> {
	return decision.action === 'commit';
}
