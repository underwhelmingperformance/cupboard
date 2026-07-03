import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { type PushCredential } from '@cupboard/protocol/upload';

// 8 MiB parts, above R2's 5 MiB multipart minimum: a NAR that compresses smaller
// goes in one PutObject, a larger one streams as multipart, bounding memory to
// a few parts at a time.
const partBytes = 8 * 1024 * 1024;

// Re-fetches the push's credential. The S3 client calls it when it has no
// credential yet and again once the cached one nears expiry, so a long push
// renews mid-upload without the caller driving the refresh.
export type CredentialProvider = () => Promise<PushCredential>;

// Streams one compressed NAR to R2; the managed upload chooses single PutObject
// or multipart by size on its own.
export type BlobUploader = (
	r2Key: string,
	body: ReadableStream<Uint8Array>
) => Promise<void>;

export function awsCredentials(credential: PushCredential): {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken: string;
	readonly expiration: Date;
} {
	return {
		accessKeyId: credential.accessKeyId,
		secretAccessKey: credential.secretAccessKey,
		sessionToken: credential.sessionToken,
		expiration: new Date(credential.expiresAt)
	};
}

export interface R2BlobUploaderOptions {
	readonly endpoint: string;
	readonly bucket: string;
	readonly provider: CredentialProvider;
}

/**
 * Builds a blob uploader bound to one push's R2 bucket. The S3 client signs with
 * the push credential and renews it through the provider as it expires, so a
 * push longer than a single credential's life recovers without re-driving the
 * upload from the caller.
 */
export function r2BlobUploader(options: R2BlobUploaderOptions): BlobUploader {
	const client = new S3Client({
		endpoint: options.endpoint,
		region: 'auto',
		forcePathStyle: true,
		credentials: async () => awsCredentials(await options.provider())
	});

	return async (r2Key, body) => {
		const upload = new Upload({
			client,
			params: { Bucket: options.bucket, Key: r2Key, Body: body },
			partSize: partBytes
		});

		await upload.done();
	};
}
