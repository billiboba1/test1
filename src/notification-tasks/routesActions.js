const dbController = require('../db');
const indexRoutesActions = require('../index/routesActions');
const robotmia = require('./robotmia');

require('dotenv').config();

function createRequestError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/** Действия по задачам оповещения: collect (Tasks), calltask (RobotMIA + Calls), result-bulk. */
class NotificationTasksRoutesActions extends dbController {
    constructor(params) {
        super(params);
        this._statusIdByName = null;
    }

    async getStatusIdsMap() {
        if (this._statusIdByName) {
            return this._statusIdByName;
        }
        const rows = await this.query('SELECT id, name FROM Statuses');
        const map = {};
        for (const r of rows) {
            map[r.name] = r.id;
        }
        this._statusIdByName = map;
        return map;
    }

    _parseTaskPayload(raw) {
        if (raw == null) {
            return {};
        }
        if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
            return raw;
        }
        if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
            const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
            try {
                return JSON.parse(s);
            } catch {
                return {};
            }
        }
        return {};
    }

    buildRobotPayload(task) {
        const body = this._parseTaskPayload(task.request_payload);
        return { ...body, phone: task.phone };
    }

    /**
     * Занятые слоты (is_free = false) с пациентом в окне [сейчас, сейчас + 24 ч),
     * для которых ещё нет задачи с тем же schedule_id. Создаёт Tasks с patient/doctor в request_payload.
     */
    async collectTasksFromSchedulesForNotification() {
        const statusMap = await this.getStatusIdsMap();
        const statusId = statusMap.ready_for_call ?? statusMap.new;
        if (!statusId) {
            throw createRequestError('В справочнике статусов нет ready_for_call или new', 500);
        }

        const slots = await this.query(
            `SELECT s.id AS schedule_id, s.date, s.time_from, s.time_to,
                    s.patient_id, s.doctor_id, p.phone,
                    p.name AS patient_name, p.surname AS patient_surname, p.patronymic AS patient_patronymic,
                    d.name AS doctor_name, d.surname AS doctor_surname, d.patronymic AS doctor_patronymic
             FROM Schedule s
             INNER JOIN Patients p ON p.id = s.patient_id
             INNER JOIN Doctors d ON d.id = s.doctor_id
             WHERE s.is_free = FALSE
               AND s.patient_id IS NOT NULL
               AND s.time_from >= NOW()
               AND s.time_from < DATE_ADD(NOW(), INTERVAL 24 HOUR)
               AND NOT EXISTS (
                   SELECT 1 FROM Tasks t WHERE t.schedule_id = s.id
               )`
        );

        console.log('slots: ', slots);

        const tasks = [];
        for (const row of slots) {
            const requestPayload = {
                schedule_id: row.schedule_id,
                date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
                time_from:
                    row.time_from instanceof Date ? row.time_from.toISOString() : String(row.time_from),
                time_to: row.time_to instanceof Date ? row.time_to.toISOString() : String(row.time_to),
                patient: {
                    id: row.patient_id,
                    name: row.patient_name,
                    surname: row.patient_surname,
                    patronymic: row.patient_patronymic ? String(row.patient_patronymic) : '',
                },
                doctor: {
                    id: row.doctor_id,
                    name: row.doctor_name,
                    surname: row.doctor_surname,
                    patronymic: row.doctor_patronymic ? String(row.doctor_patronymic) : '',
                },
            };

            const header = await this.executeCommand(
                `INSERT INTO Tasks (schedule_id, phone, request_payload, dial_count, status_id)
                 VALUES (?, ?, ?, 0, ?)`,
                [row.schedule_id, String(row.phone).trim(), JSON.stringify(requestPayload), statusId]
            );
            tasks.push({ id: header.insertId, schedule_id: row.schedule_id });
        }

        console.log('collectTasksFromSchedulesForNotification result: ', { slots_found: slots.length, tasks_created: tasks.length, tasks });

        return { slots_found: slots.length, tasks_created: tasks.length, tasks };
    }

    /**
     * Готовые Tasks → POST /calltask/bulk и INSERT в Calls + обновление статуса задачи (in_progress).
     */
    async runNotificationCalltask() {
        return await this.dispatchTasksToRobotMia();
    }

    async getTasksReadyForRobotMia() {
        const sql = `
            SELECT t.id, t.phone, t.request_payload, t.dial_count, s.name AS status_name
            FROM Tasks t
            INNER JOIN Statuses s ON s.id = t.status_id
            WHERE t.dial_count < 3
              AND s.name NOT IN ('in_progress', 'completed')
              AND NOT EXISTS (
                  SELECT 1 FROM Calls c
                  WHERE c.task_id = t.id AND c.status = 'in_progress'
              )
            ORDER BY t.id
        `;

        return await this.query(sql);
    }

    async recordDispatchForTask(task, robotmiaTaskId) {
        const statusMap = await this.getStatusIdsMap();
        const inProgressId = statusMap.in_progress;
        
        if (!inProgressId) {
            throw createRequestError('В справочнике нет статуса in_progress', 500);
        }

        return await this.transaction(async (connection) => {
            await connection.execute(
                `INSERT INTO Calls (robotmia_task_id, task_id, phone, status)
                 VALUES (?, ?, ?, 'in_progress')`,
                [robotmiaTaskId, task.id, task.phone]
            );
            await connection.execute(
                `UPDATE Tasks SET status_id = ?, dial_count = dial_count + 1 WHERE id = ?`,
                [inProgressId, task.id]
            );
        });
    }

    async dispatchTasksToRobotMia() {
        const tasks = await this.getTasksReadyForRobotMia();

        console.log('tasks: ', tasks);

        if (!tasks.length) {
            return { selected: 0, submitted: 0, mode: 'none', errors: [] };
        }

        const errors = [];
        let submitted = 0;
        const payloads = tasks.map((t) => this.buildRobotPayload(t));

        console.log('payload: ', payloads);

        let resp;
        try {
            resp = await robotmia.createCalltaskBulk(payloads);
        } catch (e) {
            errors.push({ phase: 'calltask/bulk', message: e.message });
            return {
                selected: tasks.length,
                submitted: 0,
                mode: 'bulk',
                errors,
            };
        }

        const idList = robotmia.extractCreatedIds(resp);
        if (idList.length !== tasks.length) {
            errors.push({
                phase: 'calltask/bulk',
                message: `Ожидалось ${tasks.length} идентификаторов в ответе, получено ${idList.length}. Записи в БД не созданы.`,
            });
            return {
                selected: tasks.length,
                submitted: 0,
                mode: 'bulk',
                errors,
            };
        }

        for (let i = 0; i < tasks.length; i++) {
            try {
                await this.recordDispatchForTask(tasks[i], String(idList[i]));
                submitted++;
            } catch (e) {
                errors.push({ task_id: tasks[i].id, message: e.message });
            }
        }

        return {
            selected: tasks.length,
            submitted,
            mode: 'bulk',
            errors,
        };
    }

    /**
     * Собирает id активных звонков, запрашивает result-bulk; при наличии данных по id обновляет Calls (и Tasks).
     * Возвращает только число успешно обновлённых звонков: { updated }.
     */
    async syncResultsFromRobotMia() {
        const rows = await this.query(
            `SELECT c.robotmia_task_id, c.task_id, c.phone, t.dial_count AS task_dial_count, t.schedule_id
             FROM Calls c
             INNER JOIN Tasks t ON t.id = c.task_id
             WHERE c.status = 'in_progress'
             ORDER BY c.robotmia_task_id`
        );

        console.log('rows', rows);

        if (!rows.length) {
            return { updated: 0 };
        }

        const statusMap = await this.getStatusIdsMap();
        const idNew = statusMap['new'];
        const idCompleted = statusMap['completed'];
        if (!idNew || !idCompleted) {
            throw createRequestError('В справочнике нет статусов new или completed', 500);
        }

        let updated = 0;

        const ids = rows.map((r) => r.robotmia_task_id);

        console.log('ids', ids);

        let resp;
        try {
            resp = await robotmia.getCalltaskResultBulk(ids);

            console.log('resp', resp);
        } catch (e) {
            console.error('[syncResultsFromRobotMia] calltask/result-bulk:', e.message);
            return { updated: 0 };
        }

        const entries = robotmia.extractResultEntries(resp);
        const byId = new Map();
        for (const e of entries) {
            const rid = robotmia.extractCalltaskId(e);
            if (rid) {
                byId.set(String(rid), e);
            }
        }

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let entry = byId.get(String(row.robotmia_task_id));
            if (entry == null && entries.length === rows.length) {
                entry = entries[i];
            }

            console.log('entry: ', entry);

            if (entry == null) {
                continue;
            }

            if (entry.errors) {
                continue;
            }

            const goalStatus = robotmia.inferAnswered(entry);
            
            const dial = Number(row.task_dial_count) || 0;
            const nextStatusId = (!goalStatus && dial < 3) ? idNew : idCompleted;

            try {
                await this.transaction(async (connection) => {
                    await connection.execute(
                        `UPDATE Calls SET status = 'finished', result_json = ?
                         WHERE robotmia_task_id = ? AND status = 'in_progress'`,
                        [JSON.stringify(entry), row.robotmia_task_id]
                    );
                    await connection.execute(`UPDATE Tasks SET status_id = ? WHERE id = ?`, [
                        nextStatusId,
                        row.task_id,
                    ]);
                    if (goalStatus === 'refuse' && row.schedule_id) {
                        await indexRoutesActions.denyAppointment(row.schedule_id);
                    }
                });

                updated++;
            } catch (e) {
                console.error(
                    '[syncResultsFromRobotMia] update',
                    row.robotmia_task_id,
                    e.message
                );
            }
        }

        return { updated };
    }
}

module.exports = new NotificationTasksRoutesActions(process.env);
