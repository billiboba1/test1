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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
);

CREATE TABLE IF NOT EXISTS Doctors (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    surname VARCHAR(50) NOT NULL,
    patronymic VARCHAR(50),
    spec VARCHAR(30) NOT NULL,
    price DECIMAL(10, 2) NOT NULL, 
)

CREATE TABLE IF NOT EXISTS Schedule (
    id VARCHAR(36) PRIMARY KEY,
    doctor_id VARCHAR(36),
    date DATE NOT_NULL,
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
)

-- Добавляем тестовых врачей
INSERT INTO Doctors (id, name, surname, patronymic, spec, price) VALUES
(UUID(), 'Сергей', 'Иванов', 'Романович', 'Терапевт', 2500.00),
(UUID(), 'Анна', 'Петрова', 'Сергеевна', 'Кардиолог', 3500.00),
(UUID(), 'Михаил', 'Сидоров', 'Александрович', 'Хирург', 5000.00),
(UUID(), 'Елена', 'Козлова', 'Андреевна', 'Невролог', 3000.00),
(UUID(), 'Дмитрий', 'Соколов', 'Викторович', 'Офтальмолог', 2800.00);

-- Процедура для генерации слотов на неделю
DELIMITER $$

CREATE PROCEDURE GenerateWeeklySlots(
    IN p_doctor_id VARCHAR(36),
    IN p_start_date DATE
)
BEGIN
    DECLARE current_date DATE;
    DECLARE current_time DATETIME;
    DECLARE end_time DATETIME;
    DECLARE slot_end DATETIME;
    
    SET current_date = p_start_date;
    
    WHILE current_date <= DATE_ADD(p_start_date, INTERVAL 6 DAY) DO
        -- Проверяем, что день недели не выходной (1-5 = Пн-Пт)
        IF DAYOFWEEK(current_date) BETWEEN 2 AND 6 THEN
            SET current_time = TIMESTAMP(current_date, '09:00:00');
            SET end_time = TIMESTAMP(current_date, '21:00:00');
            
            WHILE current_time < end_time DO
                SET slot_end = DATE_ADD(current_time, INTERVAL 30 MINUTE);
                
                -- Вставляем слот, если его еще нет
                INSERT IGNORE INTO Schedule (id, doctor_id, date, time_from, time_to, is_free)
                VALUES (UUID(), p_doctor_id, current_date, current_time, slot_end, TRUE);
                
                SET current_time = slot_end;
            END WHILE;
        END IF;
        
        SET current_date = DATE_ADD(current_date, INTERVAL 1 DAY);
    END WHILE;
END$$

DELIMITER ;

-- Выводим список созданных врачей с их UUID для тестирования
SELECT 'Доктора для тестирования:' as '';
SELECT id, name, surname, spec FROM Doctors;