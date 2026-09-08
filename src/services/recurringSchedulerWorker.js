const { runPendingRecurringHelper } = require('../controllers/advancedAccountingController');

/**
 * Background worker to automatically execute scheduled recurring transactions
 * without requiring manual intervention from users.
 */
let isRunning = false;

const checkAndExecuteRecurring = async () => {
    if (isRunning) {
        console.log('[Recurring Scheduler Worker] Previous cycle still running, skipping...');
        return;
    }

    isRunning = true;
    try {
        const generated = await runPendingRecurringHelper(null);
        if (generated && generated.length > 0) {
            console.log(`[Recurring Scheduler Worker] Automatically executed ${generated.length} recurring transaction(s):`, 
                generated.map(g => `${g.type} (${g.refNumber}) for template #${g.templateId}`).join(', ')
            );
        }
    } catch (err) {
        console.error('[Recurring Scheduler Worker] Error executing scheduled transactions:', err.message);
    } finally {
        isRunning = false;
    }
};

const startRecurringSchedulerWorker = (intervalMinutes = 5) => {
    console.log(`[Recurring Scheduler Worker] Starting recurring transaction scheduler (interval: ${intervalMinutes}m)...`);

    // Initial check 30 seconds after server launch so DB and tables finish initial connection
    setTimeout(async () => {
        try {
            await checkAndExecuteRecurring();
        } catch (e) {
            console.error('[Recurring Scheduler Worker] Initial execution error:', e.message);
        }
    }, 30 * 1000);

    // Periodic interval
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    setInterval(async () => {
        try {
            await checkAndExecuteRecurring();
        } catch (e) {
            console.error('[Recurring Scheduler Worker] Periodic execution error:', e.message);
        }
    }, intervalMs);
};

module.exports = {
    startRecurringSchedulerWorker,
    checkAndExecuteRecurring
};
