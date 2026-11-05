import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';

import { uploadDiagnostics } from './upload.ts';

configureConnectionAttempts();

void uploadDiagnostics();
