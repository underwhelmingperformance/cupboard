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
	/**
	Re-issue once the credential is within this long of expiry.
	*/
	readonly refreshMarginMs?: number;
	/**
	Clock, injectable for tests.
	*/
	readonly now?: () => number;
}

// The credential lifecycle for one push: a stable signed push id and a renewing
// R2 credential bound to it.
export interface CredentialSession {
	/**
	The signed push id every negotiate names, issued on first use.
	*/
	pushId(): Promise<PushId>;
	/**
	The provider the uploader signs with; re-issues as the credential expires.
	*/
	readonly provider: CredentialProvider;
}

const defaultRefreshMarginMs = 5 * 60 * 1000;

/**
 * Holds one push's credential and renews it. The managed S3 upload re-invokes
 * the provider as the credential nears expiry; each renewal re-issues against the
 * same push id (refreshing the underlying access token when the issuer does), so
 * a push that outlives a single credential keeps streaming. A memoised credential
 * would instead leave the upload signing with an expired session token once the
 * short-lived write token it was capped at lapsed.
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
