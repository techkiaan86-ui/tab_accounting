const prisma = require('../config/prisma');

/**
 * Get paginated and filtered audit logs for the authenticated user's company.
 */
const getAuditLogs = async (req, res) => {
    try {
        const userRole = req.user?.role?.toUpperCase();
        const requestedCompanyId = req.query.companyId ? parseInt(req.query.companyId) : null;
        const userCompanyId = req.user?.companyId ? parseInt(req.user.companyId) : null;

        const where = {};

        if (userRole === 'SUPERADMIN') {
            if (requestedCompanyId) {
                where.companyId = requestedCompanyId;
            } else if (userCompanyId) {
                where.companyId = userCompanyId;
            }
            // If neither, superadmin sees logs across all companies!
        } else {
            const activeCompanyId = userCompanyId || requestedCompanyId;
            if (!activeCompanyId) {
                return res.status(400).json({ message: 'Company ID is required' });
            }
            where.companyId = activeCompanyId;
        }

        if (action) {
            where.action = action;
        }

        if (entity) {
            where.entity = entity;
        }

        const targetEntityId = entityId || invoiceId;
        if (targetEntityId) {
            where.entityId = parseInt(targetEntityId);
        }

        if (userId) {
            where.userId = parseInt(userId);
        }

        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) {
                where.createdAt.gte = new Date(startDate);
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                where.createdAt.lte = end;
            }
        }

        if (search) {
            const searchConditions = [
                { userName: { contains: search } },
                { userEmail: { contains: search } },
                { details: { contains: search } }
            ];
            const parsedNum = parseInt(search);
            if (!isNaN(parsedNum)) {
                searchConditions.push({ entityId: parsedNum });
            }
            where.OR = searchConditions;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const [logs, total] = await Promise.all([
            prisma.auditlog.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                },
                skip,
                take,
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
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Error fetching audit logs:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
};

module.exports = { getAuditLogs };
