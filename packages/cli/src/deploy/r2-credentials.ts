import { AwsClient } from 'aws4fetch';
import { z } from 'zod';

import { resilientFetcher } from '../client/transport.ts';

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
	| { readonly kind: 'unreachable'; readonly cause: unknown };

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
	fetcher: typeof fetch = resilientFetcher()
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

	const uploadId = parseUploadId(await begun.text());

	if (uploadId !== undefined) {
		const signed = await client.sign(
			`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`,
			{ method: 'DELETE' }
		);

		try {
			await fetcher(signed);
		} catch {
			// Credential validity is already established; cleanup is best effort.
		}
	}

	return { kind: 'valid' };
}

function parseUploadId(body: string): string | undefined {
	const open = '<UploadId>';
	const start = body.indexOf(open);
	const end = body.indexOf('</UploadId>');

	if (start === -1 || end === -1) {
		return undefined;
	}

	return body.slice(start + open.length, end);
}
