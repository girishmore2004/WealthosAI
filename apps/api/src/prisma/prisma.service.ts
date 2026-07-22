import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma, PrismaClient } from "@wealthos/db";

// Thin wrapper so Nest can manage lifecycle hooks around the shared Prisma singleton.
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  public readonly client: PrismaClient = prisma;

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
