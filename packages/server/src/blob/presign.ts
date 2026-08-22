import { AwsClient } from 'aws4fetch';

import {
	type R2PresignBindingName,
	R2PresignConfigurationMissingError
} from '../errors.ts';

import {
	createR2TemporaryCredentials,
	pushUploadActions,
	r2CredentialTtlSecondsSchema
} from './temporary-credentials.ts';

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
	 * Sends a header-signed GET with the same derived, action-only and
	 * prefix-scoped credential used by pushes. A 400 response means R2 rejected
	 * the credential; 2xx, 403 and 404 responses show that the request reached R2.
	 * The probe does not write an object.
	 */
	async probeTemporaryCredential(now: Date): Promise<Response> {
		const credential = await createR2TemporaryCredentials(
			this.configuration,
			{
				actions: pushUploadActions,
				prefixPaths: [credentialProbePrefix],
				ttlSeconds: r2CredentialTtlSecondsSchema.parse(60)
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

// An unbound Worker secret is undefined even though the generated binding type
// says string. Treat both undefined and an empty value as missing.
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
