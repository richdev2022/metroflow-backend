import express from "express";
import { query } from "../db";
import { isMaintenanceMode } from "../services/app-config";

/**
 * Public (unauthenticated) app configuration endpoint.
 * User apps poll this to know whether to show the maintenance screen and to
 * render the announcement ticker. No sensitive data is exposed.
 */
const router = express.Router();

router.get("/app-config", async (req, res) => {
  try {
    const maintenance = await isMaintenanceMode();

    let announcement: { id: string; title: string | null; message: string; updated_at: string } | null = null;
    try {
      const annRes = await query(
        `SELECT id, title, message, updated_at FROM announcements
         WHERE is_active = TRUE AND business_id IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      );
      if (annRes.rows.length > 0) {
        const row = annRes.rows[0];
        announcement = {
          id: row.id,
          title: row.title || null,
          message: row.message,
          updated_at: row.updated_at,
        };
      }
    } catch {
      // announcements table may not exist yet - ignore
    }

    res.json({
      success: true,
      data: {
        maintenance_mode: maintenance,
        announcement,
      },
    });
  } catch (error: any) {
    console.error("Public app-config error:", error.message);
    res.json({ success: true, data: { maintenance_mode: false, announcement: null } });
  }
});

export default router;
