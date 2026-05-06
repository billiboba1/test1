const mysql = require('mysql2/promise');
require('dotenv').config();

class dbController {
    constructor(params = process.env) {
        this.pool = null;

        this.poolParams = {
            host: params.DB_HOST || 'localhost',
            port: params.DB_PORT || 3306,
            user: params.DB_USER || 'root',
            password: params.DB_PASSWORD || '',
            database: params.DB_NAME || 'test_schema_a_shadrin_1',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
        };
    }

    #connect() {
        if (this.pool) {
            return;
        }

        this.pool = mysql.createPool(this.poolParams);
    }

    async query(sql, params = []) {
        this.#connect();

        const [rows] = await this.pool.execute(sql, params);
        return rows;
    }

    async transaction(callback) {
        this.#connect();

        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        try {
            const result = await callback(connection);
            await connection.commit();

            return result;
        } catch (err) {
            await connection.rollback();

            throw err;
        } finally {
            connection.release();
        }
    }
}

module.exports = dbController;
