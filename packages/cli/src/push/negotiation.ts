import { uploadNegotiateMaxPaths } from '@cupboard/protocol/upload';
import { drainWithConcurrency } from '@cupboard/shared/concurrency';

import { UploadNegotiationMismatchError } from '../errors.ts';

export interface UploadNegotiationIdentity {
	readonly storePathHash: string;
	readonly narHash: string;
}

interface UploadNegotiationDecisionIdentity extends UploadNegotiationIdentity {
	readonly action?: string;
}

function identityKey(identity: UploadNegotiationIdentity): string {
	return `${identity.storePathHash}\0${identity.narHash}`;
}

/**
 * Requires a negotiate or preview response to return exactly one decision for
 * every requested path and no decision for another path.
 */
export function exactUploadDecisions<
	Decision extends UploadNegotiationDecisionIdentity
>(
	requested: readonly UploadNegotiationIdentity[],
	decisions: readonly Decision[]
): readonly Decision[] {
	const requestedByKey = new Map(
		requested.map((identity) => [identityKey(identity), identity])
	);
	const requestedByStorePathHash = new Map(
		requested.map((identity) => [identity.storePathHash, identity])
	);
	const answered = new Set<string>();

	for (const decision of decisions) {
		// A skip reports the NAR hash that the destination already serves. It may
		// differ from the requested hash, but the store-path hash still identifies
		// the corresponding request.
		const requestedIdentity =
			requestedByKey.get(identityKey(decision)) ??
			(decision.action === 'skip'
				? requestedByStorePathHash.get(decision.storePathHash)
				: undefined);

		if (requestedIdentity === undefined) {
			throw new UploadNegotiationMismatchError(
				'unexpected',
				decision.storePathHash,
				decision.narHash
			);
		}

		const key = identityKey(requestedIdentity);

		if (answered.has(key)) {
			throw new UploadNegotiationMismatchError(
				'duplicate',
				decision.storePathHash,
				decision.narHash
			);
		}

		answered.add(key);
	}

	for (const [key, identity] of requestedByKey) {
		if (answered.has(key)) {
			continue;
		}

		throw new UploadNegotiationMismatchError(
			'missing',
			identity.storePathHash,
			identity.narHash
		);
	}

	return decisions;
}

/**
 * One negotiate response and whether the server acknowledged grace-aware
 * reporting for it.
 */
export interface NegotiatedGroup<Decision> {
	readonly uploads: readonly Decision[];
	readonly hasUploadGraceFacts: boolean;
}

/**
 * A path handed to an upload worker: either the server's decision for it,
 * with its group's grace-facts acknowledgement, or the error that refused its
 * group.
 */
export type NegotiatedPath<Path, Decision> =
	| {
			readonly kind: 'decided';
			readonly path: Path;
			readonly decision: Decision;
			readonly hasUploadGraceFacts: boolean;
	  }
	| { readonly kind: 'refused'; readonly path: Path; readonly error: unknown };

export interface JustInTimeNegotiation<
	Path,
	Fields extends UploadNegotiationIdentity,
	Decision extends UploadNegotiationDecisionIdentity
> {
	readonly paths: readonly Path[];
	readonly concurrency: number;
	readonly negotiationOf: (path: Path) => Fields;
	readonly negotiate: (
		paths: readonly Fields[]
	) => Promise<NegotiatedGroup<Decision>>;
	readonly maxGroupPaths?: number;
}

// Sizes each negotiate request so that the paths needing an upload or commit
// roughly fill the upload workers that are free. The first request has no
// observed share and uses the concurrency. Until some decision needs an upload
// or commit, the sizer assumes that the next path will need one. Each all-skip
// response then makes the next group larger, up to the maximum.
class NegotiationGroupSizer {
	private observed = 0;
	private publishable = 0;

	constructor(
		private readonly concurrency: number,
		private readonly maxGroupPaths: number
	) {}

	size(freeSlots: number): number {
		if (this.observed === 0) {
			return Math.min(this.concurrency, this.maxGroupPaths);
		}

		const share =
			this.publishable === 0
				? 1 / (this.observed + 1)
				: this.publishable / this.observed;

		return Math.min(
			this.maxGroupPaths,
			Math.ceil(Math.max(1, freeSlots) / share)
		);
	}

	observe(decisions: readonly UploadNegotiationDecisionIdentity[]): void {
		this.observed += decisions.length;
		this.publishable += decisions.filter(
			(decision) => decision.action !== 'skip'
		).length;
	}
}

async function* negotiateJustInTime<
	Path,
	Fields extends UploadNegotiationIdentity,
	Decision extends UploadNegotiationDecisionIdentity
>(
	negotiation: JustInTimeNegotiation<Path, Fields, Decision>,
	freeSlots: () => number
): AsyncGenerator<NegotiatedPath<Path, Decision>> {
	const sizer = new NegotiationGroupSizer(
		negotiation.concurrency,
		negotiation.maxGroupPaths ?? uploadNegotiateMaxPaths
	);
	let offset = 0;

	while (offset < negotiation.paths.length) {
		const group = negotiation.paths.slice(
			offset,
			offset + sizer.size(freeSlots())
		);
		offset += group.length;

		const fields = group.map((path) => negotiation.negotiationOf(path));
		let response: NegotiatedGroup<Decision>;

		try {
			response = await negotiation.negotiate(fields);
			exactUploadDecisions(fields, response.uploads);
		} catch (error) {
			for (const path of group) {
				yield { kind: 'refused', path, error };
			}

			continue;
		}

		sizer.observe(response.uploads);

		const pathByStorePathHash = new Map(
			fields.map((field, index) => [field.storePathHash, group[index]])
		);

		for (const decision of response.uploads) {
			const path = pathByStorePathHash.get(decision.storePathHash);

			if (path === undefined) {
				throw new UploadNegotiationMismatchError(
					'unexpected',
					decision.storePathHash,
					decision.narHash
				);
			}

			yield {
				kind: 'decided',
				path,
				decision,
				hasUploadGraceFacts: response.hasUploadGraceFacts
			};
		}
	}
}

/**
 * Negotiates paths in small groups as upload workers become free, and runs
 * `run` for each path with no more than `concurrency` runs in progress.
 *
 * Negotiation starts each upload's expiry. Negotiating a group only when an
 * upload worker asks for work keeps at most one negotiate request in flight and
 * at most one negotiated group waiting for upload workers, so no upload waits
 * behind a long queue of earlier uploads. A failed negotiation refuses the
 * paths of its group and later groups continue.
 */
export async function publishJustInTime<
	Path,
	Fields extends UploadNegotiationIdentity,
	Decision extends UploadNegotiationDecisionIdentity
>(
	negotiation: JustInTimeNegotiation<Path, Fields, Decision>,
	run: (item: NegotiatedPath<Path, Decision>) => Promise<void>
): Promise<void> {
	let running = 0;
	const source = negotiateJustInTime(
		negotiation,
		() => negotiation.concurrency - running
	);

	await drainWithConcurrency(source, negotiation.concurrency, async (item) => {
		running += 1;

		try {
			await run(item);
		} finally {
			running -= 1;
		}
	});
}
