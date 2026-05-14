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

function requireNotificationSecret(req, res, next) {
    const secret = process.env.NOTIFICATION_INTERNAL_SECRET;
    if (!secret) {
        return next();
    }
    if (req.get('X-Internal-Secret') !== secret) {
        return res.status(401).json(formatError('Неверный или отсутствует заголовок X-Internal-Secret', 401));
    }
    return next();
}

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
    try {
        const { phone } = req.query;

        const validation = validateRequiredFields({ phone }, ['phone']);
        if (!validation.isValid) {
            return res.status(400).json(
                formatError(`Обязательные поля: ${validation.missingFields.join(', ')}`)
            );
        }

        const rows = await routesActions.patientIsExistsByPhone(phone);
        res.json(formatResponse(true, { client_exists: rows.length > 0 }));
    } catch (error) {
        console.error('Ошибка проверки клиента:', error);
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

router.get('/get-doctor', async (req, res) => {
    try {
        const filters = {};
        for (const key of ['name', 'surname', 'patronymic', 'spec']) {
            const v = req.query[key];
            if (v === undefined || v === null || v === '') {
                continue;
            }
            const trimmed = String(v).trim();
            if (trimmed !== '') {
                filters[key] = trimmed;
            }
        }

        if (Object.keys(filters).length === 0) {
            return res.status(400).json(
                formatError(
                    'Укажите хотя бы один непустой параметр: name, surname, patronymic, spec'
                )
            );
        }

        const doctorId = await routesActions.getDoctor(filters);

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

// ============= Задачи на оповещение (RobotMIA) =============
router.post('/notification-tasks/batch', requireNotificationSecret, async (req, res) => {
    try {
        const { tasks: taskList, initial_status } = req.body;
        if (!Array.isArray(taskList)) {
            return res.status(400).json(formatError('Ожидается массив body.tasks', 400));
        }
        const result = await routesActions.createNotificationTasks(
            taskList,
            initial_status || 'new'
        );
        res.status(201).json(formatResponse(true, result, 'Задачи сохранены'));
    } catch (error) {
        console.error('notification-tasks/batch:', error);
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

router.get('/notification-tasks/ready-for-dispatch', requireNotificationSecret, async (req, res) => {
    try {
        const rows = await routesActions.getTasksReadyForRobotMia();
        res.json(formatResponse(true, { count: rows.length, tasks: rows }));
    } catch (error) {
        console.error('notification-tasks/ready-for-dispatch:', error);
        res.status(500).json(formatError('Внутренняя ошибка сервера', 500));
    }
});

router.post('/notification-tasks/dispatch-robotmia', requireNotificationSecret, async (req, res) => {
    try {
        const result = await routesActions.dispatchTasksToRobotMia();
        res.json(formatResponse(true, result));
    } catch (error) {
        console.error('notification-tasks/dispatch-robotmia:', error);
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

router.post('/notification-tasks/sync-results', requireNotificationSecret, async (req, res) => {
    try {
        const result = await routesActions.syncResultsFromRobotMia();
        res.json(formatResponse(true, result));
    } catch (error) {
        console.error('notification-tasks/sync-results:', error);
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(formatError(error.message, statusCode));
    }
});

module.exports = router;
