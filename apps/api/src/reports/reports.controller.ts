import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { ReportsService } from "./reports.service";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("reports")
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get("monthly")
  monthly(@CurrentUser() user: User, @Query("month") month?: string) {
    return this.reportsService.monthlyReport(user.id, month);
  }

  @Get("yearly")
  yearly(@CurrentUser() user: User, @Query("financialYear") financialYear?: string) {
    return this.reportsService.yearlyReport(user.id, financialYear);
  }

  @Get("monthly/export.csv")
  async monthlyCsv(@CurrentUser() user: User, @Query("month") month: string | undefined, @Res() res: Response) {
    const csv = await this.reportsService.monthlyReportCsv(user.id, month);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wealthos-monthly-report-${sanitizeFilenamePart(month ?? "current")}.csv"`,
    });
    res.send(csv);
  }

  // Previously missing — see ReportsService.yearlyReportCsv(). "yearly/export.csv" is a
  // distinct static route segment from "yearly", so there's no ordering/collision concern
  // with the @Get("yearly") route above.
  @Get("yearly/export.csv")
  async yearlyCsv(
    @CurrentUser() user: User,
    @Query("financialYear") financialYear: string | undefined,
    @Res() res: Response,
  ) {
    const csv = await this.reportsService.yearlyReportCsv(user.id, financialYear);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wealthos-yearly-report-${sanitizeFilenamePart(financialYear ?? "current")}.csv"`,
    });
    res.send(csv);
  }
}

// The query params are already format-validated inside ReportsService (it throws
// BadRequestException before a controller method ever gets this far), but the filename
// is still built from user-supplied query input, so this strips anything outside a
// conservative safe set as defense-in-depth against header injection / unsafe filename
// characters in the Content-Disposition header. Exported for unit testing.
export function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "_");
}
