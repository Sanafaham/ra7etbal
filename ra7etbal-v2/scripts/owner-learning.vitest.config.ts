import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vite.config';
export default mergeConfig(base, defineConfig({ test: {
  setupFiles: ['./scripts/fixtures/owner-learning-offline.ts'],
} }));
