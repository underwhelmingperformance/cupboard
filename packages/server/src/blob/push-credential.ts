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

const pushCredentialMaxTtlSeconds = 6 * 60 * 60;

/**
 * Uses the access token's remaining whole seconds, capped at six hours and
 * floored at one second. The floor also applies after the token has expired.
 */
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
 * Restricts each R2 credential to one push's staging prefix. The separately
 * signed push ID lets negotiation verify the ID without storing per-push state.
 */
export class PushCredentialIssuer {
	// The R2 configuration is read lazily, only when a credential is issued, so
	// verifying a push id on negotiate needs the signing key alone and does not
	// fault when the R2 credentials are absent.
	constructor(
		private readonly configuration: () => R2PresignerConfiguration,
		private readonly signingKey: PushIdSigningKey
	) {}

	// Refresh must keep the existing push ID so the replacement credential can
	// still access bytes already staged under its prefix.
	async issueFor(
		pushId: PushId,
		ttlSeconds: TtlSeconds,
		now: Date
	): Promise<PushCredential> {
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
