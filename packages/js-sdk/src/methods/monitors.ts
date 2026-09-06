import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    CreateMonitorRequest,
    UpdateMonitorRequest,
    Monitor,
    MonitorCreateResponse,
    MonitorSnapshot,
    MonitorChange,
    MonitorSnapshotDetail, MonitorSnapshotSummary, MonitorPage, MonitorPageParams, MonitorChangeFeedItem, MonitorCheck, MonitorNotification,
} from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

export async function createMonitor(
    client: AxiosInstance,
    input: CreateMonitorRequest
): Promise<MonitorCreateResponse> {
    const response: AxiosResponse<unknown> = await client.post('/v1/monitors', input);
    return unwrapApiResponse<MonitorCreateResponse>(response.data, 'Failed to create monitor');
}

export async function listMonitors(client: AxiosInstance): Promise<Monitor[]> {
    const response: AxiosResponse<unknown> = await client.get('/v1/monitors');
    return unwrapApiResponse<Monitor[]>(response.data, 'Failed to list monitors');
}

export async function getMonitor(client: AxiosInstance, monitorId: string): Promise<Monitor> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/monitors/${encodeURIComponent(monitorId)}`);
    return unwrapApiResponse<Monitor>(response.data, 'Failed to get monitor');
}

export async function updateMonitor(
    client: AxiosInstance,
    monitorId: string,
    input: UpdateMonitorRequest
): Promise<Monitor> {
    const response: AxiosResponse<unknown> = await client.patch(`/v1/monitors/${encodeURIComponent(monitorId)}`, input);
    return unwrapApiResponse<Monitor>(response.data, 'Failed to update monitor');
}

export async function deleteMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.delete(`/v1/monitors/${encodeURIComponent(monitorId)}`);
    unwrapApiResponse<unknown>(response.data, 'Failed to delete monitor');
}

export async function pauseMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${encodeURIComponent(monitorId)}/pause`);
    unwrapApiResponse<unknown>(response.data, 'Failed to pause monitor');
}

export async function resumeMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${encodeURIComponent(monitorId)}/resume`);
    unwrapApiResponse<unknown>(response.data, 'Failed to resume monitor');
}

/** Trigger an immediate on-demand check. Returns once the check has been queued. */
export async function runMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${encodeURIComponent(monitorId)}/check`);
    unwrapApiResponse<unknown>(response.data, 'Failed to trigger monitor check');
}

export async function getMonitorSnapshots(
    client: AxiosInstance,
    monitorId: string,
    params?: MonitorPageParams
): Promise<MonitorSnapshot[]> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    if (params?.cursor) q.set('cursor', params.cursor);
    const query = q.toString();
    const url = query ? `/v1/monitors/${encodeURIComponent(monitorId)}/snapshots?${query}` : `/v1/monitors/${encodeURIComponent(monitorId)}/snapshots`;
    const response: AxiosResponse<unknown> = await client.get(url);
    return unwrapApiResponse<MonitorSnapshot[]>(response.data, 'Failed to get monitor snapshots');
}

export async function getMonitorChanges(
    client: AxiosInstance,
    monitorId: string,
    params?: MonitorPageParams
): Promise<MonitorChange[]> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    if (params?.cursor) q.set('cursor', params.cursor);
    const query = q.toString();
    const url = query ? `/v1/monitors/${encodeURIComponent(monitorId)}/changes?${query}` : `/v1/monitors/${encodeURIComponent(monitorId)}/changes`;
    const response: AxiosResponse<unknown> = await client.get(url);
    return unwrapApiResponse<MonitorChange[]>(response.data, 'Failed to get monitor changes');
}

export async function getMonitorChange(
    client: AxiosInstance,
    monitorId: string,
    changeId: string
): Promise<MonitorChange> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/monitors/${encodeURIComponent(monitorId)}/changes/${encodeURIComponent(changeId)}`);
    return unwrapApiResponse<MonitorChange>(response.data, 'Failed to get monitor change');
}

function query(params?: Record<string, unknown>): string {
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null) values.set(key, String(value));
    return values.size ? `?${values}` : '';
}
async function page<T>(client: AxiosInstance, url: string): Promise<MonitorPage<T>> {
    const response = await client.get(url);
    const data = unwrapApiResponse<T[]>(response.data, 'Failed to list monitor history');
    const pagination = response.data?.pagination;
    if (!pagination || typeof pagination.has_more !== 'boolean' || (pagination.next_cursor !== null && typeof pagination.next_cursor !== 'string')) {
        throw new Error('Server did not return monitor pagination metadata; use a server with cursor pagination support');
    }
    return { data, pagination };
}
export async function getMonitorSnapshot(client: AxiosInstance, monitorId: string, snapshotId: string): Promise<MonitorSnapshotDetail> {
    const response = await client.get(`/v1/monitors/${encodeURIComponent(monitorId)}/snapshots/${encodeURIComponent(snapshotId)}`);
    return unwrapApiResponse<MonitorSnapshotDetail>(response.data, 'Failed to get snapshot detail');
}
export function getMonitorSnapshotsPage(client: AxiosInstance, monitorId: string, params?: MonitorPageParams): Promise<MonitorPage<MonitorSnapshotSummary>> {
    return page(client, `/v1/monitors/${encodeURIComponent(monitorId)}/snapshots${query(params)}`);
}
export function getMonitorChangesPage(client: AxiosInstance, monitorId: string, params?: MonitorPageParams & { include_diff_text?: boolean }): Promise<MonitorPage<MonitorChange>> {
    return page(client, `/v1/monitors/${encodeURIComponent(monitorId)}/changes${query(params)}`);
}
export function listMonitorChanges(client: AxiosInstance, params?: MonitorPageParams & { change_type?: MonitorChange['change_type'] }): Promise<MonitorPage<MonitorChangeFeedItem>> {
    return page(client, `/v1/monitors/changes${query(params)}`);
}
export async function getMonitorChecks(client: AxiosInstance, monitorId: string, params?: { limit?: number }): Promise<MonitorCheck[]> {
    const response = await client.get(`/v1/monitors/${encodeURIComponent(monitorId)}/checks${query(params)}`);
    return unwrapApiResponse<MonitorCheck[]>(response.data, 'Failed to get monitor checks');
}
export async function getMonitorNotifications(client: AxiosInstance, monitorId: string, params?: { limit?: number }): Promise<MonitorNotification[]> {
    const response = await client.get(`/v1/monitors/${encodeURIComponent(monitorId)}/notifications${query(params)}`);
    return unwrapApiResponse<MonitorNotification[]>(response.data, 'Failed to get monitor notifications');
}
