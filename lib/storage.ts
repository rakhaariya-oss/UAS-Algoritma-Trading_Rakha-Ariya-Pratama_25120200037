export type StoredPayload = {
  state: Record<string, any>;
  logs: Array<Record<string, any>>;
};

const MEMORY_KEY = '__INDODAX_DRYRUN_STATE__';

const isServer = typeof window === 'undefined';
const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

const runRedisCommand = async (command: string[]) => {
  if (!redisUrl || !redisToken) {
    throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required for persistent storage.');
  }

  const response = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    cache: 'no-store'
  });
  const payload = await response.json();

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Persistent storage request failed: ${response.status}`);
  }

  return payload.result;
};

export const readStoredJson = async (key = 'indodax-dryrun-state') => {
  if (!isServer) {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }

  if (redisUrl || redisToken) {
    const raw = await runRedisCommand(['GET', key]);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  const globalState = (globalThis as any)[MEMORY_KEY];
  return globalState ?? null;
};

export const writeStoredJson = async (payload: StoredPayload, key = 'indodax-dryrun-state') => {
  if (!isServer) {
    localStorage.setItem(key, JSON.stringify(payload));
    return payload;
  }

  if (redisUrl || redisToken) {
    await runRedisCommand(['SET', key, JSON.stringify(payload)]);
    return payload;
  }

  (globalThis as any)[MEMORY_KEY] = payload;
  return payload;
};

export const getStorageMode = () => !isServer
  ? 'browser'
  : redisUrl && redisToken
    ? 'persistent'
    : 'memory';

export const appendLog = async (entry: Record<string, any>, key = 'indodax-dryrun-state') => {
  const current = (await readStoredJson(key)) ?? { state: {}, logs: [] };
  const next = {
    ...current,
    logs: [...(current.logs ?? []), entry]
  };

  await writeStoredJson(next, key);
  return next;
};

export const getRuntimeConfig = () => ({
  cronSecret: process.env.CRON_SECRET ?? 'dev-secret',
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Indodax Dry Run Bot',
  version: '1.0.0'
});
