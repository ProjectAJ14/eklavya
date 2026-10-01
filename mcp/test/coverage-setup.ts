import { afterAll } from 'vitest';
import v8 from 'node:v8';

// Vitest kills its worker processes rather than letting them exit, and a
// killed process never writes its NODE_V8_COVERAGE report. Flush it per file.
afterAll(() => v8.takeCoverage());
