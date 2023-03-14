import type { SSTConfig } from 'sst';
import { FoldBackendStack } from './stacks/FoldBackendStack';

export default {
	config(_input) {
		return {
			name: 'fold-backend-services',
			region: 'us-east-1',
		};
	},
	stacks(app) {
		app.stack(FoldBackendStack);
	},
} satisfies SSTConfig;
