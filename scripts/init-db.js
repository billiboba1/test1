/**
 * Применяет sql/init.sql через клиент mysql (нужен в PATH).
 * Параметры подключения читаются из .env (как в приложении).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sqlPath = path.join(__dirname, '..', 'sql', 'init.sql');

if (!fs.existsSync(sqlPath)) {
    console.error('Не найден файл:', sqlPath);
    process.exit(1);
}

const host = process.env.DB_HOST || 'localhost';
const port = String(process.env.DB_PORT || '3306');
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD;

const args = [`-h${host}`, `-P${port}`, `-u${user}`];
if (password !== undefined && password !== '') {
    args.push(`-p${password}`);
}

const sql = fs.readFileSync(sqlPath, 'utf8');

const result = spawnSync('mysql', args, {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
});

if (result.error) {
    if (result.error.code === 'ENOENT') {
        console.error(
            'Команда mysql не найдена. Установите MySQL/MariaDB client и добавьте его в PATH,\n' +
                'или задайте полный путь через переменную окружения MYSQL_BIN.'
        );
    } else {
        console.error(result.error.message);
    }
    process.exit(1);
}

if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

console.log('Схема применена:', sqlPath);