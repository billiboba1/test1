// routes.js
const express = require('express');
const db = require('./db');
const routesActions = require('./routesActions');
const {
    generateUUID,
    validateRequiredFields,
    validateDate,
    validateUUID,
    formatResponse,
    formatError
} = require('./utils');

const router = express.Router();

// ============= 1. РЕГИСТРАЦИЯ ПАЦИЕНТА =============
router.post('/patients', async (req, res) => {
    try {
        const { name, surname, patronymic, phone, gender } = req.body;
        
        // Проверка обязательных полей
        const validation = validateRequiredFields(
            { name, surname, phone },
            ['name', 'surname', 'phone']
        );
        
        if (!validation.isValid) {
            return res.status(400).json(
                formatError(`Обязательные поля: ${validation.missingFields.join(', ')}`)
            );
        }
        
        // Проверка существующего пациента
        const existingPatient = await routesActions.patientIsExistsByPhone(phone);
        
        if (existingPatient.length > 0) {
            return res.status(409).json(
                formatError('Пациент с таким телефоном уже существует')
            );
        }
        
        // Создание пациента (генерируем UUID через утилиту)
        const id = generateUUID();
        const newPatient = await routesActions.createPatient(
            id, phone, name, surname, patronymic || null, gender || null
        );
        
        res.status(201).json(
            formatResponse(true, newPatient, 'Пациент успешно зарегистрирован')
        );
        
    } catch (error) {
        console.error('Ошибка регистрации пациента:', error);
        
        // Обработка специфичных ошибок валидации
        if (error.message.includes('телефона') || error.message.includes('gender')) {
            return res.status(400).json(formatError(error.message));
        }
        
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

// ============= 2. ПОЛУЧЕНИЕ РАСПИСАНИЯ =============
router.get('/schedule', async (req, res) => {
    try {
        const { date, time_from, time_to, is_free, doctor_id, patient_id } = req.query;
        
        // Проверка обязательного параметра
        if (!date) {
            return res.status(400).json(
                formatError('Параметр "date" обязателен')
            );
        }
        
        // Валидация даты через утилиту
        if (!validateDate(date)) {
            return res.status(400).json(
                formatError('Неверный формат даты. Используйте YYYY-MM-DD')
            );
        }
        
        // Валидация UUID если переданы
        if (doctor_id && !validateUUID(doctor_id)) {
            return res.status(400).json(
                formatError('Неверный формат ID врача')
            );
        }
        
        if (patient_id && !validateUUID(patient_id)) {
            return res.status(400).json(
                formatError('Неверный формат ID пациента')
            );
        }
        
        const slots = await routesActions.getSchedule({
            date,
            time_from,
            time_to,
            is_free,
            doctor_id,
            patient_id
        });
        
        res.json(formatResponse(true, slots));
        
    } catch (error) {
        console.error('Ошибка получения расписания:', error);
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

// ============= 3. ЗАПИСЬ НА ПРИЁМ =============
router.post('/appointments', async (req, res) => {
    try {
        const { patient_id, doctor_id, schedule_id } = req.body;
        
        // Проверка обязательных полей
        const validation = validateRequiredFields(
            { patient_id, doctor_id, schedule_id },
            ['patient_id', 'doctor_id', 'schedule_id']
        );
        
        if (!validation.isValid) {
            return res.status(400).json(
                formatError(`Обязательные поля: ${validation.missingFields.join(', ')}`)
            );
        }
        
        // Валидация UUID через утилиту
        if (!validateUUID(patient_id)) {
            return res.status(400).json(formatError('Неверный формат ID пациента'));
        }
        
        if (!validateUUID(doctor_id)) {
            return res.status(400).json(formatError('Неверный формат ID врача'));
        }
        
        if (!validateUUID(schedule_id)) {
            return res.status(400).json(formatError('Неверный формат ID слота'));
        }
        
        const result = await db.transaction(async (connection) => {
            // Проверяем пациента
            const patient = await routesActions.patientIdIsExists(patient_id);
            if (!patient) {
                throw new Error('Пациент не найден');
            }
            
            // Проверяем врача
            const doctor = await routesActions.doctorIdIsExists(doctor_id);
            if (!doctor) {
                throw new Error('Врач не найден');
            }
            
            // Проверяем и блокируем слот
            await routesActions.scheduleIsEnable(connection, schedule_id, doctor_id);
            
            // Бронируем слот
            await routesActions.reserveSchedule(connection, patient_id, schedule_id);
            
            return { schedule_id, patient_id, doctor_id };
        });
        
        res.status(201).json(
            formatResponse(true, result, 'Запись на приём успешно создана')
        );
        
    } catch (error) {
        console.error('Ошибка записи на приём:', error);
        
        const errorMap = {
            'Пациент не найден': 404,
            'Врач не найден': 404,
            'Слот не найден': 404,
            'Слот уже занят': 409,
            'Нельзя записаться на прошедший слот': 400
        };
        
        const statusCode = errorMap[error.message] || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

module.exports = router;