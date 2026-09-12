const prisma = require('../config/prisma');

/**
 * Get paginated and filtered audit logs for the authenticated user's company.
 */
const getAuditLogs = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            action,
            entity,
            entityType,
            entityId,
            invoiceId,
            userId,
            startDate,
            endDate,
            search,
            companyId
        } = req.query;

        const userRole = req.user?.role?.toUpperCase();
        const requestedCompanyId = (companyId || req.query.companyId) ? parseInt(companyId || req.query.companyId, 10) : null;
        const userCompanyId = req.user?.companyId ? parseInt(req.user.companyId, 10) : null;

        const where = {};

        if (userRole === 'SUPERADMIN') {
            if (requestedCompanyId) {
                where.companyId = requestedCompanyId;
            } else if (userCompanyId) {
                where.companyId = userCompanyId;
            }
            // If neither, superadmin sees logs across all companies!
        } else {
            const activeCompanyId = requestedCompanyId || userCompanyId;
            if (!activeCompanyId) {
                return res.status(400).json({ message: 'Company ID is required' });
            }
            where.companyId = activeCompanyId;
        }

        if (action && typeof action === 'string' && action.trim()) {
            where.action = action.trim();
        }

        const targetEntity = entity || entityType || req.query.entityType;
        if (targetEntity && typeof targetEntity === 'string' && targetEntity.trim()) {
            where.entity = targetEntity.trim();
        }

        const targetEntityId = entityId || invoiceId;
        if (targetEntityId !== undefined && targetEntityId !== null && String(targetEntityId).trim()) {
            const trimmedTarget = String(targetEntityId).trim();
            const parsedTargetNum = parseInt(trimmedTarget, 10);
            if (!isNaN(parsedTargetNum) && String(parsedTargetNum) === trimmedTarget) {
                where.entityId = parsedTargetNum;
            } else {
                where.details = { contains: trimmedTarget };
            }
        }

        if (userId) {
            const parsedUserId = parseInt(userId, 10);
            if (!isNaN(parsedUserId)) {
                where.userId = parsedUserId;
            }
        }

        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) {
                const start = new Date(startDate);
                if (!isNaN(start.getTime())) {
                    where.createdAt.gte = start;
                }
            }
            if (endDate) {
                const end = new Date(endDate);
                if (!isNaN(end.getTime())) {
                    end.setHours(23, 59, 59, 999);
                    where.createdAt.lte = end;
                }
            }
            if (Object.keys(where.createdAt).length === 0) {
                delete where.createdAt;
            }
        }

        if (search && typeof search === 'string' && search.trim()) {
            const trimmedSearch = search.trim();
            const searchConditions = [
                { userName: { contains: trimmedSearch } },
                { userEmail: { contains: trimmedSearch } },
                { details: { contains: trimmedSearch } }
            ];
            const parsedNum = parseInt(trimmedSearch, 10);
            if (!isNaN(parsedNum) && String(parsedNum) === trimmedSearch) {
                searchConditions.push({ entityId: parsedNum });
            }
            where.OR = searchConditions;
        }

        const isExportAll = req.query.all === 'true' || req.query.limit === 'all' || req.query.limit === '-1';

        const parsedPage = isExportAll ? 1 : Math.max(1, parseInt(page, 10) || 1);
        const parsedLimit = isExportAll ? undefined : Math.max(1, Math.min(1000, parseInt(limit, 10) || 20));
        const skip = isExportAll ? undefined : (parsedPage - 1) * parsedLimit;
        const take = isExportAll ? undefined : parsedLimit;

        const [logs, total] = await Promise.all([
            prisma.auditlog.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                },
                ...(skip !== undefined ? { skip } : {}),
                ...(take !== undefined ? { take } : {}),
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            role: true
                        }
                    },
                    company: {
                        select: {
                            id: true,
                            name: true
                        }
                    }
                }
            }),
            prisma.auditlog.count({ where })
        ]);

        res.status(200).json({
            logs,
            pagination: {
                total,
                page: parsedPage,
                limit: isExportAll ? total : parsedLimit,
                totalPages: isExportAll ? 1 : (Math.ceil(total / parsedLimit) || 1)
            }
        });
    } catch (err) {
        console.error('Error fetching audit logs:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
};

module.exports = { getAuditLogs };
