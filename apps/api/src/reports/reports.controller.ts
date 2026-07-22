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
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="wealthos-report-${month ?? "current"}.csv"`,
    });
    res.send(csv);
  }
}
