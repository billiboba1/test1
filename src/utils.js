// src/utils.js
const { randomUUID } = require('crypto');

// ============= ГЕНЕРАЦИЯ UUID =============
function generateUUID() {
    return randomUUID();
}

// ============= ВАЛИДАЦИЯ =============
function validatePhone(phone) {
    const phoneRegex = /^\+7[0-9]{10}$/;
    return phoneRegex.test(phone);
}

function validateDate(date) {
    if (!date) {
        return false;
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return false;
    }

    const parsedDate = new Date(date);
    return !isNaN(parsedDate.getTime());
}

function validateDateTime(datetime) {
    if (!datetime) {
        return false;
    }

    const parsedDate = new Date(datetime);
    return !isNaN(parsedDate.getTime());
}

function validateGender(gender) {
    return ['male', 'female'].includes(gender);
}

function isSlotInPast(slotTime) {
    const now = new Date();
    const slotDate = new Date(slotTime);
    return slotDate < now;
}

/**
 * Проверка UUID формата
 * @param {string} uuid - UUID для проверки
 * @returns {boolean}
 */
function validateUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function validateRequiredFields(data, requiredFields) {
    const missingFields = [];

    for (const field of requiredFields) {
        if (!data[field]) {
            missingFields.push(field);
        }
    }

    return {
        isValid: missingFields.length === 0,
        missingFields
    };
}

// ============= ФОРМАТИРОВАНИЕ ОТВЕТОВ =============
function formatResponse(success, data = null, message = null) {
    const response = { success };

    if (data !== null) {
        response.data = data;
    }

    if (message !== null) {
        response.message = message;
    }

    return response;
}

function formatError(error, statusCode = 400) {
    return {
        success: false,
        error: error,
        statusCode: statusCode
    };
}

// =========าคม ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============
function cleanObject(obj) {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function groupBy(array, key) {
    return array.reduce((result, item) => {
        const groupKey = item[key];
        if (!result[groupKey]) {
            result[groupKey] = [];
        }
        result[groupKey].push(item);

        return result;
    }, {});
}

 function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    generateUUID,
    validatePhone,
    validateDate,
    validateDateTime,
    validateGender,
    isSlotInPast,
    validateUUID,
    validateRequiredFields,
    formatResponse,
    formatError,
    cleanObject,
    groupBy,
    delay
}
