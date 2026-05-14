/**
 * HTTP-клиент к API RobotMIA: POST /callstack, GET /calltask/result?call_task_id=…
 * Окружение: ROBOTMIA_BASE_URL (обязательно), ROBOTMIA_API_TOKEN или ROBOTMIA_API_KEY (опционально, Bearer).
 */

require('dotenv').config();

const PATH_CALLSTACK = '/callstack';
const PATH_CALLTASK_RESULT = '/calltask/result';
const RESULT_ID_FIELD = 'call_task_id';

/** Числовые коды `status` в ответе GET /calltask/result: дозвон / цель достигнута (дополнять по документации). */
const RESULT_STATUS_ANSWERED = new Set([21]);

/** Коды status: без дозвона / отказ (дополнять по документации). */
const RESULT_STATUS_NOT_ANSWERED = new Set();

function joinUrl(base, path) {
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${b}${p}`;
}

async function robotmiaRequest(method, path, body) {
    const base = process.env.ROBOTMIA_BASE_URL;
    if (!base || !String(base).trim()) {
        const err = new Error('ROBOTMIA_BASE_URL не задан');
        err.statusCode = 503;
        throw err;
    }

    const upperMethod = String(method).toUpperCase();
    let url = joinUrl(base, path);
    let fetchBody;

    if (upperMethod === 'GET' && body != null && typeof body === 'object' && !Array.isArray(body)) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null && v !== '') {
                u.searchParams.set(k, String(v));
            }
        }
        url = u.toString();
    } else if (body !== undefined && upperMethod !== 'GET') {
        fetchBody = JSON.stringify(body);
    }

    const headers = { Accept: 'application/json' };
    if (upperMethod !== 'GET') {
        headers['Content-Type'] = 'application/json';
    }

    const token = String(
        process.env.ROBOTMIA_API_TOKEN || process.env.ROBOTMIA_API_KEY || ''
    ).trim();
    if (token) {
        headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    const res = await fetch(url, {
        method: upperMethod,
        headers,
        body: fetchBody,
    });

    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    if (!res.ok) {
        const err = new Error(
            typeof data === 'object' && data !== null && data.message
                ? String(data.message)
                : `RobotMIA HTTP ${res.status}: ${text.slice(0, 500)}`
        );
        err.statusCode = res.status;
        err.responseBody = data;
        throw err;
    }

    return data;
}

function extractCalltaskId(entry) {
    if (entry == null) {
        return null;
    }
    if (typeof entry === 'string') {
        return entry || null;
    }
    if (typeof entry === 'number' || typeof entry === 'bigint') {
        return String(entry);
    }
    if (typeof entry === 'object') {
        const fromNested =
            entry.data != null && typeof entry.data === 'object' && !Array.isArray(entry.data)
                ? extractCalltaskId(entry.data)
                : null;
        if (fromNested) {
            return fromNested;
        }

        const raw =
            entry.call_task_id ??
            entry.id ??
            entry.task_id ??
            entry.calltask_id ??
            entry.calltaskId ??
            entry.callTaskId ??
            null;

        if (raw == null) {
            return null;
        }
        return typeof raw === 'string' ? raw : String(raw);
    }
    return null;
}

function extractCreatedIds(response, expectedCount) {
    if (response == null) {
        return [];
    }

    if (Array.isArray(response)) {
        return response.map(extractCalltaskId).filter(Boolean);
    }

    if (typeof response === 'object') {
        const candidates = [
            response.ids,
            response.data,
            response.tasks,
            response.calltasks,
            response.results,
            response.items,
        ].filter(Boolean);

        for (const arr of candidates) {
            if (Array.isArray(arr)) {
                const ids = arr.map(extractCalltaskId).filter(Boolean);
                if (ids.length > 0) {
                    return ids;
                }
            }
        }

        const single = extractCalltaskId(response);
        if (single) {
            return [single];
        }
    }

    return [];
}

function extractResultEntries(response) {
    if (response == null) {
        return [];
    }
    if (Array.isArray(response)) {
        return response;
    }
    if (typeof response === 'object') {
        const wrapped = response.data;
        if (wrapped != null && typeof wrapped === 'object') {
            if (Array.isArray(wrapped)) {
                return wrapped;
            }
            return [wrapped];
        }

        const keys = ['results', 'tasks', 'items', 'calltasks'];
        for (const k of keys) {
            if (Array.isArray(response[k])) {
                return response[k];
            }
        }

        if (
            response.id ||
            response.call_task_id ||
            response.calltask_id ||
            response.calltaskId
        ) {
            return [response];
        }
    }
    return [];
}

function inferAnswered(resultPayload) {
    if (resultPayload == null || typeof resultPayload !== 'object') {
        return null;
    }

    if (Array.isArray(resultPayload.goals) && resultPayload.goals.length > 0) {
        const goalLooksSuccessful = resultPayload.goals.some(
            (g) =>
                typeof g?.title === 'string' &&
                /прослушал|ознаком|доставлен|успеш|выполн/i.test(g.title)
        );
        if (goalLooksSuccessful) {
            return true;
        }
    }

    const desc =
        typeof resultPayload.description === 'string'
            ? resultPayload.description.toLowerCase()
            : '';
    if (desc) {
        if (/недоступен|занят|нет ответа|автоответ|не дозвон|сброс|ошибк|отклон/i.test(desc)) {
            return false;
        }
        if (/окончен абонент|прослушал|успеш|дозвон/i.test(desc)) {
            return true;
        }
    }

    if (typeof resultPayload.status === 'number') {
        if (RESULT_STATUS_ANSWERED.has(resultPayload.status)) {
            return true;
        }
        if (RESULT_STATUS_NOT_ANSWERED.has(resultPayload.status)) {
            return false;
        }
    }

    if ('answered' in resultPayload) {
        return Boolean(resultPayload.answered);
    }
    if ('connected' in resultPayload) {
        return Boolean(resultPayload.connected);
    }
    if ('success' in resultPayload) {
        return Boolean(resultPayload.success);
    }
    if (typeof resultPayload.status === 'string') {
        const s = resultPayload.status.toLowerCase();
        if (['completed', 'success', 'answered', 'connected'].includes(s)) {
            return true;
        }
        if (['failed', 'no_answer', 'busy', 'missed'].includes(s)) {
            return false;
        }
    }

    return null;
}

async function createCallstack(payload) {
    return robotmiaRequest('POST', PATH_CALLSTACK, payload);
}

async function getCallstackResult(robotmiaTaskId) {
    return robotmiaRequest('GET', PATH_CALLTASK_RESULT, {
        [RESULT_ID_FIELD]: robotmiaTaskId,
    });
}

module.exports = {
    robotmiaRequest,
    extractCalltaskId,
    extractCreatedIds,
    extractResultEntries,
    inferAnswered,
    createCallstack,
    getCallstackResult,
};
