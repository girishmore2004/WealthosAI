// DI wiring: the goals and financial-core modules resolve every provider (catches a missing import/export
// that unit tests with hand-built mocks cannot).
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaModule } from "../src/prisma/prisma.module";
import { AuditModule } from "../src/audit/audit.module";
import { AuthModule } from "../src/auth/auth.module";
import { RedisModule } from "../src/redis/redis.module";
import { GoalsModule } from "../src/goals/goals.module";
import { FinancialCoreModule } from "../src/financial-core/financial-core.module";
import { GoalsService } from "../src/goals/goals.service";
import { GoalFundingService } from "../src/financial-core/goal-funding/goal-funding.service";
import { GoalFundingController } from "../src/financial-core/goal-funding/goal-funding.controller";

describe("Money → Goals module wiring", () => {
  it("resolves GoalsService, GoalFundingService and the controller", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuditModule, AuthModule, RedisModule, FinancialCoreModule, GoalsModule] })
      .overrideProvider(PrismaService)
      .useValue({ client: {} })
      .compile();
    expect(moduleRef.get(GoalsService, { strict: false })).toBeDefined();
    expect(moduleRef.get(GoalFundingService, { strict: false })).toBeDefined();
    expect(moduleRef.get(GoalFundingController, { strict: false })).toBeDefined();
  });
});
