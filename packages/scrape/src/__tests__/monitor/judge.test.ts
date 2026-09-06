import { jest, describe, it, beforeEach, expect } from '@jest/globals';
const generate = jest.fn<any>(), modelId = jest.fn<any>();
jest.unstable_mockModule('@anycrawl/ai', () => ({ generateObject: generate, getExtractModelId: modelId, getLLM: () => ({}) }));
const { judgeChange } = await import('../../monitor/judge.js');
beforeEach(() => { generate.mockReset(); modelId.mockReset().mockReturnValue('test-model'); });
describe('Monitor AI judgment completeness', () => {
    it('records unavailable when the configured provider cannot be resolved', async () => {
        modelId.mockImplementation(() => { throw new Error('Provider not configured'); });
        expect(await judgeChange('Pricing', 'Diff', 'https://example.com')).toMatchObject({ meaningful: null, status: 'unavailable' });
        expect(generate).not.toHaveBeenCalled();
    });
    it('does not send truncated evidence or oversized combined input to the provider', async () => {
        expect(await judgeChange('Pricing', 'Partial diff', 'https://example.com', { complete: false })).toMatchObject({ meaningful: null, status: 'incomplete' });
        expect(await judgeChange('G'.repeat(20000), 'Diff', 'https://example.com')).toMatchObject({ meaningful: null, status: 'incomplete' });
        expect(generate).not.toHaveBeenCalled();
    });
    it('records a provider failure as unknown and preserves a successful verdict', async () => {
        generate.mockRejectedValueOnce(new Error('Temporary provider failure'));
        expect(await judgeChange('Pricing', 'Diff', 'https://example.com')).toMatchObject({ meaningful: null, status: 'unavailable' });
        generate.mockResolvedValueOnce({ object: { meaningful: false, confidence: 'high', reason: 'Noise' } });
        expect(await judgeChange('Pricing', 'Diff', 'https://example.com')).toMatchObject({ meaningful: false, confidence: 'high', status: 'complete' });
    });
});
