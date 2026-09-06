import { jest, describe, it, expect } from '@jest/globals';
import { getMonitorSnapshot, getMonitorSnapshotsPage, getMonitorChangesPage, listMonitorChanges, getMonitorChecks, getMonitorNotifications, updateMonitor } from '../methods/monitors.js';

function client(data: any = [], pagination: any = { has_more: false, next_cursor: null }) {
    return { get: jest.fn<any>().mockResolvedValue({ data: { success: true, data, pagination } }), patch: jest.fn<any>().mockResolvedValue({ data: { success: true, data: {} } }) } as any;
}
describe('Monitor SDK contract', () => {
    it('returns cursor metadata without discarding the server position', async () => {
        const http = client([{ uuid: 'change' }], { has_more: true, next_cursor: 'next+/' });
        const page = await listMonitorChanges(http, { limit: 20, change_type: 'price_up', cursor: 'before+/' });
        expect(page.pagination).toEqual({ has_more: true, next_cursor: 'next+/' });
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/changes?limit=20&change_type=price_up&cursor=before%2B%2F');
    });
    it('supports lazy snapshot/diff reads and stable escaped IDs', async () => {
        const http = client({ uuid: 'snapshot', content_truncated: true, content_length: 300000 });
        expect(await getMonitorSnapshot(http, 'monitor/id', 'snapshot/id')).toMatchObject({ content_truncated: true });
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/monitor%2Fid/snapshots/snapshot%2Fid');
        await getMonitorChangesPage(http, 'm', { include_diff_text: false });
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/m/changes?include_diff_text=false');
        await getMonitorSnapshotsPage(http, 'm', { cursor: 'next' });
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/m/snapshots?cursor=next');
    });
    it('exposes persistent checks and recipient delivery status', async () => {
        const http = client([]);
        await getMonitorChecks(http, 'm', { limit: 20 });
        await getMonitorNotifications(http, 'm', { limit: 10 });
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/m/checks?limit=20');
        expect(http.get).toHaveBeenCalledWith('/v1/monitors/m/notifications?limit=10');
    });
    it('preserves null clears and partial options in PATCH', async () => {
        const http = client(), patch = { goal: null, extract_schema: null, track_mode: 'text' as const, notify_options: { channels: ['email' as const] } };
        await updateMonitor(http, 'm', patch);
        expect(http.patch).toHaveBeenCalledWith('/v1/monitors/m', patch);
    });
    it('fails explicitly when a cursor page is requested from an incompatible server', async () => {
        const http = client([], null);
        await expect(listMonitorChanges(http)).rejects.toThrow('pagination metadata');
    });
});
