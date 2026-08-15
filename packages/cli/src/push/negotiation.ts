import { UploadNegotiationMismatchError } from '../errors.ts';

/**
The identity shared by one requested path and the decision answering it.
*/
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
 * Requires a negotiate or preview response to answer every requested path
 * exactly once and nothing else.
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
		// A skip reports the NAR hash the destination already serves. It may differ
		// from the requested one, which is the divergent skip that callers warn
		// about; the store-path hash still identifies the request the decision
		// answers.
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
