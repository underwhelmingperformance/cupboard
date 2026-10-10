import {
	Nix,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import { implicitPinName } from '@cupboard/nix-store/retention';
import {
	type RootName,
	type StorePathHash,
	type StorePathString
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
	type RootRetentionRequest,
	type RootSetBodyInput,
	rootSetMaxTargets,
	type RootSetResponseInput,
	type RootSummaryInput
} from '@cupboard/protocol/retention';
import {
	type CommitBlobDeclaration,
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
	type ResultRow,
	shouldShowDetails
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { genericExitCode, UsageError } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { isAbortError } from '../abort.ts';
import {
	type AttestationBundleSource,
	defaultReadAttestationBundle,
	type DivergentSkip,
	prepareAttestationBundles,
	type ReadAttestationBundle,
	reportPartialAttestationAttachment,
	requireAttestationAttachClient,
	runAttestationAttachment
} from '../attest/attach.ts';
import type { AttestationBundleClient } from '../attest/bundle-transport.ts';
import type { CommitOptions, CommitTarget } from '../client/client.ts';
import type { CommitOutcome, CommitSession } from '../client/commit-socket.ts';
import { isStaleUploadError } from '../client/rpc-errors.ts';
import {
	type WaitTimeoutSeconds,
	waitTimeoutSecondsSchema
} from '../duration.ts';
import {
	type FailedPushPath,
	type PushCommand,
	type PushCredential,
	type PushFailureStage,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	ReferencePathMismatchError,
	ReferenceSourcePairError,
	ReferenceUploadRequiredError,
	UnexpectedUploadDecisionError,
	UploadGraceFactsUnsupportedError,
	UploadVerificationFailedError
} from '../errors.ts';
import { classifyFailures } from '../exit-code.ts';
import { formatHumanError } from '../human-errors.ts';
import { compressNarToStream, type NarUploadStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { type NarSource, SequentialNarSource } from '../nix/nar-source.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';

import { capacityWaitReporter } from './capacity-wait.ts';
import {
	compressionRows,
	CompressionTotals,
	type PeakRssSampler,
	processPeakRss,
	reportNarCompression,
	transferRows,
	TransferTotals,
	uploadObserver
} from './compression-report.ts';
import { narDivergence } from './divergence.ts';
import type { CompressedNarUpload, NarUploadObserver } from './nar-upload.ts';
import {
	exactUploadDecisions,
	type NegotiatedGroup,
	publishJustInTime
} from './negotiation.ts';
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
import { ReferenceSnapshotDivergedError } from './reference-manifest.ts';
import {
	type CompletedNarUpload,
	reportUploadDuration,
	systemUploadClock,
	type UploadClock,
	uploadNarFromSource
} from './upload-transfer.ts';

export type PushStore = Pick<
	Nix,
	'storeKind' | 'narFromPath' | 'resolveClosure' | 'queryValidPathsInfo'
>;

export interface PushDependencies {
	readonly onUploaded?: (storePath: string, upload: CompletedNarUpload) => void;
	readonly onResolved?: (infos: readonly NixValidPathInfo[]) => void;
	readonly resultArtifact?: string;
	readonly nix?: PushStore;
	/**
	 * Opens the system store when `nix` is absent and the publication has local
	 * entries. Defaults to `Nix.open`.
	 */
	readonly openStore?: () => PushStore;
	readonly client: PushClient;
	/**
	 * Include the complete realised closure of each publication entry. By
	 * default, publication includes only the entries themselves.
	 */
	readonly closure?: boolean;
	readonly referenceSource?: ReferenceSource;
	readonly fetchReferenceMetadata?: typeof fetchReferenceMetadataFromSource;
	readonly root?: RootName;
	readonly retention?: RootRetentionRequest;
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
	readonly createNarArchive?: (storePath: string) => NarSource;
	readonly compressNar?: CompressNar;
	readonly uploadConcurrency?: number;
	/**
	Times uploads and schedules their renewals. Defaults to the system clock.
	*/
	readonly uploadClock?: UploadClock;
	/**
	 * Reads the process's peak RSS for the summary. Defaults to
	 * `processPeakRss`.
	 */
	readonly peakRss?: PeakRssSampler;
	readonly dryRun?: boolean;
	/**
	 * The command that `PushIncompleteError` tells the user to run again.
	 */
	readonly command: PushCommand;
	readonly credential: PushCredential;
	readonly buildStore?: string;
	readonly referenceReceipt?: boolean;
	/**
	 * Compatibility inputs for older callers. A push records store metadata;
	 * these path lists cannot establish that this invocation built an output.
	 */
	readonly alreadyHeld?: readonly string[];
	readonly claimable?: readonly string[];
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
/**
 * A negotiate or preview response and whether the server acknowledged
 * grace-aware reporting for it. A client without transport metadata leaves
 * `hasUploadGraceFacts` out and is treated as capable.
 */
export type Acknowledged<Response> = Response & {
	readonly hasUploadGraceFacts?: boolean;
};

export interface PushClient extends Partial<AttestationBundleClient> {
	negotiate(
		body: Omit<UploadNegotiateRequestInput, 'pushId'>
	): Promise<Acknowledged<UploadNegotiateResponse>>;
	// Preview creates no upload state or credentials.
	preview(
		body: UploadPreviewRequestInput
	): Promise<Acknowledged<UploadPreviewResponse>>;
	// The no-path probe creates no upload state.
	probeUploadGraceFacts?(kind: 'negotiate' | 'preview'): Promise<boolean>;
	// Checks a route supported by every server version. This distinguishes an
	// unknown tenant from an old server without the preview route.
	tenantServes?(): Promise<boolean>;
	// Streams one compressed NAR, or another object such as an attestation
	// bundle, to its staging key. The request body contains only bytes; the
	// server computes the file hash and size.
	uploadNar(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	// Compresses a NAR from its source and uploads it to its staging key. It can
	// read the source again to send part of the upload again. A client without
	// it receives the compressed bytes through `uploadNar`.
	uploadCompressedNar?(
		r2Key: string,
		source: NarSource,
		narSize: number,
		observer: NarUploadObserver
	): Promise<CompressedNarUpload>;
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

export type CompressNar = (nar: NarSource, narSize: number) => NarUploadStream;

type UploadDecisionOf<A extends UploadDecision['action']> = Extract<
	UploadDecision,
	{ action: A }
>;

// A failure recorded while the other paths continue. Any recorded failure
// makes the push return a non-zero result after it reports all path outcomes.
interface PushFailure {
	readonly storePathHash: StorePathHash;
	readonly storePath: string;
	readonly stage: PushFailureStage;
	readonly reason: string;
}

interface PushFailureRecord {
	readonly storePathHash: StorePathHash;
	readonly storePath: string;
	readonly stage: PushFailureStage;
	readonly cause: unknown;
}

function failedPushPath(record: PushFailureRecord): FailedPushPath {
	const path = StorePath.basename(record.storePath);

	if (record.stage !== 'verify') {
		return { path, stage: record.stage };
	}

	return {
		path,
		stage: 'verify',
		verdict:
			record.cause instanceof UploadVerificationFailedError
				? 'failed'
				: 'pending'
	};
}

function summaryFailure(record: PushFailureRecord): PushFailure {
	return {
		storePathHash: record.storePathHash,
		storePath: record.storePath,
		stage: record.stage,
		reason: failureReason(record.cause)
	};
}

function failureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const notFoundStatus: number = StatusCodes.NOT_FOUND;

async function requireUploadGraceFacts(
	client: PushClient,
	kind: 'negotiate' | 'preview'
): Promise<void> {
	if (
		client.probeUploadGraceFacts === undefined ||
		(await client.probeUploadGraceFacts(kind))
	) {
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
): Promise<Acknowledged<UploadNegotiateResponse>> {
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
	if (
		dependencies.referenceReceipt === true &&
		dependencies.referenceSource === undefined &&
		publication.referenceEntries.some((entry) => entry.reference === undefined)
	) {
		throw new ReferenceSourcePairError();
	}
	// Validate the retention before any upload work: an invalid root name or
	// target must fail fast, not after NARs are built and committed. Only the
	// declared targets are retained; intermediates join no root or pin.
	const retention = planRetention(
		publication.targetPaths,
		dependencies.root,
		dependencies.retention ?? { kind: 'inherit' },
		dependencies.retain ?? true
	);
	const openStore = dependencies.openStore ?? (() => Nix.open());
	// A reference-only publication reads no local metadata and needs no store
	// on the system, so the store client only opens once a local entry needs it.
	const nix =
		dependencies.nix ??
		(publication.localEntries.length > 0 ? openStore() : undefined);
	const createNarArchive =
		dependencies.createNarArchive ?? ((storePath) => new NarArchive(storePath));
	// NAR metadata must describe the bytes supplied by the selected store. A
	// local store and a same-machine daemon both use the files at the store path,
	// so read those files directly. Paths in an ssh-ng store exist on the remote
	// machine, so stream their NARs through the store client.
	const narSource =
		nix?.storeKind === 'ssh-ng'
			? (storePath: string): NarSource =>
					new SequentialNarSource(() => nix.narFromPath(storePath))
			: createNarArchive;
	const compressNar = dependencies.compressNar ?? compressNarToStream;

	return runPushFlow(publication, reporter, {
		...dependencies,
		resultArtifact:
			dependencies.resultArtifact ?? process.env.CUPBOARD_RESULT_ARTIFACT,
		retention,
		nix,
		createNarArchive: narSource,
		compressNar,
		wait: dependencies.wait ?? true,
		waitTimeoutSeconds:
			dependencies.waitTimeoutSeconds ?? defaultWaitTimeoutSeconds,
		command: dependencies.command,
		credential: dependencies.credential
	});
}

interface PushRuntimeDependencies {
	readonly onUploaded?: (storePath: string, upload: CompletedNarUpload) => void;
	readonly onResolved?: (infos: readonly NixValidPathInfo[]) => void;
	readonly resultArtifact?: string;
	readonly nix?: PushStore;
	readonly client: PushClient;
	readonly retention: RetentionPlan;
	readonly closure?: boolean;
	readonly referenceSource?: ReferenceSource;
	readonly fetchReferenceMetadata?: typeof fetchReferenceMetadataFromSource;
	readonly signal?: AbortSignal;
	readonly createNarArchive: (storePath: string) => NarSource;
	readonly compressNar: CompressNar;
	readonly wait: boolean;
	readonly waitTimeoutSeconds: WaitTimeoutSeconds;
	readonly command: PushCommand;
	readonly credential: PushCredential;
	readonly runRoot?: UploadAttachRootInput;
	readonly attest?: boolean;
	readonly attestations?: readonly AttestationBundleSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly uploadConcurrency?: number;
	readonly uploadClock?: UploadClock;
	readonly peakRss?: PeakRssSampler;
	readonly dryRun?: boolean;
	readonly buildStore?: string;
	readonly referenceReceipt?: boolean;
	readonly alreadyHeld?: readonly string[];
	readonly claimable?: readonly string[];
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
			readonly sourceUrl: string;
			readonly captured: boolean;
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

	const fetchMetadata =
		dependencies.fetchReferenceMetadata ?? fetchReferenceMetadataFromSource;
	const resolved = await mapWithConcurrency(
		entries,
		defaultUploadConcurrency,
		async (entry, index) => {
			const referenceSource = entry.reference?.source ?? source?.url;
			if (referenceSource === undefined) {
				throw new ReferenceSourcePairError();
			}
			const metadata =
				entry.reference?.metadata ??
				(await fetchMetadata(
					source ?? { url: referenceSource },
					StorePath.hash(entry.storePath),
					{ signal: dependencies.signal }
				));

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
					metadata,
					sourceUrl: canonicalHref(referenceSource),
					captured: entry.reference !== undefined
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
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

/**
 * Describes published paths from reference narinfos or selected-store metadata.
 * Neither source establishes execution during the current invocation.
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

	for (const path of resolved) {
		if (path.source !== 'reference') {
			continue;
		}

		described.set(
			path.storePath,
			republishedSubject(path.metadata, path.sourceUrl)
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

function referenceReceipt(
	resolved: readonly ResolvedPushPath[],
	summaryPaths: readonly PushSummaryPathInput[]
): BuildReceiptV3 {
	const references = new Map<
		string,
		Extract<ResolvedPushPath, { readonly source: 'reference' }>
	>(
		resolved.flatMap((path) =>
			path.source === 'reference' ? [[path.storePath, path] as const] : []
		)
	);
	const paths = new Set<StorePathString>();
	const uploaded = new Set<StorePathString>();

	for (const path of summaryPaths) {
		const reference =
			path.storePath === undefined ? undefined : references.get(path.storePath);
		if (reference === undefined) {
			continue;
		}
		if (path.outcome === 'committed') {
			uploaded.add(reference.storePath);
		}
		if (path.outcome === 'committed' || path.outcome === 'already-present') {
			paths.add(reference.storePath);
		}
	}

	return buildReceiptV3Schema.parse({
		version: 3,
		paths: [...paths].toSorted(byCodeUnit),
		subjects: resolved
			.flatMap((reference) =>
				reference.source === 'reference' && paths.has(reference.storePath)
					? [republishedSubject(reference.metadata, reference.sourceUrl)]
					: []
			)
			.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath)),
		uploaded: [...uploaded].toSorted(byCodeUnit)
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
	const failures: PushFailureRecord[] = [];
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
			ctx.fact('roots', formatCount(publication.entries.length), {
				humanLabel: 'requested paths'
			});
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
					cause: vanished
				});
				ctx.warn(
					'vanished target',
					`${StorePath.basename(storePath)}: ${failureReason(vanished)}`,
					{
						humanMessage: `${StorePath.basename(storePath)}: ${formatHumanError(vanished, { debug: reporter.presentation === 'debug' })}`
					}
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
				ctx.fact('collected', formatCount(collected.length), {
					humanLabel: 'no longer in the local store'
				});
			}

			return paths;
		}
	);

	dependencies.onResolved?.(localPathInfos(resolved));

	if (dependencies.dryRun === true) {
		await reportDryRun(reporter, client, resolved, retention);
		return undefined;
	}

	if (retention.kind === 'none') {
		await requireUploadGraceFacts(client, 'negotiate');
	}

	const negotiated = indexNegotiatedPaths(resolved);
	const storePathByHash = new Map<StorePathHash, string>(
		resolved.map((path) => [
			StorePath.hash(resolvedStorePath(path)),
			resolvedStorePath(path)
		])
	);
	const decisions: UploadDecision[] = [];
	const divergent = new Map<StorePathHash, DivergentSkip>();
	// A re-drive can change the action, for example when a reused blob is
	// collected and the next negotiation requests an upload. Keep only the
	// latest action for the summary counts.
	const effectiveActions = new Map<string, UploadDecision['action']>();

	const negotiateGroup = async (
		paths: readonly UploadPathNegotiationFields[]
	): Promise<NegotiatedGroup<UploadDecision>> => {
		const response = await negotiateUpload(
			client,
			[...paths],
			dependencies.runRoot
		);
		const hasUploadGraceFacts = response.hasUploadGraceFacts ?? true;
		const groupDivergent = divergentSkips(resolved, response.uploads);

		requireReferenceSnapshotIdentity(resolved, groupDivergent);
		warnDivergentSkips(reporter, groupDivergent);

		for (const [storePathHash, skip] of groupDivergent) {
			divergent.set(storePathHash, skip);
		}

		for (const decision of response.uploads) {
			decisions.push(decision);
			effectiveActions.set(decision.storePathHash, decision.action);
		}

		return { uploads: response.uploads, hasUploadGraceFacts };
	};

	const commitOptions: CommitOptions = {
		timeoutSeconds: waitTimeoutSeconds,
		onWaiting: capacityWaitReporter(reporter)
	};
	const session = await client.openCommitSession?.(commitOptions);
	let uploadedBytes = 0;
	const onBytes = (count: number): void => {
		uploadedBytes += count;
	};
	const uploadClock = dependencies.uploadClock ?? systemUploadClock;
	const compressionTotals = new CompressionTotals();
	const transferTotals = new TransferTotals();
	const observe = (storePath: string): NarUploadObserver =>
		uploadObserver(reporter, StorePath.basename(storePath), onBytes);
	const reportUpload = (
		storePath: string,
		upload: CompletedNarUpload
	): void => {
		dependencies.onUploaded?.(storePath, upload);
		if (upload.transfer !== undefined) {
			transferTotals.add(upload.transfer);
		}

		if (upload.compression !== undefined) {
			compressionTotals.add(upload.compression);
			reportNarCompression(
				reporter,
				StorePath.basename(storePath),
				upload.compression
			);
		}

		reportUploadDuration(
			reporter,
			StorePath.basename(storePath),
			upload.durationMs
		);
	};
	const uploadContext: UploadContext = {
		client,
		session,
		negotiated,
		createNarArchive,
		compressNar,
		clock: uploadClock,
		observe
	};
	const completedUploads = new Set<StorePathHash>();
	// A re-drive replaces the original outcome for the same store path. The
	// summary therefore reports only the latest commit attempt.
	const outcomes = new Map<StorePathHash, CommitOutcome>();
	const commitContext: CommitContext = {
		client,
		session,
		negotiated,
		createNarArchive,
		compressNar,
		options: commitOptions,
		...(dependencies.runRoot !== undefined && {
			runRoot: dependencies.runRoot
		}),
		clock: uploadClock,
		observe,
		onUploaded: (storePathHash, upload) => {
			completedUploads.add(storePathHash);
			reportUpload(storePathByHash.get(storePathHash) ?? storePathHash, upload);
		},
		onRedriven: (fresh) => {
			effectiveActions.set(fresh.storePathHash, fresh.action);
		}
	};
	const concurrency =
		dependencies.uploadConcurrency ?? defaultUploadConcurrency;

	try {
		// Reference entries publish content that is already in the cache, so
		// they need no upload. Negotiate them first, as one group, so a captured
		// snapshot that no longer matches the cache stops the push before any
		// local upload starts.
		const referenceEntries = resolved.filter(
			(path) => path.source === 'reference'
		);
		const referenceGroup =
			referenceEntries.length === 0
				? undefined
				: await reporter.phase(
						'Negotiating with cache',
						async (ctx) => {
							const group = await negotiateGroup(
								referenceEntries.map((path) => negotiationOf(path))
							);

							ctx.fact(
								'skip',
								formatCount(
									group.uploads.filter((decision) => isSkip(decision)).length
								),
								{ humanLabel: 'already available' }
							);

							return group;
						},
						{ humanLabel: 'Checking which reference paths need publishing' }
					);

		// Each upload worker uploads one path and waits for the server to
		// acknowledge its commit before taking another. Verdicts are awaited
		// after every path has been acknowledged, so slow verification does not
		// keep an upload worker busy. With `--no-wait`, a deferred commit returns
		// `pending` once the server has stored its metadata.
		const commit = await reporter.progress(
			'Publishing paths',
			{
				total: resolved.length,
				humanLabel: 'Uploading and submitting paths'
			},
			async (bar) => {
				// A pending outcome means the server reserved the row but has not
				// made the path servable. Preserve the decision so an `absent` verdict
				// can be negotiated again. Identify the outcome by store-path hash
				// because a re-drive receives a new upload ID.
				const pending: PendingCommit[] = [];
				let uploaded = 0;
				let committed = 0;
				let skipped = 0;
				const reportCounts = (): void => {
					bar.fact('uploaded', formatCount(uploaded), {
						humanLabel: 'uploaded'
					});
					bar.fact('committed', formatCount(committed), {
						humanLabel: 'accepted'
					});
					bar.fact('skip', formatCount(skipped), {
						humanLabel: 'already available'
					});
				};

				const publishDecision = async (
					decision: UploadDecision,
					hasGraceFacts: boolean
				): Promise<void> => {
					if (isSkip(decision)) {
						skipped += 1;
						return;
					}

					const storePath =
						storePathByHash.get(decision.storePathHash) ??
						decision.storePathHash;

					let blob: CommitBlobDeclaration | undefined;

					if (isUpload(decision)) {
						try {
							const upload = await streamNarUpload(decision, uploadContext);
							blob = upload.blob;
							completedUploads.add(decision.storePathHash);
							uploaded += 1;
							reportUpload(storePath, upload);
						} catch (error) {
							if (isAbortError(error)) {
								throw error;
							}

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
								bar.fact('collected', formatCount(collected.length), {
									humanLabel: 'no longer in the local store'
								});
								return;
							}

							failures.push({
								storePathHash: decision.storePathHash,
								storePath,
								stage: 'upload',
								cause: error
							});
							bar.warn(
								'upload failed',
								`${StorePath.basename(storePath)}: ${failureReason(error)}`,
								{
									humanMessage: `${StorePath.basename(storePath)}: ${formatHumanError(error, { debug: reporter.presentation === 'debug' })}`
								}
							);
							return;
						}
					}

					let outcome: CommitOutcome;

					try {
						outcome = await commitNegotiated(
							decision,
							commitContext,
							hasGraceFacts,
							blob
						);
					} catch (error) {
						if (isAbortError(error)) {
							throw error;
						}

						failures.push({
							storePathHash: decision.storePathHash,
							storePath,
							stage: 'commit',
							cause: error
						});
						bar.warn(
							'commit failed',
							`${StorePath.basename(storePath)}: ${failureReason(error)}`,
							{
								humanMessage: `${StorePath.basename(storePath)}: path submission failed: ${formatHumanError(error, { debug: reporter.presentation === 'debug' })}`
							}
						);
						return;
					}

					outcomes.set(outcome.storePathHash, outcome);

					if (outcome.status === 'pending') {
						pending.push({
							decision,
							storePathHash: outcome.storePathHash,
							settled: outcome.settled
						});
						return;
					}

					committed += 1;
				};
				const publishCounted = async (
					decision: UploadDecision,
					hasGraceFacts: boolean
				): Promise<void> => {
					try {
						await publishDecision(decision, hasGraceFacts);
					} finally {
						bar.advance(1);
						reportCounts();
					}
				};

				if (referenceGroup !== undefined) {
					await mapWithConcurrency(
						referenceGroup.uploads,
						concurrency,
						(decision) =>
							publishCounted(decision, referenceGroup.hasUploadGraceFacts)
					);
				}

				await publishJustInTime(
					{
						paths: resolved.filter((path) => path.source === 'local'),
						concurrency,
						negotiationOf: (path) => negotiationOf(path),
						negotiate: negotiateGroup
					},
					async (item) => {
						if (item.kind === 'refused') {
							throw item.error;
						}

						await publishCounted(item.decision, item.hasUploadGraceFacts);
					}
				);

				return { pending };
			}
		);

		// Exclude collected intermediates because publication did not complete
		// their negotiated actions.
		for (const path of collected) {
			effectiveActions.delete(path.storePathHash);
		}

		// A reserved row is enough for a root to refer to the path, even while
		// verification is pending. Record retention before waiting so it survives
		// a client disconnect. A failed commit creates no row and prevents all
		// retention updates for this push.
		const isIncomplete = failures.length > 0;

		if (isIncomplete) {
			reporter.warn(
				'incomplete',
				retention.kind === 'none'
					? `${formatCount(failures.length)} path(s) could not be published.`
					: `${formatCount(failures.length)} path(s) could not be published, so retention was not recorded.`
			);
		}

		const recordedRetention: RecordedRetention = isIncomplete
			? { rows: [], roots: [] }
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
							cause: result.reason
						});
						bar.warn(
							'verification failed',
							`${StorePath.basename(storePath)}: ${reason}`,
							{
								humanMessage: `${StorePath.basename(storePath)}: ${formatHumanError(result.reason, { debug: reporter.presentation === 'debug' })}`
							}
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
		const uploadedPaths = completedUploads.size;
		const reusedBlobs = actions.filter((action) => action === 'commit').length;
		const skipped = actions.filter((action) => action === 'skip').length;
		const failedStorePathHashes = new Set(
			failures.map((failure) => failure.storePathHash)
		);
		const summaryPaths: PushSummaryPathInput[] = [
			...decisions
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
		const compression = compressionTotals.summary(
			(dependencies.peakRss ?? processPeakRss)()
		);
		const transfer = transferTotals.summary();
		const summary = {
			uploadedPaths,
			reusedBlobs,
			skipped,
			uploadedBytes,
			failures: failures.map((failure) => summaryFailure(failure)),
			paths: summaryPaths,
			...(recordedRetention.roots.length > 0 && {
				roots: recordedRetention.roots
			}),
			...(compression !== undefined && { compression }),
			...(transfer !== undefined && { transfer })
		};
		// Server data can make a locally assembled failure entry invalid, for
		// example by leaving only a hash where the schema expects a store path.
		// Preserve the unvalidated summary so reporting does not hide the original
		// push failure.
		const validated = pushSummarySchema.safeParse(summary);

		reporter.result({
			kind: pushSummaryResultKind,
			title: 'Publication result',
			data: validated.success ? validated.data : summary,
			rows: [
				{ label: 'Uploaded paths', value: formatCount(completedUploads.size) },
				{
					label: 'Available paths',
					value: formatCount(
						summaryPaths.filter(
							(path) =>
								path.outcome === 'committed' ||
								path.outcome === 'already-present'
						).length
					)
				},
				...(summaryPaths.some((path) => path.outcome === 'pending')
					? [
							{
								label: 'Waiting for verification',
								value: formatCount(
									summaryPaths.filter((path) => path.outcome === 'pending')
										.length
								)
							}
						]
					: []),
				{ label: 'Reused stored content', value: formatCount(reusedBlobs) },
				{ label: 'Already available', value: formatCount(skipped) },
				{ label: 'Bytes uploaded', value: formatBytes(uploadedBytes) },
				...(compression === undefined ? [] : compressionRows(compression)),
				...(transfer === undefined ? [] : transferRows(transfer)),
				...(collected.length > 0
					? [
							{
								label: 'No longer in the local store',
								value: formatCount(collected.length)
							}
						]
					: []),
				...attestationRows,
				...recordedRetention.rows,
				...pushSummaryPathRows(
					summaryPaths,
					retention,
					reporter,
					publication.targetPaths,
					rootRetentionByPath(recordedRetention.roots, resolved),
					dependencies.resultArtifact
				),
				...(failures.length > 0
					? [{ label: 'Failed', value: formatCount(failures.length) }]
					: [])
			]
		});
		unretainedUngracedWarning(reporter, retention, summaryPaths);

		// Report every successful path first, then fail the overall command so a
		// caller cannot treat a partial publication as complete.
		if (failures.length > 0) {
			const classification = classifyFailures(
				failures.map((failure) => failure.cause),
				genericExitCode
			);

			throw new PushIncompleteError({
				failures: failures.map((failure) => failedPushPath(failure)),
				exitStatus: classification.exitCode,
				command: dependencies.command,
				credential: dependencies.credential,
				recordsRetention: retention.kind !== 'none'
			});
		}

		if (dependencies.referenceReceipt === true) {
			return referenceReceipt(resolved, summaryPaths);
		}

		return dependencies.buildStore === undefined
			? undefined
			: reconciledReceipt(
					{
						buildStore: dependencies.buildStore,
						copiedFrom: dependencies.copiedFrom ?? new Map()
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
				),
				{ humanLabel: 'would upload' }
			);
			ctx.fact(
				'skip',
				formatCount(
					response.uploads.filter((decision) => decision.action === 'skip')
						.length
				),
				{ humanLabel: 'already available' }
			);

			return response;
		}
	);

	const divergent = divergentSkips(resolved, preview.uploads);
	requireReferenceSnapshotIdentity(resolved, divergent);
	warnDivergentSkips(reporter, divergent);

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
		title: 'Publication preview',
		data: { wouldUpload, reusedBlobs, skipped, paths: preview.uploads },
		rows: [
			{ label: 'Would upload', value: formatCount(wouldUpload) },
			{ label: 'Reused stored content', value: formatCount(reusedBlobs) },
			{ label: 'Already available', value: formatCount(skipped) },
			...retentionPlanRows(retention),
			...previewPathRows(preview.uploads, retention, resolved, reporter)
		]
	});
	unretainedUngracedWarning(reporter, retention, preview.uploads);
}

// A stored deadline is an existing server fact. This wording is shared by real
// pushes and by dry-run rows for paths already present in the cache.
function graceRetainUntilRow(retainUntil: string): string {
	return `kept until ${formatTimestamp(retainUntil)}`;
}

function pushSummaryPathRow(
	path: PushSummaryPathInput,
	reporter: Reporter,
	root: RootSummaryInput | undefined
): ResultRow {
	const label =
		path.storePath === undefined
			? path.storePathHash
			: shouldShowDetails(reporter)
				? path.storePath
				: StorePath.basename(path.storePath);
	if (path.outcome === 'collected') {
		return {
			label,
			value: 'removed from the local store before publication; not published'
		};
	}

	const availability =
		path.outcome === 'pending' ? 'accepted; verification pending' : 'available';
	if (root !== undefined) {
		return {
			label,
			value: `${availability}; root ${root.name}, ${formatExpiry(root)}`
		};
	}

	if (path.grace?.retainUntil !== undefined) {
		return {
			label,
			value: `${availability}; ${graceRetainUntilRow(path.grace.retainUntil)}`
		};
	}

	const graceSeconds = path.grace?.graceSeconds;
	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label,
			value: `${availability}; retention grace period ${formatCount(graceSeconds)}s`
		};
	}

	const retention =
		path.grace === undefined
			? 'retention grace not reported'
			: graceSeconds === 0 && shouldShowDetails(reporter)
				? 'configured zero retention grace'
				: 'no retention grace period';
	return { label, value: `${availability}; ${retention}` };
}

function pushSummaryPathRows(
	paths: readonly PushSummaryPathInput[],
	retention: RetentionPlan,
	reporter: Reporter,
	targets: readonly StorePathString[],
	roots: ReadonlyMap<string, RootSummaryInput>,
	resultArtifact?: string
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		!shouldShowDetails(reporter) &&
		paths.every(
			(path) => !hasGraceFact(path.grace) && path.outcome !== 'pending'
		)
	) {
		return [];
	}

	const byPath = new Map(paths.map((path) => [path.storePath, path]));
	const targetSet = new Set<string>(targets);
	const targetPaths = targets.flatMap((storePath) => {
		const path = byPath.get(storePath);
		return path === undefined ? [] : [path];
	});
	const otherPaths = paths.filter(
		(path) => !targetSet.has(path.storePath ?? '')
	);
	const row = (path: PushSummaryPathInput): ResultRow =>
		pushSummaryPathRow(path, reporter, roots.get(path.storePath ?? ''));

	return [
		...targetPaths.map((path) => row(path)),
		...cappedPathRows(
			otherPaths.map((path) => row(path)),
			resultArtifact
		)
	];
}

const maxPathRows = 20;

function cappedPathRows(
	rows: readonly ResultRow[],
	resultArtifact?: string
): readonly ResultRow[] {
	if (rows.length <= maxPathRows) {
		return rows;
	}

	return [
		...rows.slice(0, maxPathRows),
		{
			label: '…',
			value: `${formatCount(rows.length - maxPathRows)} more path(s); the full list is in ${resultArtifact === undefined ? 'the JSON output' : `artifact ${resultArtifact}`}`
		}
	];
}

const zeroGraceRow = 'no retention grace period';

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
			: 'the cache has no retention grace; these paths have no retention root or grace deadline, so the next collection can remove them',
		{
			humanMessage:
				'These paths are not retained and may be removed during the next cache cleanup.'
		}
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
function previewPathRow(
	decision: UploadPreviewDecision,
	paths: ReadonlyMap<StorePathHash, string>,
	reporter: Reporter
): ResultRow {
	const storePath = paths.get(decision.storePathHash);
	const label =
		storePath === undefined
			? decision.storePathHash
			: shouldShowDetails(reporter)
				? storePath
				: StorePath.basename(storePath);
	if (decision.grace?.retainUntil !== undefined) {
		return {
			label,
			value: graceRetainUntilRow(decision.grace.retainUntil)
		};
	}

	const graceSeconds = decision.grace?.graceSeconds;

	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label,
			value:
				decision.action === 'skip'
					? `would refresh the retention grace period (${formatCount(graceSeconds)}s)`
					: `would apply a retention grace period of ${formatCount(graceSeconds)}s`
		};
	}

	if (graceSeconds === 0) {
		return {
			label,
			value: shouldShowDetails(reporter)
				? 'configured zero retention grace'
				: zeroGraceRow
		};
	}

	return {
		label,
		value:
			decision.grace === undefined
				? 'retention grace not reported'
				: 'no retention grace period'
	};
}

// An unretained plan always shows per-path grace results.
function previewPathRows(
	decisions: readonly UploadPreviewDecision[],
	retention: RetentionPlan,
	resolved: readonly ResolvedPushPath[],
	reporter: Reporter
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		decisions.every((decision) => !hasGraceFact(decision.grace))
	) {
		return [];
	}

	const paths = new Map(
		resolved.map((path) => [
			StorePath.hash(resolvedStorePath(path)),
			resolvedStorePath(path)
		])
	);
	return cappedPathRows(
		decisions.map((decision) => previewPathRow(decision, paths, reporter))
	);
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
				value: planExpiry(retention.request.body.retention)
			}
		];
	}

	return [
		{ label: 'Would pin paths', value: formatCount(retention.requests.length) },
		{
			label: 'Pin expiry',
			value: planExpiry(retention.requests[0]?.body.retention)
		}
	];
}

function planExpiry(
	retention: RootSetBodyInput['retention'] | undefined
): string {
	if (retention === undefined || retention.kind === 'inherit') {
		return 'inherits cache retention';
	}

	return retention.kind === 'permanent'
		? 'permanent'
		: `expires after ${formatCount(retention.seconds)}s`;
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
		const readStep = log.group('read', { humanLabel: 'Reading bundles' });
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
				`${formatCount(deferred)} attestation bundle(s) describe path(s) still awaiting server-side verification; the push did not attach them`,
				{
					humanMessage: `${formatCount(deferred)} attestation bundle(s) were not attached because their paths are still waiting for verification.`
				}
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
			client: requireAttestationAttachClient(dependencies.client),
			onPartial: async (partial) => {
				await reportPartialAttestationAttachment(
					partial,
					reporter,
					pathInfos,
					prepared
				);
			}
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
		`${formatCount(summary.reused)} already attached`,
		`${formatCount(summary.deferred)} awaiting verification`
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
			`the root update would carry ${String(count)} targets, but one update ` +
				`accepts at most ${String(limit)}; split the paths across named roots`
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
	retention: RootRetentionRequest,
	shouldRetain: boolean
): RetentionPlan {
	if (!shouldRetain) {
		return { kind: 'none' };
	}

	if (root !== undefined && paths.length > rootSetMaxTargets) {
		throw new RootTargetLimitError(paths.length, rootSetMaxTargets);
	}

	if (root !== undefined) {
		return {
			kind: 'root',
			name: root,
			request: { name: root, body: { targets: [...paths], retention } }
		};
	}

	return {
		kind: 'pins',
		requests: paths.map((path) => ({
			name: implicitPinName(StorePath.hash(path)),
			body: { targets: [path], retention }
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

interface RecordedRetention {
	readonly rows: readonly ResultRow[];
	readonly roots: readonly RootSummaryInput[];
}

function rootRetentionByPath(
	roots: readonly RootSummaryInput[],
	resolved: readonly ResolvedPushPath[]
): ReadonlyMap<string, RootSummaryInput> {
	const metadata = new Map<string, ResolvedPushPath>(
		resolved.map((path) => [resolvedStorePath(path), path])
	);
	const byPath = new Map<string, RootSummaryInput>();

	for (const root of roots) {
		const pending = root.targets
			.filter((target) => target.present)
			.map((target) => target.storePath);
		const visited = new Set<string>();

		while (pending.length > 0) {
			const storePath = pending.pop();
			if (storePath === undefined || visited.has(storePath)) {
				continue;
			}
			visited.add(storePath);
			const previous = byPath.get(storePath);
			if (
				previous === undefined ||
				(previous.expiresAt !== undefined &&
					(root.expiresAt === undefined || root.expiresAt > previous.expiresAt))
			) {
				byPath.set(storePath, root);
			}
			const path = metadata.get(storePath);
			if (path !== undefined) {
				pending.push(
					...(path.source === 'local'
						? path.pathInfo.references
						: path.metadata.upload.references)
				);
			}
		}
	}

	return byPath;
}

async function recordRetention(
	retention: RetentionPlan,
	client: PushClient,
	ctx: PhaseContext
): Promise<RecordedRetention> {
	if (retention.kind === 'none') {
		ctx.fact('retention', noRetainLabel);

		return { rows: [{ label: 'Retention', value: noRetainLabel }], roots: [] };
	}

	if (retention.kind === 'root') {
		const { name, body } = retention.request;
		const summary = await client.setRoot(name, body);
		const expiry = formatExpiry(summary);
		ctx.fact('root', retention.name);
		ctx.fact('expiry', expiry);

		return {
			rows: [
				{ label: 'Root', value: retention.name },
				{ label: 'Root expiry', value: expiry }
			],
			roots: [summary]
		};
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

	return {
		rows: [
			{ label: 'Pinned paths', value: formatCount(retention.requests.length) },
			{ label: 'Pin expiry', value: expiry }
		],
		roots: summaries.toSorted((left, right) =>
			byCodeUnit(left.name, right.name)
		)
	};
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
	readonly session: CommitSession | undefined;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => NarSource;
	readonly compressNar: CompressNar;
	readonly clock: UploadClock;
	readonly observe: (storePath: string) => NarUploadObserver;
}

// Stream compression keeps large closures out of the runner's temporary
// storage. Once the upload ends, compare the NAR's uncompressed hash and size
// with the negotiated metadata so changed source bytes cannot be committed
// under stale path metadata. Returns how long the bytes took to send and the
// NAR's compression and transfer facts.
async function streamNarUpload(
	decision: UploadDecisionOf<'upload'>,
	context: UploadContext
): Promise<CompletedNarUpload> {
	const pathInfo = requireLocalPathInfo(
		findNegotiatedPath(context.negotiated, decision)
	);
	const upload = await uploadNarFromSource(
		{ ...context, observer: context.observe(pathInfo.storePath) },
		decision,
		context.createNarArchive(pathInfo.storePath),
		pathInfo.narSize
	);
	verifyNarMetadata(pathInfo, upload.digest);

	return upload;
}

interface CommitContext {
	readonly client: PushClient;
	readonly session: CommitSession | undefined;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => NarSource;
	readonly compressNar: CompressNar;
	readonly options: CommitOptions;
	// Re-drives must attach the replacement pending row to the same run root.
	readonly runRoot?: UploadAttachRootInput;
	readonly clock: UploadClock;
	readonly observe: (storePath: string) => NarUploadObserver;
	readonly onUploaded: (
		storePathHash: StorePathHash,
		upload: CompletedNarUpload
	) => void;
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
	shouldReportGraceFacts: boolean,
	blob?: CommitBlobDeclaration
): CommitTarget {
	return {
		uploadId: decision.uploadId,
		storePathHash: decision.storePathHash,
		narHash: decision.narHash,
		...(shouldReportGraceFacts && { retention: true as const }),
		...(blob !== undefined && { blob })
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
	context: CommitContext,
	hasGraceFacts: boolean,
	blob: CommitBlobDeclaration | undefined
): Promise<CommitOutcome> {
	try {
		return await commitVia(
			context,
			commitTarget(decision, hasGraceFacts, blob)
		);
	} catch (error) {
		if (!isStaleUploadError(error) && !isAbsentVerdict(error)) {
			throw error;
		}

		return redriveExpiredCommit(decision, context);
	}
}

// A commit that the server acknowledged as pending.
interface PendingCommit {
	readonly decision: UploadDecisionOf<'upload' | 'commit'>;
	readonly storePathHash: StorePathHash;
	readonly settled: Promise<void>;
}

// After an `absent` verdict, replace the expired commit and wait for its new
// verdict. Retention already refers to the store path, so the replacement row
// needs no additional root update. A second loss propagates to the wait phase.
async function awaitDeferredVerdict(
	entry: PendingCommit,
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

	const hasGraceFacts = renegotiation.hasUploadGraceFacts ?? true;

	context.onRedriven(fresh);

	if (isReusedBlobCommit(fresh)) {
		return commitVia(context, commitTarget(fresh, hasGraceFacts));
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
	const upload = await uploadNarFromSource(
		{ ...context, observer: context.observe(pathInfo.storePath) },
		fresh,
		context.createNarArchive(pathInfo.storePath),
		pathInfo.narSize
	);
	verifyNarMetadata(pathInfo, upload.digest);
	context.onUploaded(fresh.storePathHash, upload);

	return commitVia(context, commitTarget(fresh, hasGraceFacts, upload.blob));
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

function requireReferenceSnapshotIdentity(
	resolved: readonly ResolvedPushPath[],
	divergent: ReadonlyMap<StorePathHash, DivergentSkip>
): void {
	for (const path of resolved) {
		if (path.source !== 'reference' || !path.captured) {
			continue;
		}
		const difference = divergent.get(StorePath.hash(path.storePath));
		if (difference === undefined) {
			continue;
		}
		throw new ReferenceSnapshotDivergedError(
			path.storePath,
			difference.localNarHash,
			difference.cacheNarHash
		);
	}
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
				`its copy`,
			{
				humanMessage:
					reporter.presentation === 'debug'
						? `${StorePath.basename(skip.storePath)}: local NAR ${skip.localNarHash} differs from the cached copy ${skip.cacheNarHash}; the cache keeps its copy`
						: `${StorePath.basename(skip.storePath)}: local contents differ from the cached copy. The cached copy is unchanged.`
			}
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
