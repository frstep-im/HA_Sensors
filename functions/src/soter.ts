import { SoterEventType, SoterHistoryCard } from "./types";

const text = (value: unknown, maximum = 180) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export function conversationHistoryCard(data: FirebaseFirestore.DocumentData): SoterHistoryCard {
  const typeLabel = text(data.interactionTypeLabel, 48) || text(data.interactionType).replaceAll("_", " ") || "Door visit";
  const title = text(data.interactionTitle, 80) || text(data.notificationSummary, 120) || typeLabel;
  const summary = text(data.notificationDescription, 220) || text(data.notificationSummary, 220);
  const imageCandidate = text(data.preferredSceneImageUrl, 1600) || text(data.firstSceneImageUrl, 1600) || text(data.latestSceneImageUrl, 1600);
  const imageUrl = /^https?:\/\//i.test(imageCandidate) ? imageCandidate : "";
  const status = text(data.status, 32);
  const assistantOutcome = text(data.assistantOutcome, 32);
  const outcome = assistantOutcome && !/[.!?]/.test(assistantOutcome)
    ? assistantOutcome
    : text(data.alertDecision, 32) || text(data.handledOutcome, 32);
  return {
    typeLabel,
    title,
    ...(summary && summary.toLowerCase() !== title.toLowerCase() ? { description: summary } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(status ? { status } : {}),
    ...(outcome && outcome.toLowerCase() !== status.toLowerCase() ? { outcome: outcome.replaceAll("_", " ") } : {}),
  };
}

export function conversationTypes(data: FirebaseFirestore.DocumentData): SoterEventType[] {
  const text = [data.visitorType, data.interactionType, data.interactionSubtype, data.interactionTitle, data.visitorMessage,
    data.notificationSummary, data.notificationDescription, data.triggerSource, data.startedBy, data.policyReason, data.doorOpenedHandledReason]
    .filter((value) => typeof value === "string").join(" ").toLowerCase().replace(/[_-]+/g, " ");
  const types: SoterEventType[] = ["interaction"];
  const doorSensor = /door sensor/.test(text);
  const identityNames = [data.visitorFirstName, data.visitorName, data.recognizedPersonName].filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase());
  const namedOccupant = identityNames.includes("judy") || /\b(self identified as|i am|i'm|my name is) ['"]?judy\b/.test(text);
  const structuredResident = data.recognizedPersonIsResident === true || (Array.isArray(data.recognizedResidentIds) && data.recognizedResidentIds.length > 0);
  const returning = /\b(arriv|returned? home|came home|coming home|entry)\b/.test(text);
  const leaving = /\b(depart|leav|left|exit|heading out|going (?:out|shopping|for (?:a )?walk)|went shopping)\b/.test(text);
  if (structuredResident || namedOccupant) types.push("resident_recognized");
  if (leaving) types.push("departure");
  else if (returning || ((structuredResident || namedOccupant) && !doorSensor)) types.push("arrival");
  if (!doorSensor && !returning && !leaving && !structuredResident && !namedOccupant) types.push("visitor_arrival");
  return types;
}
