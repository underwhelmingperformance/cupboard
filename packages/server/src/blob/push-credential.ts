import { type TtlSeconds, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import type { PushCredential, PushId } from '@cupboard/protocol/upload';

import { PushIdSigningKeyMissingError } from '../errors.ts';
import { stagingPushPrefix } from '../http/http.ts';

import type { R2PresignerConfiguration } from './presign.ts';
import {
	createPushId,
	isPushIdValid,
	type PushIdSigningKey,
	pushIdSigningKeySchema
} from './push-id.ts';
import {
	createR2TemporaryCredentials,
	pushUploadActions
} from './temporary-credentials.ts';

// A credential never runs longer than this regardless of the token, a backstop
// against a misconfigured long-lived token; the token's own expiry is the usual
// bound and is almost always shorter.
const pushCredentialMaxTtlSeconds = 6 * 60 * 60;

// The life a credential gets: the time the access token has left, never beyond
// the cap and never below a second. Bounding it by the token means a credential
// cannot outlive the authorisation that issued it.
export function pushCredentialTtlSeconds(
	tokenExpiresAt: Date,
	now: Date
): TtlSeconds {
	const remaining = Math.floor(
		(tokenExpiresAt.getTime() - now.getTime()) / 1000
	);

	return ttlSecondsSchema.parse(
		Math.max(1, Math.min(pushCredentialMaxTtlSeconds, remaining))
	);
}

export interface PushIdSigningEnv {
	readonly PUSH_ID_SIGNING_KEY: string | undefined;
}

export function pushIdSigningKey(env: PushIdSigningEnv): PushIdSigningKey {
	const key = env.PUSH_ID_SIGNING_KEY ?? '';

	if (key === '') {
		throw new PushIdSigningKeyMissingError();
	}

	return pushIdSigningKeySchema.parse(key);
}

/**
 * Issues and verifies a push's upload credential. The push id is signed with the
 * dedicated key so the server recognises it again on negotiate, and the
 * credential is confined to that push's staging prefix.
 */
export class PushCredentialIssuer {
	// The R2 configuration is read lazily, only when a credential is issued, so
	// verifying a push id on negotiate needs the signing key alone and does not
	// fault when the R2 credentials are absent.
	constructor(
		private readonly configuration: () => R2PresignerConfiguration,
		private readonly signingKey: PushIdSigningKey
	) {}

	// Re-issues a credential for an existing push id, the refresh path: the prefix
	// is unchanged, so the new credential still covers the bytes the push has
	// already staged.
	async issueFor(
		pushId: PushId,
		ttlSeconds: TtlSeconds,
		now: Date
	): Promise<PushCredential> {
		// Granted by the write-only action set: R2 rejects a
		// credential carrying both a scope and an actions claim, and the actions
		// leave the credential unable to read another upload's staged bytes. The
		// staging prefix confines it to this push.
		const credential = await createR2TemporaryCredentials(
			this.configuration(),
			{
				actions: pushUploadActions,
				prefixPaths: [stagingPushPrefix(pushId)],
				ttlSeconds
			},
			now
		);

		return { pushId, ...credential };
	}

	async issue(ttlSeconds: TtlSeconds, now: Date): Promise<PushCredential> {
		return this.issueFor(await createPushId(this.signingKey), ttlSeconds, now);
	}

	verify(pushId: PushId): Promise<boolean> {
		return isPushIdValid(this.signingKey, pushId);
	}
}
