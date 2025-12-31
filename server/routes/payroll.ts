import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission } from "../middleware/auth";
import { sendPayrollAdjustmentNotification } from "../services/email";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Payroll
 *   description: Payroll management and adjustments
 */

/**
 * @swagger
 * /payroll/adjustments:
 *   post:
 *     summary: Add a payroll adjustment (bonus or deduction)
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - type
 *               - amount
 *               - reason
 *             properties:
 *               userId:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [bonus, deduction]
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *                 enum: [USD, NGN]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Adjustment added
 */
router.post("/adjustments", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { userId, type, amount, reason, currency } = req.body;

        if (!['bonus', 'deduction'].includes(type)) {
            return res.status(400).json({ success: false, error: "Invalid type. Must be 'bonus' or 'deduction'." });
        }

        if (amount <= 0) {
            return res.status(400).json({ success: false, error: "Amount must be greater than 0." });
        }

        if (currency && !['USD', 'NGN'].includes(currency)) {
            return res.status(400).json({ success: false, error: "Invalid currency. Must be USD or NGN." });
        }

        // Check if user belongs to business
        const userCheck = await query(`SELECT * FROM users WHERE id = $1 AND business_id = $2`, [userId, businessId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User not found." });
        }
        const user = userCheck.rows[0];

        // Determine currency: provided > user's salary currency > business default > NGN
        let finalCurrency = currency;
        if (!finalCurrency) {
            if (user.salary_currency) {
                finalCurrency = user.salary_currency;
            } else {
                const businessRes = await query(`SELECT currency FROM businesses WHERE id = $1`, [businessId]);
                finalCurrency = businessRes.rows[0]?.currency || 'NGN';
            }
        }

        // Create adjustment
        await query(
            `INSERT INTO payroll_adjustments (business_id, user_id, type, amount, currency, reason, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [businessId, userId, type, amount, finalCurrency, reason]
        );

        // Send Notifications
        // 1. Get Admins
        const admins = await query(`SELECT email FROM users WHERE business_id = $1 AND role IN ('admin', 'manager') AND email_verified = TRUE`, [businessId]);
        const emailList = admins.rows.map(r => r.email);
        
        // 2. Add User Email
        if (user.email_verified) {
            emailList.push(user.email);
        }

        // 3. Deduplicate
        const uniqueEmails: string[] = Array.from(new Set(emailList));

        // 4. Get Business Name
        const businessRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
        const businessName = businessRes.rows[0].name;

        // 5. Send Email
        await sendPayrollAdjustmentNotification(
            uniqueEmails,
            user.name,
            type,
            amount,
            finalCurrency,
            reason,
            businessName
        );

        res.json({ success: true, message: "Adjustment added and notifications sent." });

    } catch (error) {
        console.error("Add adjustment error:", error);
        res.status(500).json({ success: false, error: "Failed to add adjustment" });
    }
});

/**
 * @swagger
 * /payroll/adjustments:
 *   get:
 *     summary: Get pending payroll adjustments
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of adjustments
 */
router.get("/adjustments", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { userId } = req.query;

        let queryText = `
            SELECT pa.*, u.name as user_name, u.email as user_email
            FROM payroll_adjustments pa
            JOIN users u ON pa.user_id = u.id
            WHERE pa.business_id = $1 AND pa.status = 'pending'
        `;
        const params: any[] = [businessId];

        if (userId) {
            queryText += ` AND pa.user_id = $2`;
            params.push(userId);
        }

        queryText += ` ORDER BY pa.created_at DESC`;

        const result = await query(queryText, params);
        res.json({ success: true, adjustments: result.rows });
    } catch (error) {
        console.error("Get adjustments error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch adjustments" });
    }
});

/**
 * @swagger
 * /payroll/adjustments/{id}:
 *   delete:
 *     summary: Delete/Cancel a pending adjustment
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Adjustment deleted
 */
router.delete("/adjustments/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;

        const result = await query(
            `DELETE FROM payroll_adjustments WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
            [id, businessId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: "Adjustment not found or already processed" });
        }

        res.json({ success: true, message: "Adjustment removed" });
    } catch (error) {
        console.error("Delete adjustment error:", error);
        res.status(500).json({ success: false, error: "Failed to delete adjustment" });
    }
});

/**
 * @swagger
 * /payroll/summary:
 *   get:
 *     summary: Get payroll summary for all team members
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name or email
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *         description: Filter by user role
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter adjustments start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter adjustments end date (YYYY-MM-DD)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of team members with payroll calculations
 */
router.get("/summary", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { search, role, startDate, endDate, page = 1, limit = 10 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        // Check Business KYC Status
        const businessCheck = await query(`SELECT kyc_status, salary_interval, salary_custom_date FROM businesses WHERE id = $1`, [businessId]);
        if (businessCheck.rows[0]?.kyc_status !== 'verified') {
            // Check if user is verified (Auto-verify business if user is verified to fix mismatch)
            const userCheck = await query(`SELECT bvn_status, nin_status FROM users WHERE id = $1`, [req.user!.userId]);
            const isUserVerified = userCheck.rows[0]?.bvn_status === 'verified' || userCheck.rows[0]?.nin_status === 'verified';

            if (isUserVerified) {
                 await query(`UPDATE businesses SET kyc_status = 'verified' WHERE id = $1`, [businessId]);
            } else {
                return res.status(403).json({ 
                    success: false, 
                    error: "Business KYC verification is required to access payroll summary. Please complete verification in Settings." 
                });
            }
        }

        // Build User Query
        let userQuery = `
            SELECT id, name, email, salary_currency, account_number as bank_account_number, bank_code, account_name, role, salary_amount as salary, contract_start_date,
            COUNT(*) OVER() as total_count
            FROM users 
            WHERE business_id = $1 AND status = 'active'
        `;
        const userParams: any[] = [businessId];
        let paramIndex = 2;

        if (search) {
            userQuery += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
            userParams.push(`%${search}%`);
            paramIndex++;
        }

        if (role) {
            userQuery += ` AND role = $${paramIndex}`;
            userParams.push(role);
            paramIndex++;
        }

        userQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        userParams.push(Number(limit), offset);

        // Fetch users
        const users = await query(userQuery, userParams);
        
        const totalUsers = users.rows.length > 0 ? parseInt(users.rows[0].total_count) : 0;
        const totalPages = Math.ceil(totalUsers / Number(limit));

        if (users.rows.length === 0) {
             return res.json({ 
                success: true, 
                payroll: [],
                pagination: {
                    total: totalUsers,
                    page: Number(page),
                    limit: Number(limit),
                    totalPages: totalPages
                }
            });
        }

        const userIds = users.rows.map(u => u.id);

        // Build Adjustment Query
        let adjQuery = `
            SELECT user_id, type, amount, currency 
            FROM payroll_adjustments 
            WHERE business_id = $1 AND status = 'pending' AND user_id = ANY($2)
        `;
        const adjParams: any[] = [businessId, userIds];
        let adjParamIndex = 3;

        if (startDate) {
             adjQuery += ` AND created_at >= $${adjParamIndex}`;
             adjParams.push(startDate);
             adjParamIndex++;
        }
        
        if (endDate) {
             adjQuery += ` AND created_at <= $${adjParamIndex}`;
             adjParams.push(endDate);
             adjParamIndex++;
        }

        // Fetch pending adjustments
        const adjustments = await query(adjQuery, adjParams);

        // Group adjustments by user
        const adjMap: Record<string, { bonuses: number, deductions: number, bonus_list: any[], deduction_list: any[] }> = {};
        
        adjustments.rows.forEach(adj => {
            if (!adjMap[adj.user_id]) {
                adjMap[adj.user_id] = { bonuses: 0, deductions: 0, bonus_list: [], deduction_list: [] };
            }
            // Simple currency conversion (assuming same currency for now, or just sum)
            // Ideally, we should convert everything to user's salary currency.
            // For this MVP, we sum raw amounts if currencies match or just display.
            // We'll assume amounts are in user's salary currency for calculation.
            if (adj.type === 'bonus') {
                adjMap[adj.user_id].bonuses += parseFloat(adj.amount);
                adjMap[adj.user_id].bonus_list.push(adj);
            } else {
                adjMap[adj.user_id].deductions += parseFloat(adj.amount);
                adjMap[adj.user_id].deduction_list.push(adj);
            }
        });

        const payrollData = users.rows.map(user => {
            const userAdj = adjMap[user.id] || { bonuses: 0, deductions: 0, bonus_list: [], deduction_list: [] };
            const salary = parseFloat((user as any).salary || '0');
            // const net = salary + userAdj.bonuses - userAdj.deductions; // Removed to avoid duplication and unused variable
            
            // Calculate Next Pay Date & Pay Period Start
            const today = new Date();
            let nextPayDate = new Date();
            let periodStartDate = new Date();
            const { salary_interval, salary_custom_date } = businessCheck.rows[0];

            if (salary_interval === 'daily') {
                nextPayDate.setDate(today.getDate() + 1);
                periodStartDate = new Date(today); // Today is the start
            } else if (salary_interval === 'weekly') {
                nextPayDate.setDate(today.getDate() + 7);
                periodStartDate.setDate(today.getDate() - 6); // 7 days window ending today (approx) or forward looking?
                // Standardizing: Let's assume period ends on nextPayDate - 1 day, or nextPayDate is the payday for PREVIOUS period.
                // Simplified: Daily Pay = Salary / 7. Days worked = days in current week user was active.
                // For simplicity in MVP: Assume period starts 7 days before nextPayDate.
                const nextPayTime = nextPayDate.getTime();
                periodStartDate = new Date(nextPayTime - 7 * 24 * 60 * 60 * 1000);
            } else if (salary_interval === 'yearly') {
                nextPayDate.setFullYear(today.getFullYear() + 1);
                periodStartDate.setFullYear(today.getFullYear()); // Start of this year
            } else if (salary_interval === 'custom' && salary_custom_date) {
                nextPayDate = new Date(salary_custom_date);
                // Assume monthly duration for custom date for now, or just undefined period start (default to 30 days back)
                periodStartDate = new Date(nextPayDate);
                periodStartDate.setDate(periodStartDate.getDate() - 30);
            } else {
                 // Default to Monthly (Last day of current month)
                nextPayDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                periodStartDate = new Date(today.getFullYear(), today.getMonth(), 1); // 1st of current month
            }
            
            // Calculate Prorated Salary
            let finalSalary = salary;
            let daysWorked = 0;
            let totalDaysInPeriod = 0;
            let calculationType = 'standard'; // 'standard', 'prorated', 'not_started'

            if (user.contract_start_date) {
                const contractStart = new Date(user.contract_start_date);
                
                // Determine Total Days in Period
                const diffTime = nextPayDate.getTime() - periodStartDate.getTime();
                totalDaysInPeriod = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                if (totalDaysInPeriod === 0) totalDaysInPeriod = 30; // Fallback

                // Determine Daily Pay
                const dailyPay = salary / totalDaysInPeriod;

                // Determine Days Worked in this Period
                // If contract starts AFTER period ends, pay 0.
                // If contract starts BEFORE period starts, pay Full (daysWorked = totalDaysInPeriod).
                // If contract starts WITHIN period, pay partial.
                
                if (contractStart > nextPayDate) {
                    daysWorked = 0;
                    calculationType = 'not_started';
                } else if (contractStart <= periodStartDate) {
                    daysWorked = totalDaysInPeriod;
                    calculationType = 'standard';
                } else {
                    // Starts within period
                    const workedTime = nextPayDate.getTime() - contractStart.getTime();
                    daysWorked = Math.ceil(workedTime / (1000 * 60 * 60 * 24));
                    // Ensure we don't exceed total days (though logic implies we won't)
                    if (daysWorked > totalDaysInPeriod) daysWorked = totalDaysInPeriod;
                    if (daysWorked < 0) daysWorked = 0;
                    
                    calculationType = 'prorated';
                }

                finalSalary = dailyPay * daysWorked;
            }

            const finalNet = finalSalary + userAdj.bonuses - userAdj.deductions;
            
            return {
                ...user,
                // Remove total_count from user object in response
                total_count: undefined,
                currency: user.salary_currency || 'NGN', // Explicitly return currency for display
                bonuses_total: userAdj.bonuses,
                deductions_total: userAdj.deductions,
                net_salary: finalNet > 0 ? finalNet : 0,
                next_pay_date: nextPayDate.toISOString().split('T')[0],
                adjustments: userAdj,
                contract_start_date: user.contract_start_date, // Return this for frontend
                days_worked: daysWorked > 0 ? daysWorked : undefined, // Optional info
                salary_calculation_status: calculationType
            };
        });

        res.json({ 
            success: true, 
            payroll: payrollData,
            pagination: {
                total: totalUsers,
                page: Number(page),
                limit: Number(limit),
                totalPages: totalPages
            }
        });

    } catch (error: any) {
        console.error("Get payroll summary error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch payroll summary", details: error.message });
    }
});

/**
 * @swagger
 * /payroll/user/{id}:
 *   put:
 *     summary: Update user payroll details
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               salary:
 *                 type: number
 *               salary_currency:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               bank_code:
 *                 type: string
 *               account_name:
 *                 type: string
 *               contract_start_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: User payroll details updated
 */
router.put("/user/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;
        const { salary, salary_currency, bank_account_number, bank_code, account_name, contract_start_date } = req.body;

        const check = await query(`SELECT id FROM users WHERE id = $1 AND business_id = $2`, [id, businessId]);
        if (check.rows.length === 0) return res.status(404).json({ success: false, error: "User not found" });

        await query(
            `UPDATE users SET 
                salary_amount = COALESCE($1, salary_amount), 
                salary_currency = COALESCE($2, salary_currency), 
                account_number = COALESCE($3, account_number), 
                bank_code = COALESCE($4, bank_code), 
                account_name = COALESCE($5, account_name),
                contract_start_date = COALESCE($6, contract_start_date)
             WHERE id = $7`,
            [salary, salary_currency, bank_account_number, bank_code, account_name, contract_start_date, id]
        );

        res.json({ success: true, message: "Payroll details updated" });

    } catch (error) {
        console.error("Update payroll details error:", error);
        res.status(500).json({ success: false, error: "Failed to update payroll details" });
    }
});

/**
 * @swagger
 * /payroll/config:
 *   get:
 *     summary: Get payroll configuration (salary interval)
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current payroll configuration
 */
router.get("/config", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const result = await query(`SELECT salary_interval, salary_custom_date FROM businesses WHERE id = $1`, [businessId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        res.json({ success: true, config: result.rows[0] });
    } catch (error) {
        console.error("Get payroll config error:", error);
        res.status(500).json({ success: false, error: "Failed to get payroll config" });
    }
});

/**
 * @swagger
 * /payroll/config:
 *   put:
 *     summary: Update payroll configuration
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - salary_interval
 *             properties:
 *               salary_interval:
 *                 type: string
 *                 enum: [daily, weekly, monthly, yearly, custom]
 *               salary_custom_date:
 *                 type: string
 *                 format: date-time
 *                 description: Required if interval is custom
 *     responses:
 *       200:
 *         description: Configuration updated
 */
router.put("/config", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { salary_interval, salary_custom_date } = req.body;

        const validIntervals = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
        if (!validIntervals.includes(salary_interval)) {
            return res.status(400).json({ success: false, error: "Invalid salary interval" });
        }

        if (salary_interval === 'custom' && !salary_custom_date) {
            return res.status(400).json({ success: false, error: "Custom date is required for custom interval" });
        }

        await query(
            `UPDATE businesses SET salary_interval = $1, salary_custom_date = $2 WHERE id = $3`,
            [salary_interval, salary_custom_date || null, businessId]
        );

        res.json({ success: true, message: "Payroll configuration updated" });
    } catch (error) {
        console.error("Update payroll config error:", error);
        res.status(500).json({ success: false, error: "Failed to update payroll config" });
    }
});

export default router;
