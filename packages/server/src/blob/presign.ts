import { AwsClient } from 'aws4fetch';

import {
	type R2PresignBindingName,
	R2PresignConfigurationMissingError
} from '../errors.ts';

export interface R2PresignOptions {
	readonly key: string;
	readonly checksumSha256: string;
	readonly expiresSeconds: number;
}

export interface R2PresignerConfiguration {
	readonly accountId: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly bucketName: string;
}

export class R2Presigner {
	private readonly client: AwsClient;
	private readonly endpoint: string;

	constructor(private readonly configuration: R2PresignerConfiguration) {
		this.client = new AwsClient({
			accessKeyId: configuration.accessKeyId,
			secretAccessKey: configuration.secretAccessKey,
			service: 's3',
			region: 'auto'
		});
		this.endpoint = `https://${configuration.accountId}.r2.cloudflarestorage.com`;
	}

	private objectUrl(key: string, expiresSeconds: number): string {
		const url = new URL(
			`${this.endpoint}/${this.configuration.bucketName}/${key}`
		);
		url.searchParams.set('X-Amz-Expires', String(expiresSeconds));

		return url.href;
	}

	async presignPutUrl(options: R2PresignOptions): Promise<string> {
		// R2 ignores a query-hoisted checksum (no integrity check) and rejects an
		// unsigned x-amz-checksum-sha256 header, so the checksum stays a signed
		// header: a `signQuery` sign leaves the passed headers in SignedHeaders
		// rather than hoisting them, so the uploader sends the header and R2
		// verifies both the signature and the body.
		const signed = await this.client.sign(
			this.objectUrl(options.key, options.expiresSeconds),
			{
				method: 'PUT',
				headers: { 'x-amz-checksum-sha256': options.checksumSha256 },
				aws: { signQuery: true }
			}
		);

		return signed.url;
	}

	/**
	 * A presigned HEAD for a probe object, used to prove the configured
	 * credentials sign requests R2 accepts (a missing object still answers
	 * 404 with a valid signature; a bad pair answers 401 or 403).
	 */
	async presignHeadUrl(key: string, expiresSeconds: number): Promise<string> {
		const signed = await this.client.sign(this.objectUrl(key, expiresSeconds), {
			method: 'HEAD',
			aws: { signQuery: true }
		});

		return signed.url;
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
