const crypto = require('crypto');

// ============= ГЕНЕРАЦИЯ UUID =============
function generateUUID() {
    return crypto.randomUUID();
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

function validateDateNotInPast(date) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;

    return date >= today;
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

// ========= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============
function cleanObject(obj) {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined && value !== null && value !== '') {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    delay,
    cleanObject,
    formatError,
    formatResponse,
    validateRequiredFields,
    validateUUID,
    isSlotInPast,
    validateGender,
    validateDateTime,
    validateDateNotInPast,
    validateDate,
    validatePhone,
    generateUUID,
}