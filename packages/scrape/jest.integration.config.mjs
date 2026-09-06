import baseConfig from '../../jest.config.base.mjs';
export default { ...baseConfig, testMatch: ['**/src/integration/**/*.test.ts'], testTimeout: 30000 };
