// routes.js
const express = require('express');
const routesActions = require('./routesActions');
const {
    generateUUID,
    validateRequiredFields,
    validateDate,
    validateDateNotInPast,
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

        if (!validateDateNotInPast(date)) {
            return res.status(400).json(
                formatError('Дата не может быть раньше сегодняшней')
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
        const result = await routesActions.createAppointment(patient_id, doctor_id, schedule_id);
        
        res.status(201).json(
            formatResponse(true, result, 'Запись на приём успешно создана')
        );
        
    } catch (error) {
        console.error('Ошибка записи на приём:', error);

        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

router.post('/appointments/by-time', async (req, res) => {
    try {
        const { patient_id, doctor_id, date, time_from } = req.body;

        if (!validateDate(date)) {
            return res.status(400).json(
                formatError('Неверный формат даты. Используйте YYYY-MM-DD')
            );
        }

        if (!/^\d{2}:\d{2}$/.test(time_from)) {
            return res.status(400).json(
                formatError('Неверный формат времени. Используйте HH:mm')
            );
        }

        const result = await routesActions.createAppointmentByTime(patient_id, doctor_id, date, time_from);

        res.status(201).json(
            formatResponse(true, result, 'Запись на приём успешно создана')
        );
    } catch (error) {
        console.error('Ошибка записи на приём по времени:', error);

        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

router.get('/ping', (req, res) => {
    res.json({ ping: 'pong' });
})

// проверка на существование клиента по номеру телефона
router.get('/client-exists', async (req, res) => {
    const { phone } = req.query;

    try {
        const clientsInfo = await routesActions.patientIsExistsByPhone(phone);
    } catch (e) {
        console.log('src/routes.js:213', e);
    }

    res.json({ client_exists: clientsInfo });
});

router.get('/get-doctor', async (req, res) => {
    try {
        const { name, surname, patronymic, spec } = req.query;

        const validation = validateRequiredFields(
            { name, surname, patronymic, spec },
            ['name', 'surname', 'patronymic', 'spec']
        );

        if (!validation.isValid) {
            return res.status(400).json(
                formatError(`Обязательные поля: ${validation.missingFields.join(', ')}`)
            );
        }

        const doctorId = await routesActions.getDoctor(name, surname, patronymic, spec);

        if (!doctorId) {
            return res.status(404).json(formatError('Врач не найден', 404));
        }

        res.json(formatResponse(true, { doctorId }));
    } catch (error) {
        console.error('Ошибка получения врача:', error);
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

router.get('/get-patient', async (req, res) => {
    try {
        const { phone } = req.query;

        const validation = validateRequiredFields({ phone }, ['phone']);

        if (!validation.isValid) {
            return res.status(400).json(
                formatError(`Обязательные поля: ${validation.missingFields.join(', ')}`)
            );
        }

        const patientId = await routesActions.getPatientByPhone(phone);

        if (!patientId) {
            return res.status(404).json(formatError('Пациент не найден', 404));
        }

        res.json(formatResponse(true, { patientId }));
    } catch (error) {
        console.error('Ошибка получения пациента:', error);
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

module.exports = router;
