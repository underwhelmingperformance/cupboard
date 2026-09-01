import type {
	DeploymentStateId,
	DeploymentTransitionId
} from '@cupboard/protocol/deployment';

export interface RegisteredDeploymentTransition {
	readonly id: DeploymentTransitionId;
	readonly from: DeploymentStateId;
	readonly to: DeploymentStateId;
	readonly operation:
		| { readonly kind: 'verify' }
		| {
				readonly kind: 'deploy-runtime-stage';
				readonly stage: string;
		  }
		| {
				readonly kind: 'registered-operation';
				readonly operationId: string;
		  };
}

// The cache lifecycle release replaces this empty registry with its checked-in
// declarative transition sequence. Keeping the registry explicit makes an old
// artifact refuse advancement instead of interpreting caller-supplied work.
export const deploymentForwardTransitions: readonly RegisteredDeploymentTransition[] =
	[];
