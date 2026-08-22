import { readResponseText } from '@cupboard/shared/response-body';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';

import { resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

import type { CloudflareAccountId } from './identifiers.ts';
import { type DeployUi, terminalLink } from './ui.ts';

// The two halves of an R2 S3 credential pair, each branded so an access key id
// and a secret access key cannot be swapped at a call site that takes both.
export const r2AccessKeyIdSchema = z.string().brand('R2AccessKeyId');
export type R2AccessKeyId = z.infer<typeof r2AccessKeyIdSchema>;

export const r2SecretAccessKeySchema = z.string().brand('R2SecretAccessKey');
export type R2SecretAccessKey = z.infer<typeof r2SecretAccessKeySchema>;

export interface R2Credentials {
	readonly accessKeyId: R2AccessKeyId;
	readonly secretAccessKey: R2SecretAccessKey;
}

export async function promptR2CredentialPair(
	ui: DeployUi,
	accountId: CloudflareAccountId
): Promise<R2Credentials | undefined> {
	const tokensPage = `https://dash.cloudflare.com/${accountId}/r2/api-tokens`;

	ui.info(
		`Create an R2 API token (Object Read & Write on the cache bucket) at\n${terminalLink(tokensPage, tokensPage)}`
	);

	const accessKeyEdit = await ui.editText({
		message: 'R2 access key id',
		problem: accessKeyIdProblemText
	});

	if (accessKeyEdit.kind !== 'set') {
		return undefined;
	}

	const secretAccessKey = await ui.secret(
		'R2 secret access key',
		secretAccessKeyProblemText
	);

	if (secretAccessKey === undefined) {
		return undefined;
	}

	return {
		accessKeyId: r2AccessKeyIdSchema.parse(accessKeyEdit.value),
		secretAccessKey: r2SecretAccessKeySchema.parse(secretAccessKey)
	};
}

export type R2CredentialCheck =
	| { readonly kind: 'valid' }
	| { readonly kind: 'rejected'; readonly status: number }
	| { readonly kind: 'invalid-response'; readonly cause: Error }
	| { readonly kind: 'unreachable'; readonly cause: unknown };

/**
R2 accepted the request but did not identify exactly one multipart upload.
*/
class R2CredentialResponseError extends CliError {
	constructor() {
		super(
			'R2 returned a successful multipart-upload response without exactly one non-empty UploadId.'
		);
		this.name = 'R2CredentialResponseError';
	}
}

export type R2AccessKeyIdProblem = 'invalid-hex32';

export function accessKeyIdProblem(
	value: string
): R2AccessKeyIdProblem | undefined {
	return /^[0-9a-f]{32}$/i.test(value) ? undefined : 'invalid-hex32';
}

const accessKeyIdProblemMessages: Record<R2AccessKeyIdProblem, string> = {
	'invalid-hex32': 'an R2 access key id is 32 hex characters (the API token id)'
};

export function accessKeyIdProblemMessage(
	problem: R2AccessKeyIdProblem
): string {
	return accessKeyIdProblemMessages[problem];
}

function accessKeyIdProblemText(value: string): string | undefined {
	const problem = accessKeyIdProblem(value);

	return problem === undefined ? undefined : accessKeyIdProblemMessage(problem);
}

export type R2SecretAccessKeyProblem = 'invalid-hex64';

export function secretAccessKeyProblem(
	value: string
): R2SecretAccessKeyProblem | undefined {
	return /^[0-9a-f]{64}$/i.test(value) ? undefined : 'invalid-hex64';
}

const secretAccessKeyProblemMessages: Record<R2SecretAccessKeyProblem, string> =
	{
		'invalid-hex64': 'an R2 secret access key is 64 hex characters'
	};

export function secretAccessKeyProblemMessage(
	problem: R2SecretAccessKeyProblem
): string {
	return secretAccessKeyProblemMessages[problem];
}

function secretAccessKeyProblemText(value: string): string | undefined {
	const problem = secretAccessKeyProblem(value);

	return problem === undefined
		? undefined
		: secretAccessKeyProblemMessage(problem);
}

const credentialProbeKey = '.cupboard-credential-probe';

/**
 * Begins a multipart upload to test the same write access that a push needs.
 * R2 creates no object until an upload completes. If the response contains an
 * upload id, the probe attempts to abort it. A successful begin is accepted
 * even if that cleanup request fails. This permits write-only credentials;
 * 401 or 403 rejects them.
 */
export async function checkR2Credentials(
	options: {
		readonly accountId: CloudflareAccountId;
		readonly bucketName: string;
		readonly credentials: R2Credentials;
	},
	fetcher: typeof fetch = resilientFetcher('replay-unsafe')
): Promise<R2CredentialCheck> {
	const client = new AwsClient({
		accessKeyId: options.credentials.accessKeyId,
		secretAccessKey: options.credentials.secretAccessKey,
		service: 's3',
		region: 'auto'
	});

	const objectUrl = `https://${options.accountId}.r2.cloudflarestorage.com/${options.bucketName}/${credentialProbeKey}`;

	let begun: Response;

	try {
		const signed = await client.sign(`${objectUrl}?uploads`, {
			method: 'POST'
		});
		begun = await fetcher(signed);
	} catch (error) {
		return { kind: 'unreachable', cause: error };
	}

	if (!begun.ok) {
		return { kind: 'rejected', status: begun.status };
	}

	let body: string;

	try {
		body = await readResponseText(begun, {
			description: 'R2 multipart-upload response',
			maximumBytes: 64 * 1024
		});
	} catch (error) {
		return {
			kind: 'invalid-response',
			cause: error instanceof Error ? error : new R2CredentialResponseError()
		};
	}

	const uploadId = parseUploadId(body);

	if (uploadId === undefined) {
		return { kind: 'invalid-response', cause: new R2CredentialResponseError() };
	}

	const signed = await client.sign(
		`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`,
		{ method: 'DELETE' }
	);

	try {
		await fetcher(signed);
	} catch {
		// A begun upload holds no object, so a failed abort leaves only an empty
		// in-progress upload that R2 drops on its own; the verdict is already set.
	}

	return { kind: 'valid' };
}

const initiateResultPattern =
	/^\s*(?:<\?xml[^>]*\?>\s*)?<InitiateMultipartUploadResult(?:\s[^>]*)?>([\s\S]*)<\/InitiateMultipartUploadResult>\s*$/u;
const uploadIdPattern = /<UploadId>([^<]+)<\/UploadId>/gu;

function parseUploadId(body: string): string | undefined {
	const result = initiateResultPattern.exec(body);

	if (result === null) {
		return undefined;
	}

	const content = result[1];

	if (content === undefined) {
		return undefined;
	}

	const uploadIds = content.matchAll(uploadIdPattern).toArray();
	const uploadId =
		uploadIds.length === 1 ? (uploadIds[0]?.[1]?.trim() ?? '') : '';

	return uploadId === '' ? undefined : uploadId;
}
