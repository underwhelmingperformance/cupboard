import { type R2ObjectKey } from '../http/http.ts';

import {
	type R2AdmissionOptions,
	type R2RequestAdmission
} from './r2-request-admission.ts';

type MultipartObjectStore = Pick<
	R2Bucket,
	'head' | 'createMultipartUpload' | 'resumeMultipartUpload'
>;

class AdmittedMultipartUpload implements R2MultipartUpload {
	constructor(
		private readonly upload: R2MultipartUpload,
		private readonly admission: R2RequestAdmission,
		private readonly options: R2AdmissionOptions
	) {}
	get key(): string {
		return this.upload.key;
	}
	get uploadId(): string {
		return this.upload.uploadId;
	}
	uploadPart(
		...arguments_: Parameters<R2MultipartUpload['uploadPart']>
	): Promise<R2UploadedPart> {
		return this.admission.write(
			() => this.upload.uploadPart(...arguments_),
			this.options
		);
	}
	complete(parts: R2UploadedPart[]): Promise<R2Object> {
		return this.admission.write(
			() => this.upload.complete(parts),
			this.options
		);
	}
	abort(): Promise<void> {
		return this.admission.write(() => this.upload.abort(), {
			priority: this.options.priority
		});
	}
}

/**
 * Uses the native verifier's admission for multipart operations. Pass a bucket
 * with deadline and subrequest wrappers; admission reserves queued calls and
 * the binding records each call when it starts.
 */
export class ConnectionLimitedMultipartBucket {
	constructor(
		private readonly bucket: MultipartObjectStore,
		private readonly admission: R2RequestAdmission,
		private readonly options: R2AdmissionOptions = {}
	) {}
	head(key: R2ObjectKey): Promise<R2Object | null> {
		return this.admission.read(() => this.bucket.head(key), this.options);
	}
	async createMultipartUpload(
		key: R2ObjectKey,
		options?: R2MultipartOptions
	): Promise<R2MultipartUpload> {
		const upload = await this.admission.write(
			() => this.bucket.createMultipartUpload(key, options),
			this.options
		);
		return new AdmittedMultipartUpload(upload, this.admission, this.options);
	}
	resumeMultipartUpload(key: R2ObjectKey, uploadId: string): R2MultipartUpload {
		return new AdmittedMultipartUpload(
			this.bucket.resumeMultipartUpload(key, uploadId),
			this.admission,
			this.options
		);
	}
}
