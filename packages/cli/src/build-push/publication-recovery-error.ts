import { CodedError } from '@cupboard/shared/errors';

export class PublicationRecoveryError extends CodedError {
	constructor(message: string, options?: ErrorOptions) {
		super(
			`${message}. Preserve the receipt and publication journals; retry the original invocation with its original recovery files. Do not reset unfinished capture state.`,
			options
		);
		this.name = 'PublicationRecoveryError';
	}
}
