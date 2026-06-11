import { AwsClient } from 'aws4fetch';

export interface R2Credentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

/** The verdict of probing R2 with a credential pair. */
export type R2CredentialCheck =
	| { readonly kind: 'valid' }
	| { readonly kind: 'rejected'; readonly status: number }
	| { readonly kind: 'unreachable'; readonly cause: unknown };

/** The access key id is the Cloudflare API token id: 32 hex characters. */
export function accessKeyIdProblem(value: string): string | undefined {
	return /^[0-9a-f]{32}$/i.test(value)
		? undefined
		: 'an R2 access key id is 32 hex characters (the API token id)';
}

/** The secret is the hex SHA-256 of the token value: 64 hex characters. */
export function secretAccessKeyProblem(value: string): string | undefined {
	return /^[0-9a-f]{64}$/i.test(value)
		? undefined
		: 'an R2 secret access key is 64 hex characters';
}

/**
 * Whether the credential pair authenticates against R2, without writing
 * anything: a signed HEAD for an object that need not exist. Any authenticated
 * response (200, or 404 for a missing object or bucket) proves the pair;
 * 401/403 means R2 rejected it. A read-denied (write-only) token is reported
 * as rejected too, which is why the caller offers an override.
 */
export async function checkR2Credentials(
	options: {
		readonly accountId: string;
		readonly bucketName: string;
		readonly credentials: R2Credentials;
	},
	fetcher: typeof fetch = fetch
): Promise<R2CredentialCheck> {
	const client = new AwsClient({
		accessKeyId: options.credentials.accessKeyId,
		secretAccessKey: options.credentials.secretAccessKey,
		service: 's3',
		region: 'auto'
	});

	const url = `https://${options.accountId}.r2.cloudflarestorage.com/${options.bucketName}/.cupboard-credential-probe`;

	let response: Response;

	try {
		const signed = await client.sign(url, { method: 'HEAD' });
		response = await fetcher(signed);
	} catch (error) {
		return { kind: 'unreachable', cause: error };
	}

	if (response.ok || response.status === 404) {
		return { kind: 'valid' };
	}

	return { kind: 'rejected', status: response.status };
}
