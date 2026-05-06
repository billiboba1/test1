const express = require('express');
require('dotenv').config();

const routes = require('./src/routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', routes);

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
})

