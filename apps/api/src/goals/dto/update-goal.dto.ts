import { PartialType } from "@nestjs/mapped-types";
import { CreateGoalDto } from "./create-goal.dto";

// currentAmount is accepted only for backward compatibility with older clients that send the value back
// unchanged: the funded amount is the balance of the goal's ledger and is changed in Money → Goals
// (add money / use money / move money), never by typing a new number. GoalsService rejects a different value.
export class UpdateGoalDto extends PartialType(CreateGoalDto) {}
