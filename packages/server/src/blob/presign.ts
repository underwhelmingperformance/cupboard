import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
	private readonly client: S3Client;

	constructor(private readonly configuration: R2PresignerConfiguration) {
		this.client = new S3Client({
			credentials: {
				accessKeyId: configuration.accessKeyId,
				secretAccessKey: configuration.secretAccessKey
			},
			endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
			forcePathStyle: true,
			region: 'auto'
		});
	}

	presignPutUrl(options: R2PresignOptions): Promise<string> {
		return getSignedUrl(
			this.client,
			new PutObjectCommand({
				Bucket: this.configuration.bucketName,
				Key: options.key,
				ChecksumSHA256: options.checksumSha256
			}),
			{ expiresIn: options.expiresSeconds }
		);
	}
}
