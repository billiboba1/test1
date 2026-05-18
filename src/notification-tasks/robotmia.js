/**
 * HTTP-клиент к API RobotMIA (модуль notification-tasks): POST /calltask/bulk и POST /calltask/result-bulk.
 *
 * Форматы ответов (зафиксированы под интеграцию):
 * - result-bulk: { data: { "1": { ... }, "2": { ... } } }
 * - calltask/bulk: объект с числовыми ключами "0","1",… (либо тот же вид под полем data)
 *
 * Строка bulk (элемент массива в теле `data`): как в доке RobotMIA —
 * { phone, priority, data: JSON.stringify({ schedule_id, date, time_from, time_to, patient, doctor, … }), min_datetime_to_call?, max_datetime_to_call? }.
 * Окна звонка от времени записи: min = time_from − 2 ч, max = time_from − 1 ч.
 *
 * Окружение:
 * - ROBOTMIA_BASE_URL — база, например https://go.robotmia.ru/api
 * - ROBOTMIA_PROJECT_ID — обязателен для bulk
 * - ROBOTMIA_BODY_API_KEY или ROBOTMIA_API_KEY — api_key в теле запросов bulk
 * - ROBOTMIA_DEFAULT_PRIORITY — приоритет по умолчанию для строки (по умолчанию "3")
 */

require('dotenv').config();

const PATH_CALLTASK_BULK = '/calltask/bulk';

const PATH_CALLTASK_RESULT_BULK = '/calltask/result-bulk';

/** Успешные числовые status в result (дополнять по документации RobotMIA). */
const RESULT_STATUS_ANSWERED = new Set([21, 23]);

/** Коды status: без дозвона / отказ (дополнять по документации). */
const RESULT_STATUS_NOT_ANSWERED = new Set();

/**
 * Возвращает обязательные для тел bulk-запросов поля api_key и project_id из переменных окружения.
 * Бросает ошибку со statusCode 503, если что-то не задано.
 */
function requireRobotMiaBodyAuth() {
    const apiKey = String(
        process.env.ROBOTMIA_BODY_API_KEY || process.env.ROBOTMIA_API_KEY || ''
    ).trim();
    if (!apiKey) {
        const err = new Error(
            'Задайте ROBOTMIA_BODY_API_KEY или ROBOTMIA_API_KEY для api_key в теле RobotMIA'
        );
        err.statusCode = 503;
        throw err;
    }
    const projectId = process.env.ROBOTMIA_PROJECT_ID;
    if (projectId === undefined || projectId === null || String(projectId).trim() === '') {
        const err = new Error('ROBOTMIA_PROJECT_ID обязателен');
        err.statusCode = 503;
        throw err;
    }
    return {
        api_key: apiKey,
        project_id: String(projectId).trim(),
    };
}

/** Склеивает базовый URL API и путь без двойных или пропущенных слэшей. */
function joinUrl(base, path) {
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${b}${p}`;
}

/**
 * HTTP-вызов к RobotMIA: JSON-тело для не-GET.
 * При неуспешном статусе парсит message из JSON или текст ответа и бросает ошибку с statusCode от HTTP.
 */
async function robotmiaRequest(method, path, body) {
    const base = process.env.ROBOTMIA_BASE_URL;

    const upperMethod = String(method).toUpperCase();
    let url = joinUrl(base, path);
    let fetchBody;

    if (upperMethod === 'GET' && body != null) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(body)) {
            if (v) {
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

    const params = {
        method: upperMethod,
        headers,
        body: fetchBody,
    }

    console.log('params', params);

    const res = await fetch(url, params);

    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    if (!res.ok) {
        const err = new Error(
            data?.message != null ? String(data.message) : `RobotMIA HTTP ${res.status}: ${text.slice(0, 500)}`
        );
        err.statusCode = res.status;
        err.responseBody = data;
        throw err;
    }

    return data;
}

/**
 * Идентификатор задания RobotMIA: только call_task_id (на объекте или во вложенном data).
 */
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

    const raw = entry.call_task_id ?? entry.data?.call_task_id ?? null;
    if (raw == null) {
        return null;
    }
    return String(raw);
}

/**
 * Из ответа POST /calltask/bulk: объект с числовыми ключами "0","1",… (при необходимости — обёртка data).
 */
function extractCreatedIds(response) {
    if (response == null) {
        return [];
    }

    const root = response.data != null ? response.data : response;
    const numericKeys = Object.keys(root)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b));

    return numericKeys.map((k) => extractCalltaskId(root[k])).filter(Boolean);
}

/**
 * Ответ POST /calltask/result-bulk: { data: { "1": { ... }, "2": { ... } } } — в массив с call_task_id из ключа.
 */
function extractResultEntries(response) {
    const wrapped = response?.data ?? {};
    return Object.keys(wrapped)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => ({ ...wrapped[key], call_task_id: String(key) }));
}

/**
 * Итог сценария по первому элементу `goals` в payload result-bulk.
 *
 * @param {object} resultPayload — одна запись результата (с полем `goals`).
 * @returns {'confirm'|'refuse'|null} `confirm` — goal id 443; `refuse` — 493 («Пациент не подтвердил запись»); иначе `null`.
 */
function inferAnswered(resultPayload) {
    const CONFIRM_GOAL_ID = 443;
    const REFUSE_GOAL_ID = 493;

    if (!resultPayload.goals) {
        return null;
    }

    if (resultPayload.goals[0].id === CONFIRM_GOAL_ID) {
        return 'confirm';
    }

    if (resultPayload.goals[0].id === REFUSE_GOAL_ID) {
        return 'refuse';
    }

    return null;
}

/** Формат даты-времени для полей data.* RobotMIA (как в примерах доки: YYYY-MM-DD HH:mm:ss), локальное время сервера. */
function formatDatetimeForRobotMia(date) {
    const d = new Date(date);
    
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Преобразует внутренний payload в одну строку массива bulk (как $.post calltask/bulk):
 * phone, priority, data (строка — JSON сценария), min_datetime_to_call / max_datetime_to_call на том же уровне.
 */
function mapPayloadToRobotMiaCallRow(payload) {
    const p = payload || {};
    const phone = String(p.phone ?? '').trim();

    const priority = String(p.priority ?? process.env.ROBOTMIA_DEFAULT_PRIORITY ?? '3');

    const knownTop = new Set([
        'phone',
        'priority',
        // 'min_datetime_to_call',
        // 'max_datetime_to_call',
        'data',
        'api_key',
        'project_id',
    ]);

    let dataStr;
    let minStr;
    let maxStr;

    if (typeof p.data === 'string' && String(p.data).trim() !== '') {
        dataStr = p.data;
    } else {
        const slotStart = new Date(p.time_from);

        const minDt = new Date(slotStart.getTime() - 2 * 60 * 60 * 1000);
        const maxDt = new Date(slotStart.getTime() - 1 * 60 * 60 * 1000);
        minStr = formatDatetimeForRobotMia(minDt);
        maxStr = formatDatetimeForRobotMia(maxDt);

        let innerData;
        if (p.data != null && typeof p.data === 'object') {
            innerData = p.data;
        } else {
            innerData = {};
            for (const [k, v] of Object.entries(p)) {
                if (knownTop.has(k)) {
                    continue;
                }
                innerData[k] = v;
            }
        }

        dataStr = JSON.stringify(innerData);
    }

    const row = {
        phone,
        priority,
        data: dataStr,
    };

    // if (minStr != null && maxStr != null) {
    //    row.min_datetime_to_call = minStr;
    //    row.max_datetime_to_call = maxStr;
    // }

    return row;
}

/** Отправляет массив заданий одним запросом POST /calltask/bulk (поле data — JSON.stringify(rows)). */
async function createCalltaskBulk(payloads = []) {
    const auth = requireRobotMiaBodyAuth();
    const rows = payloads.map(mapPayloadToRobotMiaCallRow);
    const body = {
        ...auth,
        data: JSON.stringify(rows),
    };

    return robotmiaRequest('POST', PATH_CALLTASK_BULK, body);
}

/**
 * POST /calltask/result-bulk: в теле api_key, project_id и call_task_ids.
 */
async function getCalltaskResultBulk(robotmiaTaskIds = []) {
    const ids = robotmiaTaskIds.map((x) => String(x).trim()).filter((x) => x !== '');

    const auth = requireRobotMiaBodyAuth();
    const body = {
        ...auth,
        call_task_ids: ids.map((id) => {
            const n = Number(id);
            return Number.isFinite(n) && String(n) === id ? n : id;
        }),
    };

    return robotmiaRequest('POST', PATH_CALLTASK_RESULT_BULK, body);
}

module.exports = {
    robotmiaRequest,
    extractCalltaskId,
    extractCreatedIds,
    extractResultEntries,
    inferAnswered,
    createCalltaskBulk,
    getCalltaskResultBulk,
};
