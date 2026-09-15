/**
 * invoiceSyncHelper.js
 * Centralized business logic for invoice payment synchronization, 
 * outstanding balance calculation, and status determination across TAB ACCOUNTS.
 */

// Helper to get currency decimal places
const getDecimalPlaces = (currency) => {
    const threeDecimalCurrencies = ['KWD', 'BHD', 'OMR', 'JOD', 'LYD', 'TND'];
    return threeDecimalCurrencies.includes(currency?.toUpperCase()) ? 3 : 2;
};

// Round value to specified decimal places
const roundTo = (val, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round((parseFloat(val) || 0) * factor) / factor;
};

/**
 * Checks if the invoice due date has passed.
 * Compares by start of calendar day: true if current day is strictly after due date day.
 */
const isDuePassed = (dueDate) => {
    if (!dueDate) return false;
    const due = new Date(dueDate);
    if (isNaN(due.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(due);
    d.setHours(0, 0, 0, 0);
    return today.getTime() > d.getTime();
};

/**
 * Computes paid amount, outstanding balance, and status based on authoritative rules:
 * - Outstanding Balance = max(0, Invoice Total - Total Payments Received)
 * - If balance <= tolerance AND (total > 0 OR paid >= total - tolerance) -> PAID
 * - If paid > tolerance AND balance > tolerance -> PARTIAL (displayed as PARTIALLY PAID)
 * - If balance <= tolerance AND total == 0 AND paid == 0 -> PAID
 * - Otherwise -> UNPAID
 * - Never mark an invoice PAID while balance > tolerance.
 */
const computeInvoiceStatusAndBalance = (invoice, paymentsReceived = null, tolerance = null) => {
    if (!invoice) return invoice;

    const decimals = getDecimalPlaces(invoice.currency);
    const tol = tolerance !== null ? tolerance : (decimals === 3 ? 0.001 : 0.01);

    const total = roundTo(invoice.totalAmount || 0, decimals);
    const paid = paymentsReceived !== null 
        ? roundTo(paymentsReceived, decimals) 
        : roundTo(invoice.paidAmount || 0, decimals);
    
    // Balance cannot be negative
    const balance = Math.max(0, roundTo(total - paid, decimals));

    const isPos = invoice.type === 'POS_INVOICE' || !!invoice.posinvoiceitem;
    const duePassed = isDuePassed(invoice.dueDate || invoice.date);

    let computedStatus;
    let displayStatus;

    if (invoice.status === 'CANCELLED' || invoice.status === 'Cancelled') {
        computedStatus = isPos ? 'Cancelled' : 'CANCELLED';
        displayStatus = computedStatus;
    } else if (paid > total + tol) {
        // Genuine overpayment: fully settled, with credit balance
        computedStatus = isPos ? 'Paid' : 'PAID';
        displayStatus = 'OVERPAID';
    } else if (balance <= tol && (total > 0 || paid >= total - tol)) {
        computedStatus = isPos ? 'Paid' : 'PAID';
        displayStatus = computedStatus;
    } else if (paid > tol && balance > tol) {
        computedStatus = isPos ? 'Partial' : 'PARTIAL';
        displayStatus = isPos ? 'Partially Paid' : 'PARTIALLY PAID';
    } else if (balance <= tol && total === 0 && paid === 0) {
        computedStatus = isPos ? 'Paid' : 'PAID';
        displayStatus = computedStatus;
    } else if (balance > tol && duePassed) {
        computedStatus = isPos ? 'Overdue' : 'OVERDUE';
        displayStatus = computedStatus;
    } else {
        computedStatus = isPos ? 'Due' : 'UNPAID';
        displayStatus = computedStatus;
    }

    return {
        paidAmount: paid,
        balanceAmount: balance,
        status: computedStatus,
        displayStatus
    };
};

/**
 * Syncs an invoice in the database:
 * Calculates total payments received from all allocations or applies delta,
 * calculates outstanding balance and status, and updates the database record.
 */
const syncInvoiceInDb = async (txOrPrisma, invoiceId, type = 'TAX_INVOICE', deltaPaid = null) => {
    if (type === 'POS_INVOICE') {
        const inv = await txOrPrisma.posinvoice.findUnique({ where: { id: parseInt(invoiceId) } });
        if (!inv) return null;

        const decimals = getDecimalPlaces(inv.currency);
        let paidAmount;
        if (deltaPaid !== null) {
            paidAmount = Math.max(0, roundTo((inv.paidAmount || 0) + deltaPaid, decimals));
        } else {
            paidAmount = roundTo(inv.paidAmount || 0, decimals);
        }

        const { balanceAmount, status } = computeInvoiceStatusAndBalance(
            inv,
            paidAmount,
            decimals === 3 ? 0.001 : 0.01
        );

        return await txOrPrisma.posinvoice.update({
            where: { id: parseInt(invoiceId) },
            data: {
                paidAmount,
                balanceAmount,
                status,
                manualStatus: false,
                updatedAt: new Date()
            }
        });
    } else {
        const parsedId = parseInt(invoiceId);
        if (isNaN(parsedId)) return null;

        const inv = await txOrPrisma.invoice.findUnique({
            where: { id: parsedId },
            include: {
                allocations: true
            }
        });
        if (!inv) return null;

        const decimals = getDecimalPlaces(inv.currency);
        let paidAmount;
        if (inv.allocations && inv.allocations.length > 0) {
            // Authoritative: Calculate directly from active allocations
            const totalAlloc = inv.allocations.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);
            paidAmount = roundTo(totalAlloc, decimals);
        } else if (deltaPaid !== null) {
            paidAmount = Math.max(0, roundTo((inv.paidAmount || 0) + deltaPaid, decimals));
        } else {
            paidAmount = roundTo(inv.paidAmount || 0, decimals);
        }

        const { balanceAmount, status } = computeInvoiceStatusAndBalance(
            inv,
            paidAmount,
            decimals === 3 ? 0.001 : 0.01
        );

        // Map to valid MySQL DB enum
        const dbStatus = (status === 'PARTIALLY PAID' || status === 'PARTIAL') ? 'PARTIAL' : status;

        return await txOrPrisma.invoice.update({
            where: { id: parseInt(invoiceId) },
            data: {
                paidAmount,
                balanceAmount,
                status: dbStatus,
                manualStatus: false,
                updatedAt: new Date()
            }
        });
    }
};

module.exports = {
    getDecimalPlaces,
    roundTo,
    isDuePassed,
    computeInvoiceStatusAndBalance,
    syncInvoiceInDb
};
