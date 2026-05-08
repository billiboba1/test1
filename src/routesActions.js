const dbController = require('./db');

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
    }

    async patientIsExistsByPhone(phone) {
        const result = await this.query('SELECT * FROM Patients WHERE phone = ?', [phone]);
        return result;
    }

    async getPatientByPhone(phone) {
        const result = await this.query('SELECT id FROM Patients WHERE phone = ? LIMIT 1', [phone]);
        return result.length ? result[0].id : null;
    }

    async getDoctor(name, surname, patronymic, spec) {
        const result = await this.query(
            `
            SELECT id
            FROM Doctors
            WHERE name = ?
            AND surname = ?
            AND patronymic = ?
            AND spec = ?
            LIMIT 1
            `,
            [name, surname, patronymic, spec]
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

            // const timeTo = new Date(`${date}T${time_from}`);
            
            const timeFrom = new Date(`${date}T${time_from}`);
            params.push(timeFrom.toISOString());
        }
        
        if (time_to) {
            sql += ` AND s.time_to <= ?`;
            params.push(time_to);

            // const timeTo = new Date(`${date}T${time_from}`);
            
            const timeTo = new Date(`${date}T${time_from}`);
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
