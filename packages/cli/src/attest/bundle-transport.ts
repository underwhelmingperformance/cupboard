import type { StorePathHash } from '@cupboard/nix-store/scalars';
import {
	attestationAttachMaxPaths,
	type AttestationAttachPathsResponseInput,
	type AttestationBundleDecisionInput,
	attestationBundleNegotiateMaxBundles,
	type AttestationBundleNegotiateRequestInput,
	type AttestationBundleNegotiateResponseInput
} from '@cupboard/protocol/attestations';
import { formatBytes, formatCount, type StepLog } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { ORPCError } from '@orpc/client';

import {
	AttestationBundleResponseMismatchError,
	AttestationBundleTransportUnavailableError,
	AttestationPathUnservableError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';

import type {
	AttestationAttachOutcome,
	AttestationBundleOutcome,
	PreparedAttestationBundle
} from './attach.ts';
import type { AttachmentProgress } from './attachment-progress.ts';

export interface AttestationBundleClient {
	negotiateAttestationBundles(
		body: Omit<AttestationBundleNegotiateRequestInput, 'pushId'>
	): Promise<AttestationBundleNegotiateResponseInput>;
	uploadNar(key: string, bytes: ReadableStream<Uint8Array>): Promise<void>;
	attachAttestationPaths(
		id: string,
		body: { readonly storePathHashes: readonly string[] }
	): Promise<AttestationAttachPathsResponseInput>;
}

interface BundleGroup {
	readonly digest: string;
	readonly bytes: Uint8Array;
	readonly paths: Set<StorePathHash>;
}

export function groupAttestationBundles(
	prepared: readonly PreparedAttestationBundle[]
): readonly BundleGroup[] {
	const groups = new Map<string, BundleGroup>();

	for (const bundle of prepared) {
		let group = groups.get(bundle.digest);
		if (group === undefined) {
			group = { digest: bundle.digest, bytes: bundle.bytes, paths: new Set() };
			groups.set(bundle.digest, group);
		}
		group.paths.add(bundle.storePathHash);
	}

	return groups.values().toArray();
}

function exactBundleDecisions(
	groups: readonly BundleGroup[],
	decisions: readonly AttestationBundleDecisionInput[]
): ReadonlyMap<string, AttestationBundleDecisionInput> {
	const requested = new Set(groups.map((group) => group.digest));
	const answers = new Map<string, AttestationBundleDecisionInput>();

	for (const decision of decisions) {
		if (!requested.has(decision.digest)) {
			throw new AttestationBundleResponseMismatchError(
				'negotiation',
				'unexpected',
				decision.digest
			);
		}
		if (answers.has(decision.digest)) {
			throw new AttestationBundleResponseMismatchError(
				'negotiation',
				'duplicate',
				decision.digest
			);
		}
		answers.set(decision.digest, decision);
	}

	for (const digest of requested) {
		if (!answers.has(digest)) {
			throw new AttestationBundleResponseMismatchError(
				'negotiation',
				'missing',
				digest
			);
		}
	}

	return answers;
}

function exactPathOutcomes(
	digest: string,
	paths: readonly StorePathHash[],
	response: AttestationAttachPathsResponseInput
): readonly AttestationBundleOutcome[] {
	const requested = new Map<string, StorePathHash>(
		paths.map((path) => [path, path])
	);
	const answers = new Map<StorePathHash, AttestationBundleOutcome>();

	for (const result of response.paths) {
		const path = requested.get(result.storePathHash);
		const identity = `${result.storePathHash} ${result.digest}`;
		if (path === undefined || result.digest !== digest) {
			throw new AttestationBundleResponseMismatchError(
				'attachment',
				'unexpected',
				identity
			);
		}
		if (answers.has(path)) {
			throw new AttestationBundleResponseMismatchError(
				'attachment',
				'duplicate',
				identity
			);
		}
		answers.set(path, {
			storePathHash: path,
			digest,
			outcome: result.status === 'already-present' ? 'reused' : result.status
		});
	}

	return paths.map((path) => {
		const result = answers.get(path);
		if (result === undefined) {
			throw new AttestationBundleResponseMismatchError(
				'attachment',
				'missing',
				`${path} ${digest}`
			);
		}
		return result;
	});
}

export async function runBundleAttachment(
	groups: readonly BundleGroup[],
	log: StepLog,
	options: {
		readonly client: AttestationBundleClient;
		readonly progress: AttachmentProgress;
		readonly skipUnservable?: boolean;
	}
): Promise<AttestationAttachOutcome> {
	const negotiateStep = log.group('negotiate', {
		humanLabel: 'Checking existing attestations'
	});
	let hasNegotiatedBundles = false;
	const negotiate = async (
		batch: readonly BundleGroup[]
	): Promise<ReadonlyMap<string, AttestationBundleDecisionInput>> => {
		let response: AttestationBundleNegotiateResponseInput;
		try {
			response = await options.client.negotiateAttestationBundles({
				bundles: batch.map(({ digest }) => ({ digest }))
			});
		} catch (error) {
			if (
				!hasNegotiatedBundles &&
				error instanceof ORPCError &&
				error.code === 'NOT_FOUND' &&
				error.status === 404 &&
				!error.defined
			) {
				throw new AttestationBundleTransportUnavailableError({ cause: error });
			}
			throw error;
		}
		hasNegotiatedBundles = true;
		return exactBundleDecisions(batch, response.bundles);
	};
	const uploadStep = log.group('upload', { humanLabel: 'Uploading bundles' });
	const attachStep = log.group('attach', {
		humanLabel: 'Attaching attestations'
	});
	let uploadedBytes = 0;
	const upload = async (
		group: BundleGroup,
		decision: AttestationBundleDecisionInput
	): Promise<void> => {
		if (decision.action !== 'upload') {
			return;
		}
		await options.client.uploadNar(decision.r2Key, byteStream([group.bytes]));
		uploadedBytes += group.bytes.byteLength;
		options.progress.uploaded(group.bytes.byteLength);
	};
	const bundles: AttestationBundleOutcome[] = [];
	const batches = chunk(
		groups,
		Math.min(6, attestationBundleNegotiateMaxBundles)
	);

	for (const batch of batches) {
		const decisions = await negotiate(batch);
		const attachGroup = async (
			group: BundleGroup
		): Promise<readonly AttestationBundleOutcome[]> => {
			let decision = decisions.get(group.digest);
			if (decision === undefined) {
				throw new AttestationBundleResponseMismatchError(
					'negotiation',
					'missing',
					group.digest
				);
			}
			await upload(group, decision);
			const renew = async (): Promise<AttestationBundleDecisionInput> => {
				const negotiation = await negotiate([group]);
				const renewed = negotiation.get(group.digest);
				if (renewed === undefined) {
					throw new AttestationBundleResponseMismatchError(
						'negotiation',
						'missing',
						group.digest
					);
				}
				if (!options.progress.isStopped()) {
					await upload(group, renewed);
				}
				return renewed;
			};
			let expiresAt = decision.expiresAt;
			const outcomes: AttestationBundleOutcome[] = [];
			const pages = chunk([...group.paths], attestationAttachMaxPaths);
			for (const paths of pages) {
				if (options.progress.isStopped()) {
					return outcomes;
				}
				if (Date.now() >= Date.parse(expiresAt)) {
					decision = await renew();
				}
				if (options.progress.isStopped()) {
					return outcomes;
				}
				options.progress.started(
					paths.map((storePathHash) => ({
						storePathHash,
						digest: group.digest
					}))
				);
				let response: AttestationAttachPathsResponseInput;
				try {
					response = await options.client.attachAttestationPaths(
						decision.uploadId,
						{ storePathHashes: paths }
					);
				} catch (error) {
					if (!(error instanceof ORPCError) || error.code !== 'NOT_FOUND') {
						throw error;
					}
					if (options.progress.isStopped()) {
						return outcomes;
					}
					decision = await renew();
					if (options.progress.isStopped()) {
						return outcomes;
					}
					response = await options.client.attachAttestationPaths(
						decision.uploadId,
						{ storePathHashes: paths }
					);
				}
				expiresAt = response.expiresAt;
				const page = exactPathOutcomes(group.digest, paths, response);
				for (const result of page) {
					options.progress.record(result);
				}
				if (options.skipUnservable !== true) {
					const unavailable = page.find(
						(result) => result.outcome === 'unservable'
					);
					if (unavailable !== undefined) {
						throw new AttestationPathUnservableError(unavailable.storePathHash);
					}
				}
				outcomes.push(...page);
			}
			return outcomes;
		};
		const outcomes = await mapWithConcurrency(batch, 6, async (group) => {
			try {
				return await attachGroup(group);
			} catch (error) {
				options.progress.stop();
				throw error;
			}
		});
		bundles.push(...outcomes.flat());
	}
	negotiateStep.success(`${formatCount(groups.length)} distinct bundles`);
	const attached = bundles.filter(
		(result) => result.outcome === 'attached'
	).length;
	const reused = bundles.filter((result) => result.outcome === 'reused').length;
	uploadStep.success(formatBytes(uploadedBytes));
	attachStep.success(`${formatCount(attached)} attached`);

	return {
		attached,
		reused,
		uploadedBytes,
		unservableStorePathHashes: new Set(
			bundles
				.filter((result) => result.outcome === 'unservable')
				.map((result) => result.storePathHash)
		),
		bundles
	};
}
