CREATE DATABASE IF NOT EXISTS test_schema_a_shadrin_1;
USE test_schema_a_shadrin_1;

-- patients table
CREATE TABLE IF NOT EXISTS Patients (
    id VARCHAR(36) PRIMARY KEY,
    phone VARCHAR(15) NOT NULL UNIQUE,
    name VARCHAR(50) NOT NULL,
    surname VARCHAR(50) NOT NULL,
    patronymic VARCHAR(50),
    gender ENUM('male', 'female'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Doctors (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    surname VARCHAR(50) NOT NULL,
    patronymic VARCHAR(50),
    spec VARCHAR(30) NOT NULL,
    price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS Schedule (
    id VARCHAR(36) PRIMARY KEY,
    doctor_id VARCHAR(36),
    date DATE NOT NULL,
    time_from DATETIME NOT NULL,
    time_to DATETIME NOT NULL,
    is_free BOOLEAN DEFAULT TRUE,
    patient_id VARCHAR(36),
    type INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doctor_id) REFERENCES Doctors(id) ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES Patients(id) ON DELETE SET NULL,
    INDEX idx_doctor_date (doctor_id, date),
    INDEX idx_free_slots (is_free, date),
    UNIQUE KEY unique_slot (doctor_id, time_from)
);

-- Статусы задач для оповещения (справочник)
CREATE TABLE IF NOT EXISTS Statuses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    UNIQUE KEY uq_Statuses_name (name)
);

INSERT IGNORE INTO Statuses (name) VALUES
    ('new'),
    ('ready_for_call'),
    ('in_progress'),
    ('completed');

-- Задачи для оповещения
CREATE TABLE IF NOT EXISTS Tasks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    request_payload JSON NOT NULL COMMENT 'Данные для запроса в API',
    dial_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Количество дозвонов',
    status_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_Tasks_Status FOREIGN KEY (status_id) REFERENCES Statuses (id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    INDEX idx_Tasks_phone (phone),
    INDEX idx_Tasks_status (status_id)
);

-- Звонки (ROBOTMIA)
CREATE TABLE IF NOT EXISTS Calls (
    robotmia_task_id VARCHAR(128) NOT NULL PRIMARY KEY COMMENT 'Идентификатор из API ROBOTMIA',
    task_id INT UNSIGNED NOT NULL,
    phone VARCHAR(20) NOT NULL,
    status ENUM('in_progress', 'finished') NOT NULL DEFAULT 'in_progress',
    result_json JSON NULL COMMENT 'Данные по результату звонка',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_Calls_Task FOREIGN KEY (task_id) REFERENCES Tasks (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    INDEX idx_Calls_task (task_id),
    INDEX idx_Calls_phone (phone),
    INDEX idx_Calls_status (status)
);

-- Добавляем тестовых врачей
INSERT INTO Doctors (id, name, surname, patronymic, spec, price) VALUES
(UUID(), 'Сергей', 'Иванов', 'Романович', 'Терапевт', 2500.00),
(UUID(), 'Анна', 'Петрова', 'Сергеевна', 'Кардиолог', 3500.00),
(UUID(), 'Михаил', 'Сидоров', 'Александрович', 'Хирург', 5000.00),
(UUID(), 'Елена', 'Козлова', 'Андреевна', 'Невролог', 3000.00),
(UUID(), 'Дмитрий', 'Соколов', 'Викторович', 'Офтальмолог', 2800.00);

/*
-- Процедура для генерации слотов на неделю
DELIMITER $$

CREATE PROCEDURE GenerateWeeklySlots(
    IN p_doctor_id VARCHAR(36),
    IN p_start_date DATE
)
BEGIN
    DECLARE current_date1 DATE;
    DECLARE current_time1 DATETIME;
    DECLARE end_time DATETIME;
    DECLARE slot_end DATETIME;
    
    SET current_date1 = p_start_date;
    
    WHILE current_date1 <= DATE_ADD(p_start_date, INTERVAL 6 DAY) DO
        -- Проверяем, что день недели не выходной (1-5 = Пн-Пт)
        IF DAYOFWEEK(current_date1) BETWEEN 2 AND 6 THEN
            SET current_time1 = TIMESTAMP(current_date1, '09:00:00');
            SET end_time = TIMESTAMP(current_date1, '21:00:00');
            
            WHILE current_time1 < end_time DO
                SET slot_end = DATE_ADD(current_time1, INTERVAL 30 MINUTE);
                
                -- Вставляем слот, если его еще нет
                INSERT IGNORE INTO Schedule (id, doctor_id, date, time_from, time_to, is_free)
                VALUES (UUID(), p_doctor_id, current_date1, current_time1, slot_end, TRUE);
                
                SET current_time1 = slot_end;
            END WHILE;
        END IF;
        
        SET current_date1 = DATE_ADD(current_date1, INTERVAL 1 DAY);
    END WHILE;
END$$

DELIMITER ;

-- Выводим список созданных врачей с их UUID для тестирования
SELECT 'Доктора для тестирования:' as '';
SELECT id, name, surname, spec FROM Doctors;
*/
