const dbController = require('./db')
require('dotenv').config();

const {
    validatePhone,
    validateDate,
    validateGender,
    isSlotInPast
} = require('./utils');

class routesActions extends dbController {
    constructor(params = {}) {
        super(params);
    }

    // Убираем static и extends - используем композицию
    static async patientIsExistsByPhone(phone) {
        const result = await this.query('SELECT * FROM Patients WHERE phone = ?', [phone]);
        return result;
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
                s.time_from,
                s.time_to,
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
            params.push(time_to);
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
        console.log("sql:", sql)
        console.log("params:", params)
        
        const result = await this.query(sql, params);
        return result;
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
            `SELECT * FROM Schedule WHERE id = ? AND doctor_id = ? FOR UPDATE`,
            [scheduleId, doctorId]
        );
        return result;
    }

    async reserveSchedule(connection, patientId, scheduleId) {
        await connection.execute(
            `UPDATE Schedule SET is_free = FALSE, patient_id = ?, type = 0 WHERE id = ?`,
            [patientId, scheduleId]
        );
        return true;
    }
}

module.exports = new routesActions(process.env);