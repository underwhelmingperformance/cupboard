import type { PushCredential } from '@cupboard/protocol/upload';

import { PushIdSigningKeyMissingError } from '../errors.ts';
import { stagingPushPrefix } from '../http/http.ts';

import type { R2PresignerConfiguration } from './presign.ts';
import { createPushId, verifyPushId } from './push-id.ts';
import {
	createR2TemporaryCredentials,
	pushUploadActions
} from './temporary-credentials.ts';

// One credential lasts the whole upload phase of a push, comfortably under R2's
// seven-day maximum. A re-negotiated slot stages under the same prefix, so the
// one credential keeps covering the push however long it runs.
const pushCredentialTtlSeconds = 6 * 60 * 60;

export interface PushIdSigningEnv {
	readonly PUSH_ID_SIGNING_KEY: string | undefined;
}

export function pushIdSigningKey(env: PushIdSigningEnv): string {
	const key = env.PUSH_ID_SIGNING_KEY ?? '';

	if (key === '') {
		throw new PushIdSigningKeyMissingError();
	}

	return key;
}

/**
 * Issues and verifies a push's upload credential. The push id is signed with the
 * dedicated key so the server recognises it again on negotiate, and the
 * credential is confined to that push's staging prefix and the write-only upload
 * actions.
 */
export class PushCredentialIssuer {
	// The R2 configuration is read lazily, only when a credential is issued, so
	// verifying a push id on negotiate needs the signing key alone and does not
	// fault when the R2 credentials are absent.
	constructor(
		private readonly configuration: () => R2PresignerConfiguration,
		private readonly signingKey: string
	) {}

	async issue(now: Date): Promise<PushCredential> {
		const pushId = await createPushId(this.signingKey);
		const credential = await createR2TemporaryCredentials(
			this.configuration(),
			{
				scope: 'object-read-write',
				actions: pushUploadActions,
				prefixPaths: [stagingPushPrefix(pushId)],
				ttlSeconds: pushCredentialTtlSeconds
			},
			now
		);

		return { pushId, ...credential };
	}

	verify(pushId: string): Promise<boolean> {
		return verifyPushId(this.signingKey, pushId);
	}
}
