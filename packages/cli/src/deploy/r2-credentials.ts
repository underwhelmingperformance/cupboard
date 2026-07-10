import { AwsClient } from 'aws4fetch';

import { resilientFetcher } from '../client/transport.ts';

import { type DeployUi, terminalLink } from './ui.ts';

export interface R2Credentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

/** Prompt for an existing pair; undefined when cancelled. */
export async function promptR2CredentialPair(
	ui: DeployUi,
	accountId: string
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

	return { accessKeyId: accessKeyEdit.value, secretAccessKey };
}

/** The verdict of probing R2 with a credential pair. */
export type R2CredentialCheck =
	| { readonly kind: 'valid' }
	| { readonly kind: 'rejected'; readonly status: number }
	| { readonly kind: 'unreachable'; readonly cause: unknown };

export type R2AccessKeyIdProblem = 'invalid-hex32';

/** The access key id is the Cloudflare API token id: 32 hex characters. */
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

/** The secret is the hex SHA-256 of the token value: 64 hex characters. */
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
 * Whether the credential pair can write to the bucket the way a push does,
 * leaving nothing behind: begin a multipart upload, then abort it. Beginning one
 * proves write access (a push stages every NAR as a multipart upload) and
 * creates no object, since only completing one would; the abort clears the
 * in-progress upload. Probing a write (not a read) lets a write-only token
 * pass, since a push uploads with a write-only credential.
 * 401/403 means R2 rejected the pair.
 */
export async function checkR2Credentials(
	options: {
		readonly accountId: string;
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
			// A begun upload holds no object, so a failed abort leaves only an empty
			// in-progress upload that R2 drops on its own; the verdict is already set.
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
