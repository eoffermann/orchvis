import { defineConfig } from 'vitest/config';
import { sharedTest } from '../vitest.shared.js';

export default defineConfig({ test: { ...sharedTest } });
