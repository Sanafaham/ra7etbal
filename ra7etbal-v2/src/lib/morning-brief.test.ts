import { describe, expect, it } from "vitest";
import { taskLabel } from "./morning-brief";

describe("taskLabel", () => {
  // Production incident (2026-08-18): a task with "kitchen" in the description
  // ("Clean the kitchen.") was spoken as "Christopher confirmed food task" —
  // the bare word "kitchen" alone incorrectly matched the food/groceries
  // category. The task was a cleaning chore, not food-related at all.
  it("does not label a plain kitchen-cleaning task as a food task", () => {
    expect(taskLabel("Clean the kitchen.")).not.toBe("food task");
  });

  it("falls back to a lowercased, punctuation-stripped phrase for a kitchen-cleaning task", () => {
    expect(taskLabel("Clean the kitchen.")).toBe("clean the kitchen");
  });

  // Existing food/grocery categorization must be unaffected.
  it("still labels groceries as a food task", () => {
    expect(taskLabel("Buy groceries for the week")).toBe("food task");
  });

  it("still labels grocery (singular) as a food task", () => {
    expect(taskLabel("Pick up a grocery item")).toBe("food task");
  });

  it("still labels a bare food mention as a food task", () => {
    expect(taskLabel("Order food for the party")).toBe("food task");
  });

  it("still labels cat food as a cat food task", () => {
    expect(taskLabel("Buy cat food")).toBe("cat food task");
  });

  it("still labels flowers as a flowers request", () => {
    expect(taskLabel("Order flowers for the office")).toBe("flowers request");
  });

  it("still labels a car/pickup task as a car task", () => {
    expect(taskLabel("Pick up the dry cleaning")).toBe("car task");
  });

  it("still labels a delivery task as a delivery task", () => {
    expect(taskLabel("Wait for the courier")).toBe("delivery task");
  });

  it("still labels a bill/utility task as a bill task", () => {
    expect(taskLabel("Pay the electric bill")).toBe("bill task");
  });
});
