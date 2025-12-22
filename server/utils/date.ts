/**
 * Calculate start and end dates for monthly tasks
 */
export function calculateMonthlyDateRange(startDate?: string): {
  startDate: string;
  endDate: string;
} {
  const start = startDate ? new Date(startDate) : new Date();

  // Start date is the provided date or today
  const startDateStr = start.toISOString().split("T")[0];

  // End date is the last day of the month
  const lastDayOfMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const endDateStr = lastDayOfMonth.toISOString().split("T")[0];

  return { startDate: startDateStr, endDate: endDateStr };
}

/**
 * Check if a date is overdue (past end date)
 */
export function isOverdue(endDate: string): boolean {
  const end = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return end < today;
}

/**
 * Get days remaining until end date
 */
export function getDaysRemaining(endDate: string): number {
  const end = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffTime = end.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}

/**
 * Get progress percentage for current month
 */
export function getMonthProgress(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (today < start) return 0;
  if (today > end) return 100;

  const totalDays = Math.ceil(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );
  const elapsedDays = Math.ceil(
    (today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );

  return Math.round((elapsedDays / totalDays) * 100);
}
