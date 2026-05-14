const dbController = require('./db');
const robotmia = require('./robotmia');

const {
    validatePhone,
    validateDate,
    validateGender,
    validateRequiredFields,
    validateUUID,
    isSlotInPast
} = require('./utils');

require('dotenv').config();

function createRequestError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

class routesActions extends dbController {
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

    async createNotificationTasks(items, initialStatusName = 'new') {
        if (!Array.isArray(items) || items.length === 0) {
            throw createRequestError('Ожидается непустой массив tasks', 400);
        }

        const statusMap = await this.getStatusIdsMap();
        const statusId = statusMap[initialStatusName] ?? statusMap['new'];
        if (!statusId) {
            throw createRequestError('В справочнике статусов нет подходящей записи', 500);
        }

        const created = [];
        for (const item of items) {
            const validation = validateRequiredFields(item, ['phone', 'request_payload']);
            if (!validation.isValid) {
                throw createRequestError(
                    `Задача без полей: ${validation.missingFields.join(', ')}`,
                    400
                );
            }
            const { phone, request_payload } = item;
            if (typeof request_payload !== 'object' || request_payload === null || Array.isArray(request_payload)) {
                throw createRequestError('Поле request_payload должно быть объектом JSON', 400);
            }

            const header = await this.executeCommand(
                `INSERT INTO Tasks (phone, request_payload, dial_count, status_id)
                 VALUES (?, ?, 0, ?)`,
                [String(phone).trim(), JSON.stringify(request_payload), statusId]
            );
            created.push({ id: header.insertId, phone: String(phone).trim() });
        }

        return { created_count: created.length, tasks: created };
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
        if (!tasks.length) {
            return { selected: 0, submitted: 0, mode: 'none', errors: [] };
        }

        const errors = [];
        let submitted = 0;

        const settled = await Promise.allSettled(
            tasks.map((task) =>
                robotmia
                    .createCallstack(this.buildRobotPayload(task))
                    .then((resp) => ({ task, resp }))
            )
        );

        for (let i = 0; i < settled.length; i++) {
            const task = tasks[i];
            const r = settled[i];

            if (r.status === 'rejected') {
                const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
                errors.push({ task_id: task.id, message: msg });
                continue;
            }

            const { resp } = r.value;
            const ids = robotmia.extractCreatedIds(resp, 1);
            const rid = ids[0] ?? robotmia.extractCalltaskId(resp);
            if (!rid) {
                errors.push({
                    task_id: task.id,
                    message: 'В ответе RobotMIA нет идентификатора задачи',
                });
                continue;
            }

            try {
                await this.recordDispatchForTask(task, String(rid));
                submitted++;
            } catch (e) {
                errors.push({ task_id: task.id, message: e.message });
            }
        }

        return {
            selected: tasks.length,
            submitted,
            mode: 'parallel',
            errors,
        };
    }

    async syncResultsFromRobotMia() {
        const rows = await this.query(
            `SELECT c.robotmia_task_id, c.task_id, c.phone, t.dial_count AS task_dial_count
             FROM Calls c
             INNER JOIN Tasks t ON t.id = c.task_id
             WHERE c.status = 'in_progress'
             ORDER BY c.robotmia_task_id`
        );

        if (!rows.length) {
            return { checked: 0, updated: 0, skipped: 0, errors: [] };
        }

        const statusMap = await this.getStatusIdsMap();
        const idNew = statusMap['new'];
        const idCompleted = statusMap['completed'];
        if (!idNew || !idCompleted) {
            throw createRequestError('В справочнике нет статусов new или completed', 500);
        }

        const errors = [];
        let updated = 0;
        let skipped = 0;

        const settled = await Promise.allSettled(
            rows.map((row) => robotmia.getCallstackResult(row.robotmia_task_id))
        );

        for (let i = 0; i < settled.length; i++) {
            const row = rows[i];
            const r = settled[i];

            if (r.status === 'rejected') {
                const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
                errors.push({ robotmia_task_id: row.robotmia_task_id, message: msg });
                continue;
            }

            const resp = r.value;
            const entries = robotmia.extractResultEntries(resp);
            const entry =
                entries.find(
                    (x) =>
                        String(robotmia.extractCalltaskId(x)) === String(row.robotmia_task_id)
                ) ?? entries[0];

            if (entry == null) {
                skipped++;
                continue;
            }

            const answered = robotmia.inferAnswered(entry);
            const reached = answered === true;

            let nextStatusId;
            if (reached) {
                nextStatusId = idCompleted;
            } else {
                const dial = Number(row.task_dial_count) || 0;
                nextStatusId = dial < 3 ? idNew : idCompleted;
            }

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
                });
                updated++;
            } catch (e) {
                errors.push({ robotmia_task_id: row.robotmia_task_id, message: e.message });
            }
        }

        return {
            checked: rows.length,
            updated,
            skipped,
            errors,
        };
    }

    async patientIsExistsByPhone(phone) {
        const result = await this.query('SELECT * FROM Patients WHERE phone = ?', [phone]);
        return result;
    }

    async getPatientByPhone(phone) {
        const result = await this.query('SELECT id FROM Patients WHERE phone = ? LIMIT 1', [phone]);
        return result.length ? result[0].id : null;
    }

    async getDoctor(filters) {
        const allowed = ['name', 'surname', 'patronymic', 'spec'];
        const conditions = [];
        const params = [];

        for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(filters, key)) {
                continue;
            }
            const raw = filters[key];
            if (raw === undefined || raw === null) {
                continue;
            }
            const value = String(raw).trim();
            if (value === '') {
                continue;
            }
            conditions.push(`${key} = ?`);
            params.push(value);
        }

        if (conditions.length === 0) {
            return null;
        }

        const whereSql = conditions.join(' AND ');
        const result = await this.query(
            `SELECT id FROM Doctors WHERE ${whereSql} LIMIT 1`,
            params
        );

        return result.length ? result[0].id : null;
    }

    async createPatient(id, phone, name, surname, patronymic, gender) {
        await this.query(
            `INSERT INTO Patients (id, phone, name, surname, patronymic, gender)
             VALUES (?, ?, ?, ?, ?, ?)`, 
            [id, phone, name, surname, patronymic, gender]
        );
        return await this.getPatient(id);
    }

    async getPatient(id) {
        const result = await this.query('SELECT * FROM Patients WHERE id = ?', [id]);
        return result[0];
    }

    async getSchedule(filters = {}) {
        const { 
            date, 
            time_from, 
            time_to, 
            is_free, 
            doctor_id, 
            patient_id 
        } = filters;
        
        let sql = `
            SELECT 
                s.id,
                s.doctor_id,
                s.date,
                DATE_FORMAT(s.time_from, '%H:%i') as time_from,
                DATE_FORMAT(s.time_to, '%H:%i') as time_to,
                s.is_free,
                s.patient_id,
                s.type,
                d.name as doctor_name,
                d.surname as doctor_surname,
                d.patronymic as doctor_patronymic,
                d.spec as doctor_spec,
                d.price as doctor_price,
                p.name as patient_name,
                p.surname as patient_surname
            FROM Schedule s
            LEFT JOIN Doctors d ON s.doctor_id = d.id
            LEFT JOIN Patients p ON s.patient_id = p.id
            WHERE s.date = ?
        `;
        
        const params = [];
        
        params.push(date);
        
        if (time_from) {
            sql += ` AND s.time_from >= ?`;
            const timeFrom = new Date(`${date}T${time_from}`);
            params.push(timeFrom.toISOString());
        }

        if (time_to) {
            sql += ` AND s.time_to <= ?`;
            const timeTo = new Date(`${date}T${time_to}`);
            params.push(timeTo.toISOString());
        }
        
        if (is_free !== undefined && is_free !== null) {
            const isFreeBoolean = is_free === 'true' || is_free === '1' || is_free === true;
            sql += ` AND s.is_free = ?`;
            params.push(isFreeBoolean);
        }
        
        if (doctor_id) {
            sql += ` AND s.doctor_id = ?`;
            params.push(doctor_id);
        }
        
        if (patient_id) {
            sql += ` AND s.patient_id = ?`;
            params.push(patient_id);
        }
        
        sql += ` ORDER BY s.doctor_id, s.time_from`;
        
        const result = await this.query(sql, params);
        const prettierResult = result.map((item) => {
            return {
                id: item.id,
                doctor_id: item.doctor_id,
                date: item.date,
                time_from: item.time_from,
                time_to: item.time_to,
                is_free: item.is_free,
                patient_id: item.patient_id,
                type: item.type,
                doctor: {
                    name: item.doctor_name,
                    surname: item.doctor_surname,
                    patronymic: item.doctor_patronymic,
                    spec: item.doctor_spec,
                    price: item.doctor_price,
                },
                patient: { 
                    name: item.patient_name,
                    surname: item.patient_surname,
                },
            };
        });
        
        return prettierResult;
    }

    async getScheduleId(doctorId, date, timeFrom) {
        const normalizedTimeFrom = timeFrom.length === 5 ? timeFrom : timeFrom.slice(0, 5);
        const result = await this.query(
            `
            SELECT id
            FROM Schedule
            WHERE doctor_id = ?
            AND date = ?
            AND DATE_FORMAT(time_from, '%H:%i') = ?
            LIMIT 1
            `,
            [doctorId, date, normalizedTimeFrom]
        );

        return result.length ? result[0].id : null;
    }

    async createAppointment(patient_id, doctor_id, schedule_id) {
        const validation = validateRequiredFields(
            { patient_id, doctor_id, schedule_id },
            ['patient_id', 'doctor_id', 'schedule_id']
        );

        if (!validation.isValid) {
            throw createRequestError(`Обязательные поля: ${validation.missingFields.join(', ')}`, 400);
        }

        if (!validateUUID(patient_id)) {
            throw createRequestError('Неверный формат ID пациента', 400);
        }

        if (!validateUUID(doctor_id)) {
            throw createRequestError('Неверный формат ID врача', 400);
        }

        if (!validateUUID(schedule_id)) {
            throw createRequestError('Неверный формат ID слота', 400);
        }

        return await this.transaction(async (connection) => {
            const patient = await this.patientIdIsExists(patient_id);
            if (!patient) {
                throw createRequestError('Пациент не найден', 404);
            }

            const doctor = await this.doctorIdIsExists(doctor_id);
            if (!doctor) {
                throw createRequestError('Врач не найден', 404);
            }

            const isRepeat = await this.hasPreviousAppointment(
                connection,
                patient_id,
                doctor_id,
            );

            const appointmentType = isRepeat ? 1 : 0;

            const avaliableSchedules = await this.scheduleIsEnable(connection, schedule_id, doctor_id);
            if (!avaliableSchedules.length) {
                throw createRequestError('Слот уже занят', 409);
            }

            await this.reserveSchedule(
                connection,
                patient_id,
                schedule_id,
                appointmentType,
            );

            return { schedule_id, patient_id, doctor_id };
        });
    }

    async createAppointmentByTime(patient_id, doctor_id, date, time_from) {
        const schedule_id = await this.getScheduleId(doctor_id, date, time_from);
        if (!schedule_id) {
            throw createRequestError('Слот не найден', 404);
        }

        return await this.createAppointment(patient_id, doctor_id, schedule_id);
    }

    async patientIdIsExists(patientId) {
        const result = await this.query('SELECT id FROM Patients WHERE id = ?', [patientId]);
        return result.length ? result[0] : null;
    }

    async doctorIdIsExists(doctorId) {
        const result = await this.query('SELECT id FROM Doctors WHERE id = ?', [doctorId]);
        return result.length ? result[0] : null;
    }

    async scheduleIsEnable(connection, scheduleId, doctorId) {
        const [result] = await connection.execute(
            `SELECT * FROM Schedule WHERE id = ? AND doctor_id = ? AND is_free = true FOR UPDATE`,
            [scheduleId, doctorId]
        );

        return result;
    }

    async reserveSchedule(connection, patientId, scheduleId, appointmentType) {
        await connection.execute(
            `UPDATE Schedule SET is_free = FALSE, patient_id = ?, type = ? WHERE id = ?`,
            [patientId, appointmentType, scheduleId]
        );

        return true;
    }

    async hasPreviousAppointment(connection, patientId, doctorId) {
        const [rows] = await connection.execute(
            `
            SELECT 1
            FROM Schedule
            WHERE patient_id = ?
            AND doctor_id = ?
            AND is_free = FALSE
            LIMIT 1
            `,
            [patientId, doctorId]
        );

        return rows.length;
    }
}

module.exports = new routesActions(process.env);
