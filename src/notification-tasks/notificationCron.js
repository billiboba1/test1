/**
 * Три задачи по минуте (6-полевой cron: секунда минута час …):
 * - collect — :00 каждой минуты (Schedule → Tasks);
 * - calltask — :20 (RobotMIA bulk → Calls);
 * - result — :40 (result-bulk → обновление Calls/Tasks).
 * Отключить: DISABLE_NOTIFICATION_CRON=1
 */
const cron = require('node-cron');
const notificationTasksActions = require('./routesActions');

function startNotificationCrons() {
    if (String(process.env.DISABLE_NOTIFICATION_CRON || '').trim() === '1') {
        console.log('[cron] уведомления отключены (DISABLE_NOTIFICATION_CRON=1)');
        return;
    }

    const cronOpts = {};
    if (String(process.env.CRON_TZ || '').trim()) {
        cronOpts.timezone = String(process.env.CRON_TZ).trim();
    }

    cron.schedule(
        '0 * * * * *',
        async () => {
            try {
                await notificationTasksActions.collectTasksFromSchedulesForNotification();
            } catch (err) {
                console.error('[cron] notification-tasks/collect:', err);
            }
        },
        cronOpts
    );

    cron.schedule(
        '20 * * * * *',
        async () => {
            try {
                await notificationTasksActions.runNotificationCalltask();
            } catch (err) {
                console.error('[cron] notification-tasks/calltask:', err);
            }
        },
        cronOpts
    );

    cron.schedule(
        '40 * * * * *',
        async () => {
            try {
                await notificationTasksActions.syncResultsFromRobotMia();
            } catch (err) {
                console.error('[cron] notification-tasks/result:', err);
            }
        },
        cronOpts
    );

    console.log(
        '[cron] уведомления: collect :00, calltask :20, result :40 (каждую минуту, CRON_TZ при необходимости)'
    );
}

module.exports = { startNotificationCrons };
