import assert from "node:assert/strict";
import test from "node:test";
import { conversationHistoryCard, conversationTypes } from "./soter";

test("Judy self-identification is treated as the occupant returning", () => {
  const types = conversationTypes({ interactionType: "unknown_visitor", visitorName: "Judy", notificationDescription: "Judy identified herself", triggerSource: "face_detection" });
  assert.ok(types.includes("resident_recognized"));
  assert.ok(types.includes("arrival"));
  assert.ok(!types.includes("visitor_arrival"));
});

test("a visitor asking to see Judy remains a visitor", () => {
  const types = conversationTypes({ interactionType: "unknown_visitor", interactionTitle: "Visitor asked to see Judy", visitorMessage: "I've come to see Judy", triggerSource: "face_detection" });
  assert.ok(types.includes("visitor_arrival"));
  assert.ok(!types.includes("resident_recognized"));
  assert.ok(!types.includes("arrival"));
});

test("Judy saying she is going shopping is an occupant departure only", () => {
  const types = conversationTypes({ interactionType: "unknown_visitor", visitorName: "Judy", notificationDescription: "Judy said she was going shopping", triggerSource: "face_detection" });
  assert.ok(types.includes("departure"));
  assert.ok(!types.includes("arrival"));
  assert.ok(!types.includes("visitor_arrival"));
});

test("unknown face interactions are visitor arrivals", () => {
  const types = conversationTypes({ interactionType: "unknown_visitor", triggerSource: "face_detection" });
  assert.ok(types.includes("visitor_arrival"));
});

test("household exit door records are occupant departures", () => {
  const types = conversationTypes({ visitorType: "household_exit_or_unknown", interactionType: "door_sensor", triggerSource: "door_sensor_opened" });
  assert.ok(types.includes("departure"));
  assert.ok(!types.includes("visitor_arrival"));
});

test("occupant history presentation preserves the card fields without copying transcripts", () => {
  const card = conversationHistoryCard({
    interactionTypeLabel: "Unknown visitor",
    interactionTitle: "Allowed entry: Judy",
    notificationDescription: "Judy arrived, identified herself, and was welcomed back at the door.",
    preferredSceneImageUrl: "https://example.test/judy.jpg",
    status: "ended",
    assistantOutcome: "handled",
    transcript: [{ sender: "visitor", text: "private speech" }],
  });
  assert.deepEqual(card, {
    typeLabel: "Unknown visitor",
    title: "Allowed entry: Judy",
    description: "Judy arrived, identified herself, and was welcomed back at the door.",
    imageUrl: "https://example.test/judy.jpg",
    status: "ended",
    outcome: "handled",
  });
  assert.ok(!("transcript" in card));
});
