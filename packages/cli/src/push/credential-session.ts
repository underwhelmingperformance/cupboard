import {
	type ParsedPushCredential,
	type PushId
} from '@cupboard/protocol/upload';

import { type CredentialProvider } from './r2-upload.ts';

// Issues a push credential, re-using the push id once one has been signed so a
// renewal stays under the same staging prefix. The first call passes none and
// the server signs a fresh id.
export type IssuePushCredential = (
	pushId: PushId | undefined
) => Promise<ParsedPushCredential>;

export interface CredentialSessionOptions {
	readonly refreshMarginMs?: number;
	readonly now?: () => number;
}

export interface CredentialSession {
	pushId(): Promise<PushId>;
	readonly provider: CredentialProvider;
}

const defaultRefreshMarginMs = 5 * 60 * 1000;

/**
 * Supplies renewable R2 credentials for one push. Every renewal reuses the
 * signed push ID, so all uploads remain within the original staging prefix.
 * The provider refreshes the underlying access token when required.
 */
export function credentialSession(
	issue: IssuePushCredential,
	options: CredentialSessionOptions = {}
): CredentialSession {
	const refreshMarginMs = options.refreshMarginMs ?? defaultRefreshMarginMs;
	const now = options.now ?? (() => Date.now());

	let pushId: PushId | undefined;
	let cached: ParsedPushCredential | undefined;
	let inFlight: Promise<ParsedPushCredential> | undefined;

	const isFresh = (credential: ParsedPushCredential): boolean =>
		new Date(credential.expiresAt).getTime() - now() > refreshMarginMs;

	const issueAndCache = async (): Promise<ParsedPushCredential> => {
		try {
			const credential = await issue(pushId);
			pushId = credential.pushId;
			cached = credential;

			return credential;
		} finally {
			inFlight = undefined;
		}
	};

	const provider: CredentialProvider = () => {
		if (cached !== undefined && isFresh(cached)) {
			return Promise.resolve(cached);
		}

		// Concurrent uploads share a single in-flight request; the handle is
		// cleared once that request settles, so the next call made near expiry
		// issues a fresh credential.
		inFlight ??= issueAndCache();

		return inFlight;
	};

	return {
		async pushId() {
			if (pushId !== undefined) {
				return pushId;
			}

			const credential = await provider();

			return credential.pushId;
		},
		provider
	};
}
