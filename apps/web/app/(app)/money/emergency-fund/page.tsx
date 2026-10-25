import { redirect } from "next/navigation";

// The emergency fund is now one of your goals in Money → Goals. Old links and bookmarks land on it.
export default function EmergencyFundRedirect() {
  redirect("/money/goals?goal=emergency");
}
