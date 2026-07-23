import { ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { AwsClient } from 'aws4fetch';

import {
	type R2PresignBindingName,
	R2PresignConfigurationMissingError
} from '../errors.ts';

import {
	createR2TemporaryCredentials,
	pushUploadActions
} from './temporary-credentials.ts';

// A staging key a push credential's prefix scope would cover, used only to probe
// that R2 accepts a temporary credential. Nothing is written; the probe reads a
// key that never exists.
const credentialProbeKey = 'staging/.cupboard-credential-probe/probe';
const credentialProbePrefix = 'staging/.cupboard-credential-probe/';

export interface R2PresignerConfiguration {
	readonly accountId: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly bucketName: string;
}

export class R2Presigner {
	private readonly endpoint: string;

	constructor(private readonly configuration: R2PresignerConfiguration) {
		this.endpoint = `https://${configuration.accountId}.r2.cloudflarestorage.com`;
	}

	/**
	 * Proves R2 accepts a temporary credential issued the way a push does, the
	 * mechanism uploads actually use. A push signs with a short-lived credential
	 * derived from the configured pair, so a valid pair alone is not enough: R2
	 * must also honour the derived credential, granted by the same write-only
	 * action set. The probe reads a never-present key under a staging prefix the
	 * credential is confined to; a rejected credential answers 400, and a valid
	 * one answers 403 (the write-only grant may not read) or 404. Nothing is
	 * written.
	 */
	async probeTemporaryCredential(now: Date): Promise<Response> {
		const credential = await createR2TemporaryCredentials(
			this.configuration,
			{
				actions: pushUploadActions,
				prefixPaths: [credentialProbePrefix],
				ttlSeconds: ttlSecondsSchema.parse(60)
			},
			now
		);

		const client = new AwsClient({
			accessKeyId: credential.accessKeyId,
			secretAccessKey: credential.secretAccessKey,
			sessionToken: credential.sessionToken,
			service: 's3',
			region: 'auto'
		});

		return client.fetch(
			`${this.endpoint}/${this.configuration.bucketName}/${credentialProbeKey}`,
			{ method: 'GET' }
		);
	}
}

// The generated env types say `string`, but a secret never put has no binding
// at all and reads as undefined; both spellings of "missing" must count.
export interface R2PresignEnv {
	readonly R2_ACCOUNT_ID: string | undefined;
	readonly R2_ACCESS_KEY_ID: string | undefined;
	readonly R2_BUCKET_NAME: string | undefined;
	readonly R2_SECRET_ACCESS_KEY: string | undefined;
}

export function r2PresignConfiguration(
	env: R2PresignEnv
): R2PresignerConfiguration {
	const missingBindings: R2PresignBindingName[] = [];
	const accountId = env.R2_ACCOUNT_ID ?? '';
	const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
	const bucketName = env.R2_BUCKET_NAME ?? '';
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';

	if (accountId === '') {
		missingBindings.push('R2_ACCOUNT_ID');
	}

	if (accessKeyId === '') {
		missingBindings.push('R2_ACCESS_KEY_ID');
	}

	if (bucketName === '') {
		missingBindings.push('R2_BUCKET_NAME');
	}

	if (secretAccessKey === '') {
		missingBindings.push('R2_SECRET_ACCESS_KEY');
	}

	if (missingBindings.length > 0) {
		throw new R2PresignConfigurationMissingError(missingBindings);
	}

	return { accountId, accessKeyId, bucketName, secretAccessKey };
}
